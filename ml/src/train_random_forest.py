"""MessMind Phase 5 — Random Forest training, tuning and validation.

Run from the ml/ folder:
    .\\venv\\Scripts\\python.exe -m src.train_random_forest

Rules
-----
* Fits ONLY on data/processed/train.csv.
* Uses data/processed/val.csv ONLY to choose hyperparameters and to report validation metrics.
* Never loads data/processed/test.csv (reserved for the final evaluation).
* All data is SYNTHETIC; metrics describe how well the simulator's rules are learned.
"""

from __future__ import annotations

import itertools
import json
import time

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.ensemble import RandomForestRegressor
from sklearn.inspection import permutation_importance

from src.evaluation import (FIG_DIR, MODELS_DIR, PREPROCESSOR_PATH, PROCESSED_DIR, SCHEMA_PATH,
                            baseline_predict, check_inputs, file_md5, load_schema, load_split,
                            metrics_by_group, plot_actual_vs_pred, plot_importance, plot_residuals,
                            prediction_validity, regression_metrics)

RANDOM_STATE = 42
MODEL_PATH = MODELS_DIR / "random_forest.joblib"
METADATA_PATH = MODELS_DIR / "random_forest_metadata.json"
TUNING_PATH = MODELS_DIR / "random_forest_tuning.csv"
MODEL_VERSION = "rf-v1-synthetic"

# Small, reasonable grid (2*2*2*2*3 = 48 combinations). Kept small on purpose: the validation set
# has only 182 rows / 13 days, and trying hundreds of settings would overfit the validation set.
PARAM_GRID = {
    "n_estimators": [200, 500],
    "max_depth": [None, 12],
    "min_samples_split": [2, 10],
    "min_samples_leaf": [1, 3],
    "max_features": [1.0, 0.5, "sqrt"],
}
OPTIONAL_BACKEND_FEATURES = ["previous_meal_attendance", "previous_leftover_kg", "historical_dish_rating"]


def tune(X_tr, y_tr, X_va, y_va) -> pd.DataFrame:
    """Fit every grid combination on TRAIN, score it on VALIDATION. Returns a results table."""
    rows = []
    keys = list(PARAM_GRID)
    for values in itertools.product(*PARAM_GRID.values()):
        params = dict(zip(keys, values))
        model = RandomForestRegressor(random_state=RANDOM_STATE, n_jobs=-1, **params).fit(X_tr, y_tr)
        val = regression_metrics(y_va, model.predict(X_va))
        trn = regression_metrics(y_tr, model.predict(X_tr))
        rows.append({**params, "val_mae": val["mae"], "val_rmse": val["rmse"], "val_r2": val["r2"],
                     "train_mae": trn["mae"]})
    res = pd.DataFrame(rows)
    # Primary criterion: validation MAE. Ties -> simpler/faster model (fewer trees, shallower).
    res["_depth"] = res["max_depth"].fillna(10_000)
    res = res.sort_values(["val_mae", "n_estimators", "_depth"]).drop(columns="_depth").reset_index(drop=True)
    return res


def clean_params(row: pd.Series) -> dict:
    p = {k: row[k] for k in PARAM_GRID}
    p["n_estimators"] = int(p["n_estimators"])
    p["min_samples_split"] = int(p["min_samples_split"])
    p["min_samples_leaf"] = int(p["min_samples_leaf"])
    p["max_depth"] = None if pd.isna(p["max_depth"]) else int(p["max_depth"])
    mf = p["max_features"]
    p["max_features"] = mf if isinstance(mf, str) else float(mf)
    return p


