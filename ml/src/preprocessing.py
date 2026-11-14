"""MessMind Phase 4 — preprocessing & feature engineering.

Turns the (SYNTHETIC) raw dataset into leakage-free, model-ready train / validation / test sets.

Run from the ml/ folder:
    .\\venv\\Scripts\\python.exe -m src.preprocessing

What it does
------------
1. Loads data/raw/messmind_training_data.csv (read-only; checked unchanged at the end).
2. Splits CHRONOLOGICALLY by date: first 70% of days = train, next 15% = validation, last 15% = test.
   Whole days stay together, so one meal's dishes never end up in two different splits.
3. Builds a preprocessing pipeline and FITS IT ON THE TRAINING SPLIT ONLY:
     engineer   -> stateless features computed from pre-meal information (ratios, menu size, flags)
     history    -> fills missing history with TRAIN medians per (dish_category, meal_type)
     numeric    -> fills any other missing number with the TRAIN median
     categorical-> one-hot encodes meal_type / dish_category / dish_name (unseen values -> all zeros)
4. Applies the fitted pipeline to all three splits, runs validation checks, and saves:
     data/processed/{train,val,test}.csv   model-ready features + target (+ meta__ columns for reporting)
     models/preprocessor.joblib            fitted pipeline (reused by training and by the API)
     models/feature_schema.json            input columns, output feature order, target, split info

Prediction-time assumption
--------------------------
A prediction is made at a fixed CUT-OFF before the meal (e.g. when app voting closes). At that moment
`interested_taps` and `total_responses` are final counts for that meal, and the menu is known.
Training rows must use the counts frozen at the same cut-off; if the backend lets students keep tapping
after the cut-off, those later taps must not be used.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.base import BaseEstimator, TransformerMixin
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import FunctionTransformer, OneHotEncoder

ML_ROOT = Path(__file__).resolve().parents[1]
RAW_PATH = ML_ROOT / "data" / "raw" / "messmind_training_data.csv"
PROCESSED_DIR = ML_ROOT / "data" / "processed"
MODELS_DIR = ML_ROOT / "models"
PREPROCESSOR_PATH = MODELS_DIR / "preprocessor.joblib"
SCHEMA_PATH = MODELS_DIR / "feature_schema.json"

SCHEMA_VERSION = "0.1"
TARGET = "actual_dish_consumers"
MEAL_ORDER = {"breakfast": 0, "lunch": 1, "dinner": 2}
TRAIN_FRAC, VAL_FRAC = 0.70, 0.15

# ---------------------------------------------------------------------------
# Column decisions (reasons are documented in docs/preprocessing_report.md)
# ---------------------------------------------------------------------------
CATEGORICAL = ["meal_type", "dish_category", "dish_name"]
BOOLEAN = ["is_weekend", "is_holiday", "is_exam_day", "is_festival", "is_new_dish"]
HISTORY = ["historical_dish_demand", "historical_dish_rating", "previous_leftover_kg"]
NUMERIC = ["day_of_week", "temperature", "rainfall", "previous_meal_attendance",
           "interested_taps", "total_responses",
           # engineered (stateless, pre-meal)
           "tap_share", "response_rate", "projected_interest", "num_dishes_in_meal"]

# Columns the raw input must contain (training CSV or API request after flattening).
INPUT_COLUMNS = ["date", "meal_type", "dish_name", "dish_category", "day_of_week",
                 "is_weekend", "is_holiday", "is_exam_day", "is_festival", "temperature", "rainfall",
                 "total_students", "previous_meal_attendance", "historical_dish_demand",
                 "historical_dish_rating", "interested_taps", "total_responses", "previous_leftover_kg"]

EXCLUDED = {
    TARGET: "the TARGET (known only after the meal) - kept separately as y",
    "data_source": "metadata, always 'synthetic'",
    "date": "identifier / split key; raw dates do not generalise to future days "
            "(useful parts are already columns: day_of_week, calendar flags)",
    "total_students": "constant (1000) in this data, so no information as a raw column; "
                      "used only inside response_rate and projected_interest",
    "month (not derived)": "train covers Jul-Aug (+1 Sep day) while test is entirely September: "
                           "the model would have to extrapolate an unseen month value",
    "dish_times_served_before (not derived)": "cannot be computed correctly - servings before the CSV "
                                              "window (generator warm-up) are not in the data",
}
POST_MEAL_WORDS = ("consumer", "leftover", "rating", "attendance")


# ---------------------------------------------------------------------------
# 1. Stateless feature engineering (no fitting -> identical in training and in the API)
# ---------------------------------------------------------------------------
def add_engineered_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add features computed only from information available before the meal.

    Nothing here is learned from data, so it cannot leak between splits.
    """
    out = df.copy()
    responses = out["total_responses"].replace(0, np.nan)
    students = out["total_students"].replace(0, np.nan)

    # Share of app responders who tapped this dish (0..1). NaN if nobody responded -> imputed later.
    out["tap_share"] = out["interested_taps"] / responses
    # Share of all students who responded in the app for this meal.
    out["response_rate"] = out["total_responses"] / students
    # Taps scaled up as if every student had responded (EDA: actual ~2.6x taps because ~40% respond).
    out["projected_interest"] = out["interested_taps"] * students / responses
    # Menu size: more choice -> each dish gets a smaller share. The full menu is known before the meal.
    out["num_dishes_in_meal"] = out.groupby(["date", "meal_type"])["dish_name"].transform("size")
    # The dish has never been served before (no history). Kept as an explicit signal.
    out["is_new_dish"] = out["historical_dish_demand"].isna()

    for col in BOOLEAN:
        out[col] = out[col].astype(int)
    return out


