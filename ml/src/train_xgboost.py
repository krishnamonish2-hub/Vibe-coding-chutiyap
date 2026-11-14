"""MessMind Phase 6 — XGBoost training, tuning and comparison with Random Forest & baseline.

Run from the ml/ folder:
    .\\venv\\Scripts\\python.exe -m src.train_xgboost

Rules
-----
* Fits ONLY on data/processed/train.csv.
* data/processed/val.csv is used ONLY for early stopping, choosing hyperparameters and reporting.
* data/processed/test.csv is never loaded.
* Random Forest is NOT retrained: the saved Phase 5 model is loaded and scored on the same rows.
* All data is SYNTHETIC.
"""

from __future__ import annotations

import inspect
import json
import time

import joblib
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import sklearn
import xgboost
from sklearn.inspection import permutation_importance
from sklearn.model_selection import ParameterSampler
from xgboost import XGBRegressor

from src.evaluation import (FIG_DIR, INK_MUTED, MEAL_ORDER, MODELS_DIR, PREPROCESSOR_PATH,
                            PROCESSED_DIR, SCHEMA_PATH, baseline_predict, check_inputs, file_md5,
                            load_schema, load_split, metrics_by_group, paired_bootstrap_mae_diff,
                            plot_actual_vs_pred, plot_importance, plot_residuals, prediction_validity,
                            regression_metrics)

RANDOM_STATE = 42
MODEL_PATH = MODELS_DIR / "xgboost_model.json"          # XGBoost's own portable format
METADATA_PATH = MODELS_DIR / "xgboost_metadata.json"
TUNING_PATH = MODELS_DIR / "xgboost_tuning.csv"
COMPARISON_PATH = MODELS_DIR / "model_comparison_validation.csv"
RF_MODEL_PATH = MODELS_DIR / "random_forest.joblib"
RF_METADATA_PATH = MODELS_DIR / "random_forest_metadata.json"
MODEL_VERSION = "xgb-v1-synthetic"

MAX_TREES = 3000                 # upper limit; early stopping decides the real number
EARLY_STOPPING_ROUNDS = 100
N_SEARCH = 40                    # similar budget to Random Forest's 48 combinations (fair comparison)
SEARCH_SPACE = {
    "max_depth": [3, 4, 5, 6, 8],
    "learning_rate": [0.02, 0.05, 0.1],
    "subsample": [0.7, 0.85, 1.0],
    "colsample_bytree": [0.5, 0.75, 1.0],
    "min_child_weight": [1, 3, 5, 10],
    "reg_lambda": [0.5, 1.0, 5.0, 10.0],
}
FIXED = {"objective": "reg:squarederror", "tree_method": "hist", "random_state": RANDOM_STATE,
         "n_jobs": 4, "eval_metric": "mae"}
OPTIONAL_BACKEND_FEATURES = ["previous_meal_attendance", "previous_leftover_kg", "historical_dish_rating"]

# XGBoost >= 2 takes early_stopping_rounds in the constructor; older versions took it in fit().
ES_IN_FIT = "early_stopping_rounds" in inspect.signature(XGBRegressor.fit).parameters


def fit_with_early_stopping(params: dict, X_tr, y_tr, X_va, y_va) -> XGBRegressor:
    if ES_IN_FIT:  # legacy API (xgboost < 2)
        model = XGBRegressor(n_estimators=MAX_TREES, **FIXED, **params)
        model.fit(X_tr, y_tr, eval_set=[(X_va, y_va)], early_stopping_rounds=EARLY_STOPPING_ROUNDS,
                  verbose=False)
    else:
        model = XGBRegressor(n_estimators=MAX_TREES, early_stopping_rounds=EARLY_STOPPING_ROUNDS,
                             **FIXED, **params)
        model.fit(X_tr, y_tr, eval_set=[(X_va, y_va)], verbose=False)
    return model


def predict_best(model: XGBRegressor, X) -> np.ndarray:
    """Predict using only the trees up to the best early-stopping iteration."""
    return model.predict(X, iteration_range=(0, model.best_iteration + 1))