def main() -> None:
    t0 = time.time()
    hashes_before = {p.name: file_md5(p) for p in PROCESSED_DIR.glob("*.csv")}

    schema = load_schema()
    preprocessor = joblib.load(PREPROCESSOR_PATH)
    X_tr, y_tr, m_tr = load_split("train", schema)
    X_va, y_va, m_va = load_split("val", schema)

    # ---------------- input checks ----------------
    checks = check_inputs(schema, {"train": (X_tr, y_tr, m_tr), "val": (X_va, y_va, m_va)}, preprocessor)
    print("INPUT CHECKS")
    for name, ok, detail in checks:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))
    if not all(ok for _, ok, _ in checks):
        raise SystemExit("Input checks failed - not training.")

    # ---------------- baseline ----------------
    base_va = baseline_predict(X_va, m_va)
    base_tr = baseline_predict(X_tr, m_tr)

    # ---------------- tuning ----------------
    n_combos = int(np.prod([len(v) for v in PARAM_GRID.values()]))
    print(f"\nTUNING {n_combos} combinations (fit on train, score on validation) ...")
    results = tune(X_tr, y_tr, X_va, y_va)
    best = clean_params(results.iloc[0])
    print("Top 5 by validation MAE:")
    print(results.head(5).round(2).to_string(index=False))

    # ---------------- final model (train only) ----------------
    model = RandomForestRegressor(random_state=RANDOM_STATE, n_jobs=-1, **best).fit(X_tr, y_tr)
    pred_va = model.predict(X_va)
    pred_tr = model.predict(X_tr)

    # total_students is not a model feature, but it can be recovered exactly per row:
    # response_rate = total_responses / total_students  ->  total_students = total_responses / response_rate
    total_students_va = (X_va["total_responses"] / X_va["response_rate"]).round().to_numpy()
    validity = prediction_validity(pred_va, upper=total_students_va)

    metrics = {
        "validation": {"baseline": regression_metrics(y_va, base_va),
                       "random_forest": regression_metrics(y_va, pred_va)},
        "train": {"baseline": regression_metrics(y_tr, base_tr),
                  "random_forest": regression_metrics(y_tr, pred_tr)},
    }
    preds = {"Baseline (historical demand)": base_va, "Random Forest": pred_va}
    by_meal = metrics_by_group(y_va, preds, m_va["meta__meal_type"])
    exam = m_va["meta__is_exam_day"].map({True: "exam day", False: "non-exam day"})
    by_exam = metrics_by_group(y_va, preds, exam)

    # ---------------- optional backend inputs missing (API scenario) ----------------
    # If the backend cannot send these, the preprocessor fills TRAIN medians. Simulate that here.
    X_va_missing = X_va.copy()
    train_medians = X_tr[OPTIONAL_BACKEND_FEATURES].median()
    for col in OPTIONAL_BACKEND_FEATURES:
        X_va_missing[col] = train_medians[col]
    missing_scenario = regression_metrics(y_va, model.predict(X_va_missing))

    # ---------------- importance ----------------
    impurity = pd.DataFrame({"mean": model.feature_importances_}, index=X_tr.columns)
    perm = permutation_importance(model, X_va, y_va, n_repeats=10, random_state=RANDOM_STATE,
                                  scoring="neg_mean_absolute_error", n_jobs=-1)
    permutation = pd.DataFrame({"mean": perm.importances_mean, "std": perm.importances_std},
                               index=X_va.columns)

    # ---------------- figures ----------------
    FIG_DIR.mkdir(parents=True, exist_ok=True)
    plot_actual_vs_pred(y_va, preds, m_va["meta__meal_type"], FIG_DIR / "rf_actual_vs_predicted.png",
                        "Validation set (2026-09-02 → 09-14, SYNTHETIC)")
    plot_residuals(y_va, pred_va, m_va["meta__meal_type"], FIG_DIR / "rf_residuals.png",
                   "Random Forest residuals — validation set")
    plot_importance(permutation, FIG_DIR / "rf_permutation_importance.png",
                    "Permutation importance on validation\n(increase in MAE when the feature is shuffled)")
    plot_importance(impurity, FIG_DIR / "rf_impurity_importance.png",
                    "Impurity importance (from training)")

    # ---------------- save ----------------
    joblib.dump(model, MODEL_PATH)
    results.to_csv(TUNING_PATH, index=False)
    metadata = {
        "model_version": MODEL_VERSION,
        "model_type": "random_forest",
        "trained_on": "synthetic",
        "target": schema["target"],
        "feature_names": schema["feature_names"],
        "n_features": schema["n_features"],
        "hyperparameters": best,
        "random_state": RANDOM_STATE,
        "tuning": {"grid": {k: [v if v is not None else None for v in vals] for k, vals in PARAM_GRID.items()},
                   "n_combinations": n_combos, "selection_metric": "validation MAE",
                   "fit_on": "train", "results_file": TUNING_PATH.name},
        "split": {k: v for k, v in schema["split"].items() if k in ("train", "val")},
        "test_set_used": False,
        "metrics": metrics,
        "metrics_by_meal_type_validation": by_meal.to_dict(orient="records"),
        "metrics_by_exam_day_validation": by_exam.to_dict(orient="records"),
        "validation_optional_inputs_missing": {"features_set_to_train_median": OPTIONAL_BACKEND_FEATURES,
                                               "random_forest": missing_scenario},
        "prediction_validity_validation": validity,
        "inference_postprocessing": "round to nearest integer and clip to [0, total_students] "
                                    "(applied in the API only; metrics above use raw predictions)",
        "top_permutation_importance": permutation["mean"].sort_values(ascending=False).head(10).round(3).to_dict(),
        "artifacts": {"model": MODEL_PATH.name, "preprocessor": PREPROCESSOR_PATH.name,
                      "preprocessor_md5": file_md5(PREPROCESSOR_PATH),
                      "feature_schema": SCHEMA_PATH.name, "feature_schema_md5": file_md5(SCHEMA_PATH),
                      "raw_data_md5": schema["raw_data_md5"]},
        "versions": {"scikit-learn": sklearn.__version__, "pandas": pd.__version__, "numpy": np.__version__},
    }
    METADATA_PATH.write_text(json.dumps(metadata, indent=2, default=str), encoding="utf-8")

    hashes_after = {p.name: file_md5(p) for p in PROCESSED_DIR.glob("*.csv")}
    assert hashes_before == hashes_after, "processed splits were modified!"

    # ---------------- report to console ----------------
    print(f"\nSELECTED HYPERPARAMETERS: {best}")
    print("\nVALIDATION METRICS (182 rows)")
    for name, m in metrics["validation"].items():
        print(f"  {name:<14} MAE {m['mae']:7.2f}  RMSE {m['rmse']:7.2f}  R2 {m['r2']:.4f}  bias {m['bias']:+.2f}")
    print("TRAIN METRICS (overfitting check)")
    for name, m in metrics["train"].items():
        print(f"  {name:<14} MAE {m['mae']:7.2f}  RMSE {m['rmse']:7.2f}  R2 {m['r2']:.4f}")
    print("\nBY MEAL TYPE (validation)")
    print(by_meal.round(2).to_string(index=False))
    print("\nBY EXAM DAY (validation)")
    print(by_exam.round(2).to_string(index=False))
    print(f"\nOPTIONAL BACKEND INPUTS MISSING -> RF MAE {missing_scenario['mae']:.2f}  "
          f"RMSE {missing_scenario['rmse']:.2f}  R2 {missing_scenario['r2']:.4f}")
    print(f"\nPREDICTION VALIDITY (validation): {validity}")
    print("\nTOP 10 PERMUTATION IMPORTANCE (validation, MAE increase):")
    print(permutation.sort_values("mean", ascending=False).head(10).round(2).to_string())
    print("\nTOP 10 IMPURITY IMPORTANCE (train):")
    print(impurity.sort_values("mean", ascending=False).head(10).round(4).to_string())
    print(f"\nprocessed splits unchanged: True | test set loaded: False | runtime {time.time() - t0:.0f}s")
    print(f"Saved model: {MODEL_PATH}")


if __name__ == "__main__":
    # Run through the package import so the saved model never references `__main__` (see Phase 4).
    from src.train_random_forest import main as package_main
    package_main()
