"""MessMind Phase 7 — final evaluation of the FROZEN Random Forest on the chronological test set.

Run from the ml/ folder:
    .\\venv\\Scripts\\python.exe -m src.evaluate_final

* Refuses to run unless the model, preprocessor, schema and processed splits match the checksums
  recorded in models/model_selection.json (written BEFORE the test set was first opened).
* Fits, tunes and modifies nothing. Test results are reported only.
* Scores only the selected model (Random Forest) and the historical-demand baseline.
  XGBoost is deliberately NOT scored on the test set.
* All data is SYNTHETIC.

Outputs:  models/final_evaluation.json   docs/figures/final_*.png
"""

from __future__ import annotations

import json

import joblib
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy.stats import ks_2samp

from src.evaluation import (INK_MUTED, MEAL_ORDER, ML_ROOT, MODELS_DIR, PREPROCESSOR_PATH, PROCESSED_DIR,
                            baseline_predict, check_inputs, file_md5, load_schema, load_split,
                            metrics_by_group, paired_bootstrap_mae_diff, plot_actual_vs_pred,
                            plot_residuals, prediction_validity, regression_metrics)

SELECTION_PATH = MODELS_DIR / "model_selection.json"
RF_METADATA_PATH = MODELS_DIR / "random_forest_metadata.json"
RESULTS_PATH = MODELS_DIR / "final_evaluation.json"
DOC_FIG_DIR = ML_ROOT / "docs" / "figures"
OPTIONAL_BACKEND_FEATURES = ["previous_meal_attendance", "previous_leftover_kg", "historical_dish_rating"]
SHIFT_FEATURES = ["actual_dish_consumers", "interested_taps", "total_responses", "tap_share",
                  "projected_interest", "historical_dish_demand", "historical_dish_rating",
                  "previous_meal_attendance", "temperature", "rainfall"]
BASE_COLOR, RF_COLOR = "#a3a29c", "#2a78d6"


def postprocess(pred: np.ndarray, total_students: np.ndarray) -> np.ndarray:
    """Exactly what the API will do: round to whole students, clip to [0, total_students]."""
    return np.clip(np.rint(pred), 0, total_students)


def total_students_of(X: pd.DataFrame) -> np.ndarray:
    # response_rate = total_responses / total_students  ->  recover total_students exactly per row
    return (X["total_responses"] / X["response_rate"]).round().to_numpy()


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------
def freeze_checks(selection: dict) -> list[tuple[str, bool]]:
    res = [(f"{n} unchanged since freeze", file_md5(MODELS_DIR / n) == m)
           for n, m in selection["frozen_artifact_md5"].items()]
    res += [(f"{n} unchanged since freeze", file_md5(PROCESSED_DIR / n) == m)
            for n, m in selection["processed_split_md5"].items()]
    res.append(("selection FROZEN and decided before the test set was used",
                selection["status"] == "FROZEN" and selection["decided_before_test_set_was_used"]))
    res.append(("selected model is random_forest", selection["selected_model"] == "random_forest"))
    return res


# ---------------------------------------------------------------------------
# Distribution comparison (train vs val vs test)
# ---------------------------------------------------------------------------
def distribution_table(frames: dict) -> pd.DataFrame:
    rows = []
    for col in SHIFT_FEATURES:
        r = {"feature": col}
        for name, d in frames.items():
            r[f"{name}_mean"] = d[col].mean()
        r["ks_p_train_vs_test"] = ks_2samp(frames["train"][col], frames["test"][col]).pvalue
        r["ks_p_val_vs_test"] = ks_2samp(frames["val"][col], frames["test"][col]).pvalue
        rows.append(r)
    return pd.DataFrame(rows)


def composition_table(metas: dict) -> pd.DataFrame:
    out = {}
    for name, m in metas.items():
        days = m.groupby("meta__date")["meta__is_exam_day"].first()
        out[name] = {"rows": len(m), "days": m["meta__date"].nunique(),
                     "exam_day_row_share": float(m["meta__is_exam_day"].mean()),
                     "exam_days": int(days.sum()),
                     **{f"{meal}_row_share": float((m["meta__meal_type"] == meal).mean()) for meal in MEAL_ORDER}}
    return pd.DataFrame(out).T