def tune(X_tr, y_tr, X_va, y_va) -> pd.DataFrame:
    rows = []
    for params in ParameterSampler(SEARCH_SPACE, n_iter=N_SEARCH, random_state=RANDOM_STATE):
        model = fit_with_early_stopping(params, X_tr, y_tr, X_va, y_va)
        val = regression_metrics(y_va, predict_best(model, X_va))
        rows.append({**params, "best_n_estimators": model.best_iteration + 1,
                     "val_mae": val["mae"], "val_rmse": val["rmse"], "val_r2": val["r2"],
                     "train_mae": regression_metrics(y_tr, predict_best(model, X_tr))["mae"]})
    return pd.DataFrame(rows).sort_values(["val_mae", "best_n_estimators"]).reset_index(drop=True)


def plot_model_comparison(table: pd.DataFrame, path):
    """Grouped bars: validation MAE per meal type for each model (lower is better)."""
    plt.rcParams.update({"axes.grid": True, "grid.color": "#e6e5e0", "axes.spines.top": False,
                         "axes.spines.right": False, "axes.titleweight": "bold"})
    colors = {"Baseline (historical demand)": "#a3a29c", "Random Forest": "#2a78d6", "XGBoost": "#eb6834"}
    groups = MEAL_ORDER + ["all"]
    fig, ax = plt.subplots(figsize=(9, 4.4))
    x, w = np.arange(len(groups)), 0.26
    for i, (model, c) in enumerate(colors.items()):
        vals = [table[(table.group == g) & (table.model == model)]["mae"].iloc[0] for g in groups]
        bars = ax.bar(x + (i - 1) * w, vals, width=w - 0.03, color=c, label=model)
        if model != "Baseline (historical demand)":
            ax.bar_label(bars, fmt="%.0f", fontsize=8, color="#3d3c39", padding=2)
    ax.set_xticks(x, [g.capitalize() for g in groups])
    ax.set(title="Validation MAE by meal type (lower is better)", ylabel="MAE (consumers)")
    ax.grid(axis="x", visible=False)
    ax.legend(frameon=False, bbox_to_anchor=(1, 1), loc="upper left")
    fig.tight_layout()
    fig.savefig(path, dpi=120, bbox_inches="tight")
    plt.close(fig)