# ---------------------------------------------------------------------------
# 2. History imputer — fitted on TRAIN only
# ---------------------------------------------------------------------------
class GroupMedianImputer(BaseEstimator, TransformerMixin):
    """Fill missing history with medians learned from the TRAINING rows.

    For each missing value it uses the most specific group that was seen in training:
        (dish_category, meal_type)  ->  (meal_type)  ->  overall median.
    Example: a new main_veg dish at dinner gets the typical history of main_veg dishes at dinner.
    This is an imputation, not real history; `is_new_dish` tells the model it was filled in.
    """

    def __init__(self, columns=None, group_levels=(("dish_category", "meal_type"), ("meal_type",))):
        self.columns = columns
        self.group_levels = group_levels

    def fit(self, X: pd.DataFrame, y=None):
        self.medians_ = []
        for level in self.group_levels:
            self.medians_.append(X.groupby(list(level))[self.columns].median())
        self.global_median_ = X[self.columns].median()
        self.n_features_in_ = X.shape[1]
        self.feature_names_in_ = np.asarray(X.columns, dtype=object)
        return self

    def transform(self, X: pd.DataFrame) -> pd.DataFrame:
        X = X.copy()
        for col in self.columns:
            for level, table in zip(self.group_levels, self.medians_):
                missing = X[col].isna()
                if not missing.any():
                    break
                keys = X.loc[missing, list(level)]
                idx = pd.MultiIndex.from_frame(keys) if len(level) > 1 else pd.Index(keys.iloc[:, 0])
                X.loc[missing, col] = table[col].reindex(idx).to_numpy()
            X[col] = X[col].fillna(self.global_median_[col])
        return X[self.columns]

    def get_feature_names_out(self, input_features=None):
        return np.asarray(self.columns, dtype=object)


# ---------------------------------------------------------------------------
# 3. Pipeline
# ---------------------------------------------------------------------------
def build_preprocessor() -> Pipeline:
    columns = ColumnTransformer(
        transformers=[
            # history needs dish_category & meal_type to look up the right group median
            ("history", GroupMedianImputer(columns=HISTORY), HISTORY + ["dish_category", "meal_type"]),
            ("numeric", SimpleImputer(strategy="median"), NUMERIC),
            ("boolean", SimpleImputer(strategy="most_frequent"), BOOLEAN),
            ("categorical", Pipeline([
                ("fill", SimpleImputer(strategy="constant", fill_value="unknown")),
                ("onehot", OneHotEncoder(handle_unknown="ignore", sparse_output=False)),
            ]), CATEGORICAL),
        ],
        remainder="drop",                 # anything not listed (target, ids, metadata) never reaches the model
        verbose_feature_names_out=False,
    )
    pipe = Pipeline([
        ("engineer", FunctionTransformer(add_engineered_features)),
        ("columns", columns),
    ])
    return pipe.set_output(transform="pandas")