# ---------------------------------------------------------------------------
# Figures
# ---------------------------------------------------------------------------
def _style():
    plt.rcParams.update({"axes.grid": True, "grid.color": "#e6e5e0", "axes.edgecolor": "#bdbcb6",
                         "axes.spines.top": False, "axes.spines.right": False, "axes.titleweight": "bold"})


def plot_error_by_meal(val_tab: pd.DataFrame, test_tab: pd.DataFrame, path):
    """Two panels (validation | test), same y-scale: MAE of baseline vs RF per meal type + overall."""
    _style()
    groups = MEAL_ORDER + ["all"]
    fig, axes = plt.subplots(1, 2, figsize=(12, 4.4), sharey=True)
    for ax, (title, tab) in zip(axes, [("Validation (2026-09-02 → 09-14)", val_tab),
                                       ("Test (2026-09-15 → 09-28)", test_tab)]):
        x, w = np.arange(len(groups)), 0.38
        for i, (model, color) in enumerate([("Baseline (historical demand)", BASE_COLOR),
                                            ("Random Forest", RF_COLOR)]):
            vals = [tab[(tab.group == g) & (tab.model == model)]["mae"].iloc[0] for g in groups]
            bars = ax.bar(x + (i - 0.5) * w, vals, width=w - 0.04, color=color, label=model)
            ax.bar_label(bars, fmt="%.0f", fontsize=8, color="#3d3c39", padding=2)
        ax.set_xticks(x, [g.capitalize() for g in groups])
        ax.set_title(title)
        ax.grid(axis="x", visible=False)
    axes[0].set_ylabel("MAE (consumers per dish)")
    axes[1].legend(frameon=False, loc="upper right")
    fig.suptitle("Prediction error by meal type — frozen Random Forest vs baseline (lower is better)",
                 fontweight="bold")
    fig.tight_layout()
    fig.savefig(path, dpi=120, bbox_inches="tight")
    plt.close(fig)