def main() -> None:
    t0 = time.time()
    hashes_before = {p.name: file_md5(p) for p in PROCESSED_DIR.glob("*.csv")}
    rf_hash_before = file_md5(RF_MODEL_PATH)

    schema = load_schema()
    preprocessor = joblib.load(PREPROCESSOR_PATH)
    X_tr, y_tr, m_tr = load_split("train", schema)
    X_va, y_va, m_va = load_split("val", schema)

    # ---------------- input checks ----------------
    checks = check_inputs(schema, {"train": (X_tr, y_tr, m_tr), "val": (X_va, y_va, m_va)}, preprocessor)
    rf_meta = json.loads(RF_METADATA_PATH.read_text(encoding="utf-8"))
    split_now = {k: v for k, v in schema["split"].items() if k in ("train", "val")}
    checks.append(("split identical to the one Random Forest used", split_now == rf_meta["split"], ""))
    checks.append(("RF trained on the same feature order", rf_meta["feature_names"] == schema["feature_names"], ""))
    checks.append(("preprocessor unchanged since RF training",
                   file_md5(PREPROCESSOR_PATH) == rf_meta["artifacts"]["preprocessor_md5"], ""))
    print("INPUT CHECKS")
    for name, ok, detail in checks:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))
    if not all(ok for _, ok, _ in checks):
        raise SystemExit("Input checks failed - not training.")

    # ---------------- baseline & saved Random Forest (no retraining) ----------------
    base_va = baseline_predict(X_va, m_va)
    rf = joblib.load(RF_MODEL_PATH)
    rf_va = rf.predict(X_va)
    rf_val = regression_metrics(y_va, rf_va)
    rf_consistent = abs(rf_val["mae"] - rf_meta["metrics"]["validation"]["random_forest"]["mae"]) < 1e-6
    print(f"\nSaved RF re-scored: MAE {rf_val['mae']:.2f} (Phase 5 recorded "
          f"{rf_meta['metrics']['validation']['random_forest']['mae']:.2f}) -> consistent: {rf_consistent}")

    # ---------------- tuning ----------------
    print(f"\nTUNING {N_SEARCH} random combinations (xgboost {xgboost.__version__}, "
          f"early stopping {'in fit()' if ES_IN_FIT else 'in constructor'}, patience {EARLY_STOPPING_ROUNDS}) ...")
    results = tune(X_tr, y_tr, X_va, y_va)
    print("Top 5 by validation MAE:")
    print(results.head(5).round(3).to_string(index=False))
    top = results.iloc[0]
    best = {k: (int(top[k]) if k in ("max_depth", "min_child_weight") else float(top[k])) for k in SEARCH_SPACE}
    best["n_estimators"] = int(top["best_n_estimators"])

    # ---------------- final model: fixed number of trees, train only, no early stopping ----------------
    model = XGBRegressor(**FIXED, **best).fit(X_tr, y_tr, verbose=False)
    xgb_va = model.predict(X_va)
    xgb_tr = model.predict(X_tr)
    total_students_va = (X_va["total_responses"] / X_va["response_rate"]).round().to_numpy()
    validity = prediction_validity(xgb_va, upper=total_students_va)

    preds = {"Baseline (historical demand)": base_va, "Random Forest": rf_va, "XGBoost": xgb_va}
    overall = pd.DataFrame([{**regression_metrics(y_va, p), "model": k, "group": "all"} for k, p in preds.items()])
    by_meal = metrics_by_group(y_va, preds, m_va["meta__meal_type"])
    exam = m_va["meta__is_exam_day"].map({True: "exam day", False: "non-exam day"})
    by_exam = metrics_by_group(y_va, preds, exam)
    comparison = pd.concat([overall, by_meal, by_exam], ignore_index=True)[
        ["group", "model", "n", "mae", "rmse", "r2", "bias"]]

    days = m_va["meta__date"]
    boot = {
        "xgboost_minus_random_forest": paired_bootstrap_mae_diff(y_va, xgb_va, rf_va, days),
        "xgboost_minus_baseline": paired_bootstrap_mae_diff(y_va, xgb_va, base_va, days),
        "random_forest_minus_baseline": paired_bootstrap_mae_diff(y_va, rf_va, base_va, days),
    }

    # Optional backend inputs missing -> preprocessor would fill TRAIN medians
    X_va_missing = X_va.copy()
    for col in OPTIONAL_BACKEND_FEATURES:
        X_va_missing[col] = X_tr[col].median()
    missing_scenario = {"xgboost": regression_metrics(y_va, model.predict(X_va_missing)),
                        "random_forest": regression_metrics(y_va, rf.predict(X_va_missing))}

    # ---------------- importance ----------------
    gain = model.get_booster().get_score(importance_type="total_gain")
    gain = pd.Series(gain).reindex(X_tr.columns).fillna(0.0)
    gain_df = pd.DataFrame({"mean": gain / gain.sum()})
    perm = permutation_importance(model, X_va, y_va, n_repeats=10, random_state=RANDOM_STATE,
                                  scoring="neg_mean_absolute_error", n_jobs=1)
    permutation = pd.DataFrame({"mean": perm.importances_mean, "std": perm.importances_std}, index=X_va.columns)

    # ---------------- figures ----------------
    FIG_DIR.mkdir(parents=True, exist_ok=True)
    plot_actual_vs_pred(y_va, preds, m_va["meta__meal_type"], FIG_DIR / "xgb_actual_vs_predicted.png",
                        "Validation set (2026-09-02 → 09-14, SYNTHETIC) — same 182 rows for all models")
    plot_residuals(y_va, xgb_va, m_va["meta__meal_type"], FIG_DIR / "xgb_residuals.png",
                   "XGBoost residuals — validation set")
    plot_importance(permutation, FIG_DIR / "xgb_permutation_importance.png",
                    "XGBoost permutation importance on validation\n(increase in MAE when the feature is shuffled)")
    plot_importance(gain_df, FIG_DIR / "xgb_gain_importance.png", "XGBoost total-gain importance (share, training)")
    plot_model_comparison(comparison, FIG_DIR / "model_comparison_by_meal.png")

    # ---------------- save ----------------
    model.save_model(MODEL_PATH)
    reloaded = XGBRegressor()
    reloaded.load_model(MODEL_PATH)
    reload_ok = np.allclose(reloaded.predict(X_va), xgb_va)
    results.to_csv(TUNING_PATH, index=False)
    comparison.to_csv(COMPARISON_PATH, index=False)

    metadata = {
        "model_version": MODEL_VERSION,
        "model_type": "xgboost",
        "trained_on": "synthetic",
        "target": schema["target"],
        "feature_names": schema["feature_names"],
        "n_features": schema["n_features"],
        "hyperparameters": {**best, **{k: v for k, v in FIXED.items() if k != "n_jobs"}},
        "random_state": RANDOM_STATE,
        "tuning": {"method": "random search", "n_candidates": N_SEARCH, "space": SEARCH_SPACE,
                   "early_stopping": {"rounds": EARLY_STOPPING_ROUNDS, "max_trees": MAX_TREES,
                                      "eval_set": "validation", "metric": "mae"},
                   "selection_metric": "validation MAE", "fit_on": "train",
                   "final_model": "refit on train with n_estimators fixed to the best early-stopping iteration",
                   "results_file": TUNING_PATH.name},
        "split": split_now,
        "test_set_used": False,
        "metrics": {"validation": {"baseline": regression_metrics(y_va, base_va),
                                   "random_forest": rf_val,
                                   "xgboost": regression_metrics(y_va, xgb_va)},
                    "train": {"xgboost": regression_metrics(y_tr, xgb_tr)}},
        "comparison_file": COMPARISON_PATH.name,
        "bootstrap_mae_differences_validation": boot,
        "validation_optional_inputs_missing": {"features_set_to_train_median": OPTIONAL_BACKEND_FEATURES,
                                               **missing_scenario},
        "prediction_validity_validation": validity,
        "inference_postprocessing": "round to nearest integer and clip to [0, total_students] "
                                    "(API only; metrics above use raw predictions)",
        "top_permutation_importance": permutation["mean"].sort_values(ascending=False).head(10).round(3).to_dict(),
        "artifacts": {"model": MODEL_PATH.name, "preprocessor": PREPROCESSOR_PATH.name,
                      "preprocessor_md5": file_md5(PREPROCESSOR_PATH), "feature_schema": SCHEMA_PATH.name,
                      "feature_schema_md5": file_md5(SCHEMA_PATH), "raw_data_md5": schema["raw_data_md5"]},
        "versions": {"xgboost": xgboost.__version__, "scikit-learn": sklearn.__version__,
                     "pandas": pd.__version__, "numpy": np.__version__},
    }
    METADATA_PATH.write_text(json.dumps(metadata, indent=2, default=str), encoding="utf-8")

    unchanged = ({p.name: file_md5(p) for p in PROCESSED_DIR.glob("*.csv")} == hashes_before
                 and file_md5(RF_MODEL_PATH) == rf_hash_before)
    assert unchanged, "processed splits or the RF model were modified!"

    # ---------------- console report ----------------
    print(f"\nSELECTED HYPERPARAMETERS: {best}")
    print("\nVALIDATION COMPARISON (182 rows, same for all)")
    for _, r in overall.iterrows():
        print(f"  {r['model']:<30} MAE {r['mae']:7.2f}  RMSE {r['rmse']:7.2f}  R2 {r['r2']:.4f}  bias {r['bias']:+.2f}")
    print(f"  XGBoost train MAE {metadata['metrics']['train']['xgboost']['mae']:.2f} (overfitting check)")
    print("\nBY MEAL TYPE / EXAM DAY (validation)")
    print(pd.concat([by_meal, by_exam]).round(2).to_string(index=False))
    print("\nPAIRED DAY-BLOCK BOOTSTRAP OF MAE DIFFERENCE (negative = first model better)")
    for k, b in boot.items():
        print(f"  {k:<30} diff {b['mae_diff']:+7.2f}  95% CI [{b['ci95_low']:+.2f}, {b['ci95_high']:+.2f}]"
              f"  first better in {b['share_boot_a_better']:.0%} of resamples  meaningful={b['meaningful']}")
    print(f"\nOPTIONAL INPUTS MISSING -> XGB MAE {missing_scenario['xgboost']['mae']:.2f} | "
          f"RF MAE {missing_scenario['random_forest']['mae']:.2f}")
    print(f"PREDICTION VALIDITY (XGB, validation): {validity}")
    print("\nTOP 10 PERMUTATION IMPORTANCE (validation, MAE increase):")
    print(permutation.sort_values("mean", ascending=False).head(10).round(2).to_string())
    print("\nTOP 10 TOTAL-GAIN SHARE (training):")
    print(gain_df["mean"].sort_values(ascending=False).head(10).round(4).to_string())
    print(f"\nmodel reload reproduces predictions: {reload_ok} | splits & RF unchanged: {unchanged} "
          f"| test set loaded: False | runtime {time.time() - t0:.0f}s")
    print(f"Saved model: {MODEL_PATH}")


if __name__ == "__main__":
    from src.train_xgboost import main as package_main
    package_main()
