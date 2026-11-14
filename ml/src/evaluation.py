"""Shared evaluation helpers for MessMind models (used by Random Forest now, XGBoost later).

Keeping loading, the baseline, metrics and plots in one place guarantees every model is judged
with exactly the same rules on exactly the same rows.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # scripts save figures to files; no window needed
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

ML_ROOT = Path(__file__).resolve().parents[1]
PROCESSED_DIR = ML_ROOT / "data" / "processed"
MODELS_DIR = ML_ROOT / "models"
FIG_DIR = ML_ROOT / "reports" / "figures"
SCHEMA_PATH = MODELS_DIR / "feature_schema.json"
PREPROCESSOR_PATH = MODELS_DIR / "preprocessor.joblib"

MEAL_ORDER = ["breakfast", "lunch", "dinner"]
MEAL_COLORS = {"breakfast": "#2a78d6", "lunch": "#eb6834", "dinner": "#1baf7a"}
SINGLE = "#2a78d6"
INK_MUTED = "#6b6a66"
POST_MEAL_WORDS = ("consumer", "leftover", "rating", "attendance")
FORBIDDEN_FEATURES = {"date", "data_source", "total_students", "meal_id"}


def file_md5(path: Path) -> str:
    return hashlib.md5(Path(path).read_bytes()).hexdigest()


def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def load_split(name: str, schema: dict, allow_test: bool = False):
    """Return (X, y, meta) for one processed split. Only schema features go into X.

    The test split is refused unless `allow_test=True`, which only the final, frozen-model
    evaluation (src/evaluate_final.py) passes.
    """
    if name == "test" and not allow_test:
        raise ValueError("The test split is reserved for final evaluation and must not be loaded here.")
    df = pd.read_csv(PROCESSED_DIR / f"{name}.csv")
    X = df[schema["feature_names"]]                  # exact columns AND order from the schema
    y = df[schema["target"]].astype(float)
    meta = df[[c for c in df.columns if c.startswith("meta__")]].copy()
    meta["meta__date"] = pd.to_datetime(meta["meta__date"])
    return X, y, meta


def check_inputs(schema: dict, splits: dict, preprocessor) -> list[tuple[str, bool, str]]:
    """Sanity checks before any training. `splits` = {name: (X, y, meta)} in time order."""
    feats = schema["feature_names"]
    res = []
    res.append(("target is actual_dish_consumers", schema["target"] == "actual_dish_consumers", ""))
    res.append(("preprocessor features == schema features",
                list(preprocessor.named_steps["columns"].get_feature_names_out()) == feats, ""))
    for name, (X, _, _) in splits.items():
        res.append((f"[{name}] columns & order match schema", list(X.columns) == feats, ""))
        res.append((f"[{name}] no missing values in features", not X.isna().any().any(), ""))
    bad = [f for f in feats if f == schema["target"] or f in FORBIDDEN_FEATURES
           or (any(w in f for w in POST_MEAL_WORDS) and not f.startswith(("previous_", "historical_")))]
    res.append(("no target / identifier / post-meal feature", not bad, str(bad)))
    names = list(splits)
    for a, b in zip(names, names[1:]):
        ok = splits[a][2]["meta__date"].max() < splits[b][2]["meta__date"].min()
        res.append((f"chronological: {a} ends before {b} starts", ok,
                    f"{splits[a][2]['meta__date'].max().date()} < {splits[b][2]['meta__date'].min().date()}"))
    return res


def baseline_predict(X: pd.DataFrame, meta: pd.DataFrame) -> np.ndarray:
    """Historical-demand baseline: predict the dish's mean consumers over its last 5 PAST servings.

    Uses the raw `historical_dish_demand` (past-only, verified in Phases 3-4). If it is missing
    (new dish) it falls back to the train-fitted imputed value already in X, so the baseline
    never looks at current or future consumption.
    """
    raw = meta["meta__historical_dish_demand"]
    return raw.fillna(X["historical_dish_demand"]).to_numpy(dtype=float)


def regression_metrics(y_true, y_pred) -> dict:
    y_true, y_pred = np.asarray(y_true, float), np.asarray(y_pred, float)
    return {"n": int(len(y_true)),
            "mae": float(mean_absolute_error(y_true, y_pred)),
            "rmse": float(np.sqrt(mean_squared_error(y_true, y_pred))),
            "r2": float(r2_score(y_true, y_pred)) if len(y_true) > 1 else float("nan"),
            "bias": float(np.mean(y_pred - y_true))}


def metrics_by_group(y, preds: dict, groups: pd.Series, min_rows: int = 20) -> pd.DataFrame:
    rows = []
    for g in pd.unique(groups):
        mask = (groups == g).to_numpy()
        for model, p in preds.items():
            m = regression_metrics(np.asarray(y)[mask], p[mask])
            m.update(group=g, model=model, small_sample=m["n"] < min_rows)
            rows.append(m)
    return pd.DataFrame(rows)[["group", "model", "n", "mae", "rmse", "r2", "bias", "small_sample"]]


def paired_bootstrap_mae_diff(y, pred_a, pred_b, days: pd.Series, n_boot: int = 2000,
                              seed: int = 42) -> dict:
    """Is model A's MAE really different from model B's? (A minus B; negative = A better.)

    Resamples whole DAYS with replacement (rows from the same day are related, so resampling
    single rows would overstate certainty). Both models are scored on the same resampled rows.
    """
    y, pred_a, pred_b = (np.asarray(v, float) for v in (y, pred_a, pred_b))
    err_diff = np.abs(pred_a - y) - np.abs(pred_b - y)
    day_codes, uniq = pd.factorize(days)
    per_day_sum = np.bincount(day_codes, weights=err_diff)
    per_day_n = np.bincount(day_codes)
    rng = np.random.default_rng(seed)
    picks = rng.integers(0, len(uniq), size=(n_boot, len(uniq)))
    boot = per_day_sum[picks].sum(axis=1) / per_day_n[picks].sum(axis=1)
    lo, hi = np.percentile(boot, [2.5, 97.5])
    return {"mae_diff": float(err_diff.mean()), "ci95_low": float(lo), "ci95_high": float(hi),
            "share_boot_a_better": float((boot < 0).mean()), "n_days": int(len(uniq)),
            "meaningful": bool(hi < 0 or lo > 0)}


def prediction_validity(pred, upper: float) -> dict:
    pred = np.asarray(pred, float)
    return {"n_nan": int(np.isnan(pred).sum()), "n_inf": int(np.isinf(pred).sum()),
            "n_negative": int((pred < 0).sum()), "n_above_total_students": int((pred > upper).sum()),
            "min": float(np.nanmin(pred)), "max": float(np.nanmax(pred))}


# ---------------------------------------------------------------------------
# Plots (consistent style: meal colours fixed, y = x reference, recessive grid)
# ---------------------------------------------------------------------------
def _style():
    plt.rcParams.update({"axes.grid": True, "grid.color": "#e6e5e0", "axes.edgecolor": "#bdbcb6",
                         "axes.titleweight": "bold", "axes.spines.top": False, "axes.spines.right": False})


def plot_actual_vs_pred(y, preds: dict, meal: pd.Series, path: Path, suptitle: str):
    _style()
    fig, axes = plt.subplots(1, len(preds), figsize=(6.2 * len(preds), 5.4), squeeze=False)
    lim = max(np.max(y), *[np.max(p) for p in preds.values()]) * 1.05
    for ax, (name, p) in zip(axes[0], preds.items()):
        for m in MEAL_ORDER:
            k = (meal == m).to_numpy()
            ax.scatter(np.asarray(y)[k], p[k], s=16, alpha=0.7, color=MEAL_COLORS[m],
                       edgecolor="white", linewidth=0.3, label=m)
        ax.plot([0, lim], [0, lim], ls="--", color=INK_MUTED, lw=1.2, label="perfect prediction")
        mt = regression_metrics(y, p)
        ax.set(xlim=(0, lim), ylim=(0, lim), xlabel="Actual consumers", ylabel="Predicted consumers",
               title=f"{name}\nMAE {mt['mae']:.1f} · RMSE {mt['rmse']:.1f} · R² {mt['r2']:.3f}")
        ax.legend(frameon=False, loc="upper left")
    fig.suptitle(suptitle, fontweight="bold")
    fig.tight_layout()
    fig.savefig(path, dpi=120, bbox_inches="tight")
    plt.close(fig)


def plot_residuals(y, pred, meal: pd.Series, path: Path, title: str):
    _style()
    resid = np.asarray(pred) - np.asarray(y)
    fig, axes = plt.subplots(1, 2, figsize=(13, 4.6))
    axes[0].hist(resid, bins=30, color=SINGLE, edgecolor="white", linewidth=0.5)
    axes[0].axvline(0, color=INK_MUTED, ls="--")
    axes[0].set(title="Residual distribution (predicted − actual)", xlabel="Consumers", ylabel="Rows")
    for m in MEAL_ORDER:
        k = (meal == m).to_numpy()
        axes[1].scatter(np.asarray(pred)[k], resid[k], s=16, alpha=0.7, color=MEAL_COLORS[m],
                        edgecolor="white", linewidth=0.3, label=m)
    axes[1].axhline(0, color=INK_MUTED, ls="--")
    axes[1].set(title="Residuals vs predicted", xlabel="Predicted consumers", ylabel="Predicted − actual")
    axes[1].legend(frameon=False)
    fig.suptitle(title, fontweight="bold")
    fig.tight_layout()
    fig.savefig(path, dpi=120, bbox_inches="tight")
    plt.close(fig)


def plot_importance(imp: pd.DataFrame, path: Path, title: str, top: int = 15):
    """imp: DataFrame indexed by feature with columns 'mean' and optional 'std'."""
    _style()
    d = imp.sort_values("mean", ascending=False).head(top).iloc[::-1]
    fig, ax = plt.subplots(figsize=(8, 0.38 * len(d) + 1.5))
    ax.barh(d.index, d["mean"], xerr=d.get("std"), color=SINGLE, height=0.65,
            error_kw={"ecolor": INK_MUTED, "lw": 1})
    ax.set(title=title, xlabel="Importance")
    ax.grid(axis="y", visible=False)
    fig.tight_layout()
    fig.savefig(path, dpi=120, bbox_inches="tight")
    plt.close(fig)