# ---------------------------------------------------------------------------
# 4. Loading & chronological split
# ---------------------------------------------------------------------------
def file_md5(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


def load_raw(path: Path = RAW_PATH) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    df["_meal_order"] = df["meal_type"].map(MEAL_ORDER)
    df = df.sort_values(["date", "_meal_order", "dish_name"], kind="mergesort").reset_index(drop=True)
    return df.drop(columns="_meal_order")


def chronological_split(df: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """Split by whole DAYS in time order (no shuffling)."""
    days = np.sort(df["date"].unique())
    n = len(days)
    n_train = round(TRAIN_FRAC * n)
    n_val = round((TRAIN_FRAC + VAL_FRAC) * n) - n_train
    train_days, val_days = days[:n_train], days[n_train:n_train + n_val]
    test_days = days[n_train + n_val:]
    return {
        "train": df[df["date"].isin(train_days)].copy(),
        "val": df[df["date"].isin(val_days)].copy(),
        "test": df[df["date"].isin(test_days)].copy(),
    }


# ---------------------------------------------------------------------------
# 5. Validation checks
# ---------------------------------------------------------------------------
def recompute_history_check(df: pd.DataFrame) -> tuple[int, int]:
    """Re-derive historical_dish_demand from past rows only; return (rows_checked, rows_matching)."""
    g = df.groupby(["dish_name", "meal_type"], sort=False)
    n_prior = g.cumcount()
    recalc = g[TARGET].transform(lambda s: s.shift(1).rolling(5).mean()).round(1)
    mask = n_prior >= 5
    match = ((recalc[mask] - df.loc[mask, "historical_dish_demand"]).abs() < 0.051).sum()
    return int(mask.sum()), int(match)


def run_checks(raw: pd.DataFrame, splits: dict, X: dict, y: dict, pre: Pipeline,
               feature_names: list[str]) -> list[tuple[str, bool, str]]:
    results = []

    def check(name, ok, detail=""):
        results.append((name, bool(ok), detail))

    # --- leakage ---
    check("target not in features", TARGET not in feature_names)
    bad = [f for f in feature_names if any(w in f for w in POST_MEAL_WORDS)
           and not f.startswith(("previous_", "historical_"))]
    check("no current-meal post-meal columns in features", not bad, str(bad))
    check("excluded columns absent from features",
          not {"date", "data_source", "total_students"} & set(feature_names))

    hist_checked, hist_match = recompute_history_check(raw)
    check("historical_dish_demand is past-only (recomputed)", hist_checked == hist_match,
          f"{hist_match}/{hist_checked} rows match")

    # fitted on train only: learned values must equal values computed from train rows
    eng_train = add_engineered_features(splits["train"])
    hist_imp = pre.named_steps["columns"].named_transformers_["history"]
    expected = eng_train.groupby(["dish_category", "meal_type"])[HISTORY].median()
    check("history imputer medians come from train only",
          np.allclose(hist_imp.medians_[0].sort_index().to_numpy(),
                      expected.sort_index().to_numpy(), equal_nan=True))
    num_imp = pre.named_steps["columns"].named_transformers_["numeric"]
    check("numeric imputer medians come from train only",
          np.allclose(num_imp.statistics_, eng_train[NUMERIC].median().to_numpy()))
    enc = pre.named_steps["columns"].named_transformers_["categorical"].named_steps["onehot"]
    check("encoder categories come from train only",
          all(set(cats) == set(splits["train"][c].unique()) for c, cats in zip(CATEGORICAL, enc.categories_)))

    # --- target validity ---
    for s in X:
        tot = splits[s]["total_students"]
        check(f"[{s}] target within [0, total_students]", y[s].between(0, tot).all())

    # --- missing values & columns ---
    for s in X:
        check(f"[{s}] no missing values after transform", not X[s].isna().any().any(),
              f"{int(X[s].isna().sum().sum())} NaN")
        check(f"[{s}] feature columns identical & same order", list(X[s].columns) == feature_names)

    # --- chronology & completeness ---
    tr, va, te = splits["train"], splits["val"], splits["test"]
    check("chronological: train < val < test (no shared dates)",
          tr["date"].max() < va["date"].min() and va["date"].max() < te["date"].min())
    check("no rows dropped or duplicated by the split", len(tr) + len(va) + len(te) == len(raw))
    check("each split sorted by time",
          all(s["date"].is_monotonic_increasing for s in (tr, va, te)))

    # --- robustness for the API: unseen categories / missing optional inputs ---
    probe = splits["test"].head(4).copy()
    probe["dish_name"] = "Mystery Dish"
    probe["previous_meal_attendance"] = np.nan
    probe[HISTORY] = np.nan
    out = pre.transform(probe)
    dish_cols = [f for f in feature_names if f.startswith("dish_name_")]
    check("unseen dish + missing optional inputs transform safely",
          not out.isna().any().any() and (out[dish_cols] == 0).all().all())
    return results


# ---------------------------------------------------------------------------
# 6. Main
# ---------------------------------------------------------------------------
META_COLUMNS = ["date", "meal_type", "dish_name", "dish_category", "is_exam_day",
                "interested_taps", "historical_dish_demand"]


def main() -> None:
    raw_md5_before = file_md5(RAW_PATH)
    raw = load_raw()
    splits = chronological_split(raw)

    pre = build_preprocessor()
    pre.fit(splits["train"])                       # <-- the ONLY fit: training rows only
    feature_names = list(pre.named_steps["columns"].get_feature_names_out())

    X = {s: pre.transform(d) for s, d in splits.items()}
    y = {s: d[TARGET].astype(int) for s, d in splits.items()}

    results = run_checks(raw, splits, X, y, pre, feature_names)
    raw_unchanged = file_md5(RAW_PATH) == raw_md5_before
    results.append(("raw CSV unchanged", raw_unchanged, raw_md5_before))
    hist_imp = pre.named_steps["columns"].named_transformers_["history"]
    engineer_fn = pre.named_steps["engineer"].func
    pickle_modules = {type(hist_imp).__module__, engineer_fn.__module__}
    results.append(("saved objects importable by other programs (not __main__)",
                    pickle_modules == {"src.preprocessing"}, str(sorted(pickle_modules))))

    print("VALIDATION CHECKS")
    for name, ok, detail in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))
    if not all(ok for _, ok, _ in results):
        raise SystemExit("Preprocessing FAILED validation - nothing was saved.")

    # --- save ---
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    split_info = {}
    for s, d in splits.items():
        meta = d[META_COLUMNS].add_prefix("meta__").reset_index(drop=True)
        meta["meta__date"] = meta["meta__date"].dt.strftime("%Y-%m-%d")
        out = pd.concat([meta, X[s].reset_index(drop=True), y[s].reset_index(drop=True)], axis=1)
        out.to_csv(PROCESSED_DIR / f"{s}.csv", index=False)
        split_info[s] = {"rows": len(d), "days": int(d["date"].nunique()),
                         "start": d["date"].min().strftime("%Y-%m-%d"),
                         "end": d["date"].max().strftime("%Y-%m-%d"),
                         "exam_days": int(d.groupby("date")["is_exam_day"].first().sum()),
                         "new_dish_rows": int(d["historical_dish_demand"].isna().sum())}

    joblib.dump(pre, PREPROCESSOR_PATH)
    schema = {
        "schema_version": SCHEMA_VERSION,
        "data_source": "synthetic",
        "raw_data_md5": raw_md5_before,
        "target": TARGET,
        "input_columns": INPUT_COLUMNS,
        "feature_names": feature_names,
        "n_features": len(feature_names),
        "feature_groups": {"history": HISTORY, "numeric": NUMERIC, "boolean": BOOLEAN,
                           "categorical": CATEGORICAL},
        "excluded": EXCLUDED,
        "meta_columns": ["meta__" + c for c in META_COLUMNS],
        "split": split_info,
        "versions": {"scikit-learn": sklearn.__version__, "pandas": pd.__version__},
    }
    SCHEMA_PATH.write_text(json.dumps(schema, indent=2), encoding="utf-8")

    print("\nSPLITS")
    for s, info in split_info.items():
        print(f"  {s:<5} {info['rows']:>4} rows  {info['days']:>2} days  {info['start']} -> {info['end']}"
              f"  exam_days={info['exam_days']}  new_dish_rows={info['new_dish_rows']}")
    print(f"\nFeatures: {len(feature_names)}  Target: {TARGET}")
    print(f"Saved: {PROCESSED_DIR.relative_to(ML_ROOT)}/{{train,val,test}}.csv, "
          f"{PREPROCESSOR_PATH.relative_to(ML_ROOT)}, {SCHEMA_PATH.relative_to(ML_ROOT)}")


if __name__ == "__main__":
    # When run as `python -m src.preprocessing`, this file is the module `__main__`, and joblib would
    # save GroupMedianImputer as `__main__.GroupMedianImputer`, which the API could not load later.
    # Re-importing through the package makes saved objects point to `src.preprocessing` instead.
    from src.preprocessing import main as package_main
    package_main()