def plot_daily_mae(daily: pd.DataFrame, exam_dates, boundary, path):
    """Daily MAE across validation + test, so any drift over time is visible."""
    _style()
    fig, ax = plt.subplots(figsize=(12, 4.2))
    for d in exam_dates:
        ax.axvspan(d - pd.Timedelta(hours=12), d + pd.Timedelta(hours=12), color="#ecebe6", lw=0)
    ax.plot(daily.index, daily["baseline"], color=BASE_COLOR, lw=2, marker="o", ms=5, label="Baseline")
    ax.plot(daily.index, daily["rf"], color=RF_COLOR, lw=2, marker="o", ms=5, label="Random Forest")
    ax.axvline(boundary - pd.Timedelta(hours=12), color=INK_MUTED, ls="--", lw=1.2)
    ymax = daily.max().max() * 1.08
    ax.text(boundary - pd.Timedelta(hours=18), ymax * 0.97, "validation ◀", ha="right", va="top",
            color=INK_MUTED, fontsize=9)
    ax.text(boundary - pd.Timedelta(hours=6), ymax * 0.97, "▶ test", ha="left", va="top",
            color=INK_MUTED, fontsize=9)
    ax.fill_between([], [], color="#ecebe6", label="exam day")
    ax.set(ylim=(0, ymax), ylabel="MAE that day (consumers per dish)",
           title="Daily error over time — validation and test (frozen Random Forest)")
    ax.legend(frameon=False, ncol=3, loc="upper left", bbox_to_anchor=(0, -0.1))
    fig.tight_layout()
    fig.savefig(path, dpi=120, bbox_inches="tight")
    plt.close(fig)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    selection = json.loads(SELECTION_PATH.read_text(encoding="utf-8"))
    rf_meta = json.loads(RF_METADATA_PATH.read_text(encoding="utf-8"))

    print("FREEZE CHECKS")
    fc = freeze_checks(selection)
    for name, ok in fc:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    if not all(ok for _, ok in fc):
        raise SystemExit("Frozen artifacts changed - refusing to evaluate.")

    schema = load_schema()
    preprocessor = joblib.load(PREPROCESSOR_PATH)
    model = joblib.load(MODELS_DIR / selection["model_file"])
    X_tr, y_tr, m_tr = load_split("train", schema)
    X_va, y_va, m_va = load_split("val", schema)
    X_te, y_te, m_te = load_split("test", schema, allow_test=True)

    print("\nINPUT CHECKS")
    checks = check_inputs(schema, {"train": (X_tr, y_tr, m_tr), "val": (X_va, y_va, m_va),
                                   "test": (X_te, y_te, m_te)}, preprocessor)
    checks.append(("model feature names & order == training schema",
                   list(model.feature_names_in_) == schema["feature_names"] == rf_meta["feature_names"], ""))
    checks.append(("test rows / dates match the Phase 4 split record",
                   len(y_te) == schema["split"]["test"]["rows"]
                   and m_te["meta__date"].min().strftime("%Y-%m-%d") == schema["split"]["test"]["start"]
                   and m_te["meta__date"].max().strftime("%Y-%m-%d") == schema["split"]["test"]["end"], ""))
    for name, ok, detail in checks:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))
    if not all(ok for _, ok, _ in checks):
        raise SystemExit("Input checks failed.")

    # ---------------- predictions (no fitting anywhere) ----------------
    rf_va, rf_te = model.predict(X_va), model.predict(X_te)
    base_va, base_te = baseline_predict(X_va, m_va), baseline_predict(X_te, m_te)
    ts_te = total_students_of(X_te)
    rf_te_api = postprocess(rf_te, ts_te)

    val_m = {"baseline": regression_metrics(y_va, base_va), "random_forest": regression_metrics(y_va, rf_va)}
    val_matches_phase5 = abs(val_m["random_forest"]["mae"]
                             - rf_meta["metrics"]["validation"]["random_forest"]["mae"]) < 1e-6
    test_m = {"baseline": regression_metrics(y_te, base_te),
              "random_forest_raw": regression_metrics(y_te, rf_te),
              "random_forest_api_rounded_clipped": regression_metrics(y_te, rf_te_api)}
    n_clipped = int(((rf_te < 0) | (rf_te > ts_te)).sum())
    train_m = rf_meta["metrics"]["train"]["random_forest"]

    preds_va = {"Baseline (historical demand)": base_va, "Random Forest": rf_va}
    preds_te = {"Baseline (historical demand)": base_te, "Random Forest": rf_te}

    def group_table(y, preds, meta):
        t = metrics_by_group(y, preds, meta["meta__meal_type"])
        allrows = pd.DataFrame([{**regression_metrics(y, p), "group": "all", "model": k, "small_sample": False}
                                for k, p in preds.items()])
        return pd.concat([t, allrows[t.columns]], ignore_index=True)

    val_tab, test_tab = group_table(y_va, preds_va, m_va), group_table(y_te, preds_te, m_te)
    exam_te = metrics_by_group(y_te, preds_te, m_te["meta__is_exam_day"].map({True: "exam day", False: "non-exam day"}))
    exam_va = metrics_by_group(y_va, preds_va, m_va["meta__is_exam_day"].map({True: "exam day", False: "non-exam day"}))
    boot_te = paired_bootstrap_mae_diff(y_te, rf_te, base_te, m_te["meta__date"])
    validity = prediction_validity(rf_te, upper=ts_te)

    # ---------------- distribution / drift ----------------
    frames = {n: X.assign(actual_dish_consumers=y.to_numpy())
              for n, X, y in [("train", X_tr, y_tr), ("val", X_va, y_va), ("test", X_te, y_te)]}
    dist = distribution_table(frames)
    comp = composition_table({"train": m_tr, "val": m_va, "test": m_te})

    # Does the baseline's bias come from history that contains exam days? (test starts right after exams)
    resid_base_te = base_te - y_te.to_numpy()
    first_week = (m_te["meta__date"] <= m_te["meta__date"].min() + pd.Timedelta(days=6)).to_numpy()
    baseline_bias_by_week = {"test_days_1_7": float(resid_base_te[first_week].mean()),
                             "test_days_8_14": float(resid_base_te[~first_week].mean())}

    # ---------------- other diagnostics ----------------
    X_te_missing = X_te.copy()
    for col in OPTIONAL_BACKEND_FEATURES:
        X_te_missing[col] = X_tr[col].median()
    missing = regression_metrics(y_te, model.predict(X_te_missing))
    hi = (y_te >= 750).to_numpy()
    high = {"n_rows": int(hi.sum()), "rf_mean_error": float((rf_te - y_te.to_numpy())[hi].mean()),
            "train_target_max": float(y_tr.max()), "test_target_max": float(y_te.max())}
    worst = (pd.DataFrame({"date": m_te["meta__date"].dt.strftime("%Y-%m-%d"), "meal": m_te["meta__meal_type"],
                           "dish": m_te["meta__dish_name"], "exam_day": m_te["meta__is_exam_day"],
                           "actual": y_te.to_numpy(), "rf_pred": rf_te.round(1)})
             .assign(error=lambda d: (d.rf_pred - d.actual).round(1))
             .iloc[np.argsort(-np.abs(rf_te - y_te.to_numpy()))].head(8))

    all_m = pd.concat([m_va, m_te], ignore_index=True)
    all_y = np.concatenate([y_va, y_te])
    daily = (pd.DataFrame({"date": all_m["meta__date"],
                           "baseline": np.abs(np.concatenate([base_va, base_te]) - all_y),
                           "rf": np.abs(np.concatenate([rf_va, rf_te]) - all_y)})
             .groupby("date").mean())

    # ---------------- figures (docs/figures, tracked with the report) ----------------
    DOC_FIG_DIR.mkdir(parents=True, exist_ok=True)
    plot_actual_vs_pred(y_te, preds_te, m_te["meta__meal_type"], DOC_FIG_DIR / "final_actual_vs_predicted.png",
                        "TEST set (2026-09-15 → 09-28, SYNTHETIC) — frozen Random Forest vs baseline")
    plot_residuals(y_te, rf_te, m_te["meta__meal_type"], DOC_FIG_DIR / "final_residuals.png",
                   "Frozen Random Forest residuals — test set")
    plot_error_by_meal(val_tab, test_tab, DOC_FIG_DIR / "final_error_by_meal.png")
    exam_dates = sorted(all_m.loc[all_m["meta__is_exam_day"], "meta__date"].unique())
    plot_daily_mae(daily, [pd.Timestamp(d) for d in exam_dates], m_te["meta__date"].min(),
                   DOC_FIG_DIR / "final_daily_mae.png")

    # ---------------- save ----------------
    still_frozen = all(ok for _, ok in freeze_checks(selection))
    results = {
        "evaluated_model": "random_forest", "model_version": selection["model_version"], "data": "synthetic",
        "test_split": schema["split"]["test"],
        "test_set_history": "First opened on 2026-11-14 by an earlier evaluation script, AFTER the model "
                            "selection was frozen (models/model_selection.json). No model, preprocessing or "
                            "feature change was made after that; this script re-scores the same frozen model.",
        "metrics": {"train_phase5": train_m, "validation": val_m, "test": test_m},
        "validation_recomputed_matches_phase5": val_matches_phase5,
        "n_test_predictions_changed_by_clipping": n_clipped,
        "by_meal_type": {"validation": val_tab.to_dict(orient="records"), "test": test_tab.to_dict(orient="records")},
        "by_exam_day": {"validation": exam_va.to_dict(orient="records"), "test": exam_te.to_dict(orient="records")},
        "bootstrap_rf_minus_baseline_test": boot_te,
        "distribution": {"feature_means_and_ks": dist.to_dict(orient="records"),
                         "composition": comp.reset_index(names="split").to_dict(orient="records"),
                         "baseline_bias_by_test_week": baseline_bias_by_week},
        "prediction_validity_test": validity,
        "optional_inputs_missing_test": {"features_set_to_train_median": OPTIONAL_BACKEND_FEATURES, **missing},
        "high_demand_test": high,
        "largest_errors_test": worst.to_dict(orient="records"),
        "daily_mae": daily.reset_index().assign(date=lambda d: d.date.dt.strftime("%Y-%m-%d")).to_dict(orient="records"),
        "xgboost_scored_on_test": False,
        "frozen_artifacts_unchanged_after_run": still_frozen,
        "figures": [f"docs/figures/{p.name}" for p in sorted(DOC_FIG_DIR.glob("final_*.png"))],
    }
    RESULTS_PATH.write_text(json.dumps(results, indent=2, default=str), encoding="utf-8")

    # ---------------- console ----------------
    pd.set_option("display.width", 200)
    print(f"\nTEST SET: {len(y_te)} rows, {m_te['meta__date'].nunique()} days, "
          f"{schema['split']['test']['start']} -> {schema['split']['test']['end']}")
    print("\nMETRICS                              MAE     RMSE     R2      bias")
    for label, m in [("train  RF (Phase 5)", train_m),
                     ("val    baseline", val_m["baseline"]), ("val    RF", val_m["random_forest"]),
                     ("test   baseline", test_m["baseline"]), ("test   RF raw", test_m["random_forest_raw"]),
                     ("test   RF rounded+clipped (API)", test_m["random_forest_api_rounded_clipped"])]:
        print(f"  {label:<33} {m['mae']:7.2f} {m['rmse']:8.2f} {m['r2']:7.4f} {m.get('bias', float('nan')):+8.2f}")
    print(f"  validation recomputed == Phase 5 record: {val_matches_phase5} | predictions changed by clipping: {n_clipped}")
    print("\nBY MEAL TYPE (MAE)          validation           test")
    for g in MEAL_ORDER + ["all"]:
        def get(t, mdl): return t[(t.group == g) & (t.model == mdl)]["mae"].iloc[0]
        print(f"  {g:<10} baseline {get(val_tab,'Baseline (historical demand)'):6.1f} RF {get(val_tab,'Random Forest'):5.1f}"
              f"   | baseline {get(test_tab,'Baseline (historical demand)'):6.1f} RF {get(test_tab,'Random Forest'):5.1f}")
    print("\nEXAM / NON-EXAM (test)")
    print(exam_te.round(2).to_string(index=False))
    print(f"\nBOOTSTRAP test RF - baseline: {boot_te['mae_diff']:+.2f}  95% CI "
          f"[{boot_te['ci95_low']:+.2f}, {boot_te['ci95_high']:+.2f}]  meaningful={boot_te['meaningful']}")
    print("\nCOMPOSITION"); print(comp.round(3).to_string())
    print("\nFEATURE MEANS & KS p-values"); print(dist.round(3).to_string(index=False))
    print(f"\nBASELINE BIAS BY TEST WEEK: {baseline_bias_by_week}")
    print(f"VALIDITY: {validity}")
    print(f"OPTIONAL INPUTS MISSING: MAE {missing['mae']:.2f} RMSE {missing['rmse']:.2f} R2 {missing['r2']:.4f}")
    print(f"HIGH DEMAND: {high}")
    print("\nLARGEST ERRORS"); print(worst.to_string(index=False))
    print(f"\nfrozen artifacts unchanged after run: {still_frozen} | XGBoost scored on test: False")
    print(f"Saved: {RESULTS_PATH} and docs/figures/final_*.png")


if __name__ == "__main__":
    from src.evaluate_final import main as package_main
    package_main()
