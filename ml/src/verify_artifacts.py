"""MessMind Phase 8 — verify the packaged model artifacts and the inference module.

Run from the ml/ folder:
    .\\venv\\Scripts\\python.exe -m src.verify_artifacts

Exits with code 1 if any check fails. Nothing is trained, fitted or written (read-only).
"""

from __future__ import annotations

import json
import subprocess
import sys

import joblib
import numpy as np
import pandas as pd

from src.evaluation import ML_ROOT, MODELS_DIR, PROCESSED_DIR, file_md5
from src.predict import InputValidationError, MessMindPredictor
from src.preprocessing import chronological_split, load_raw

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(ok), detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))


def section(title: str) -> None:
    print(f"\n{title}")


# ---------------------------------------------------------------------------
SAMPLE_MEAL = {   # hand-written example in the shape of the API request (values are illustrative)
    "date": "2026-11-16", "meal_type": "lunch", "total_students": 1000, "total_responses": 410,
    "is_holiday": False, "is_exam_day": False, "is_festival": False,
    "temperature": 29.5, "rainfall": 0.0, "previous_meal_attendance": 720,
    "dishes": [
        {"dish_name": "Rice", "dish_category": "staple_rice", "interested_taps": 170,
         "historical_dish_demand": 680.0, "historical_dish_rating": 3.8, "previous_leftover_kg": 12.0},
        {"dish_name": "Chapati", "dish_category": "bread", "interested_taps": 160,
         "historical_dish_demand": 630.0, "historical_dish_rating": 3.8, "previous_leftover_kg": 9.0},
        {"dish_name": "Dal Tadka", "dish_category": "dal", "interested_taps": 140,
         "historical_dish_demand": 560.0, "historical_dish_rating": 3.6, "previous_leftover_kg": 14.0},
        {"dish_name": "Paneer Butter Masala", "dish_category": "main_veg", "interested_taps": 230,
         "historical_dish_demand": 520.0, "historical_dish_rating": 4.5, "previous_leftover_kg": 6.0},
        {"dish_name": "Jeera Aloo", "dish_category": "main_veg", "interested_taps": 90},   # never seen before
    ],
}
SAMPLE_MEAL_MINIMAL = {   # only required fields: every optional input missing
    "date": "2026-11-16", "meal_type": "breakfast", "total_students": 1000, "total_responses": 300,
    "dishes": [{"dish_name": "Tea", "dish_category": "beverage", "interested_taps": 150},
               {"dish_name": "Poha", "dish_category": "breakfast_item", "interested_taps": 110},
               {"dish_name": "Banana", "dish_category": "fruit", "interested_taps": 60},
               {"dish_name": "Masala Dosa", "dish_category": "breakfast_item", "interested_taps": 170}],
}


def records_from_raw(df: pd.DataFrame) -> list[dict]:
    """Turn raw CSV rows into plain API-style records (target and data_source are dropped)."""
    out = df.drop(columns=["actual_dish_consumers", "data_source"]).copy()
    out["date"] = out["date"].dt.strftime("%Y-%m-%d")
    recs = out.to_dict(orient="records")
    for r in recs:  # NaN -> None, numpy scalars -> python, like JSON input would be
        for k, v in r.items():
            if isinstance(v, float) and np.isnan(v):
                r[k] = None
            elif isinstance(v, np.generic):
                r[k] = v.item()
    return recs


def main() -> None:
    selection = json.loads((MODELS_DIR / "model_selection.json").read_text(encoding="utf-8"))
    card_path = MODELS_DIR / "model_card.json"

    # ------------------------------------------------------------------ A
    section("A. ARTIFACTS ON DISK")
    required = ["random_forest.joblib", "preprocessor.joblib", "feature_schema.json", "model_card.json",
                "model_selection.json", "random_forest_metadata.json", "final_evaluation.json"]
    for name in required:
        check(f"exists: models/{name}", (MODELS_DIR / name).exists())
    for name, md5 in selection["frozen_artifact_md5"].items():
        check(f"{name} identical to frozen version", file_md5(MODELS_DIR / name) == md5, md5)
    card = json.loads(card_path.read_text(encoding="utf-8"))
    for key in ("model", "preprocessor", "feature_schema"):
        a = card["artifacts"][key]
        check(f"model card MD5 matches {a['path']}", file_md5(ML_ROOT / a["path"]) == a["md5"])
    meta_keys = ["model_name", "model_type", "model_version", "hyperparameters", "features", "target",
                 "dataset", "splits", "metrics", "synthetic_data_limitation", "postprocessing"]
    check("model card has all required metadata", all(k in card for k in meta_keys),
          str([k for k in meta_keys if k not in card]))
    final = json.loads((MODELS_DIR / "final_evaluation.json").read_text(encoding="utf-8"))
    check("model card test metrics == final evaluation record",
          card["metrics"]["test"]["random_forest_raw"] == final["metrics"]["test"]["random_forest_raw"])

    # ------------------------------------------------------------------ B
    section("B. LOAD + FEATURE ORDER")
    pred = MessMindPredictor()
    pre_hash_before, model_hash_before = joblib.hash(pred.preprocessor), joblib.hash(pred.model)
    names = pred.feature_names
    check("predictor loaded", True, f"{pred.model_version}, trained_on={pred.trained_on}")
    check("69 features", len(names) == 69, str(len(names)))
    check("preprocessor output order == schema == model == card",
          list(pred.preprocessor.named_steps["columns"].get_feature_names_out()) == names
          == list(pred.model.feature_names_in_) == card["features"]["ordered_names"])
    check("target is actual_dish_consumers", card["target"]["name"] == "actual_dish_consumers")

    # ------------------------------------------------------------------ C
    section("C. TRAINING / INFERENCE PARITY (raw records -> predict.py == training pipeline)")
    splits = chronological_split(load_raw())
    for split in ("train", "val", "test"):
        raw = splits[split]
        df, _ = pred.validate(records_from_raw(raw))
        X_inf = pred.preprocessor.transform(df)
        processed = pd.read_csv(PROCESSED_DIR / f"{split}.csv")
        same_X = np.allclose(X_inf.to_numpy(float), processed[names].to_numpy(float), equal_nan=False)
        check(f"[{split}] features from raw input == processed {split}.csv", same_X, f"{len(df)} rows")
        same_pred = np.allclose(pred.model.predict(X_inf), pred.model.predict(processed[names]))
        check(f"[{split}] raw predictions identical", same_pred)
    test_out = pred.predict_records(records_from_raw(splits["test"]))
    y = splits["test"]["actual_dish_consumers"].to_numpy()
    raw_mae = float(np.mean(np.abs(np.array([r["raw_prediction"] for r in test_out]) - y)))
    final_mae = float(np.mean(np.abs(np.array([r["predicted_consumers"] for r in test_out]) - y)))
    rec_raw = final["metrics"]["test"]["random_forest_raw"]["mae"]
    rec_final = final["metrics"]["test"]["random_forest_api_rounded_clipped"]["mae"]
    check("test MAE via predict.py reproduces Phase 7 (raw)", abs(raw_mae - rec_raw) < 0.01,
          f"{raw_mae:.4f} vs {rec_raw:.4f} (raw_prediction is rounded to 2 dp)")
    check("test MAE via predict.py reproduces Phase 7 (rounded+clipped)", abs(final_mae - rec_final) < 1e-9,
          f"{final_mae:.4f} vs {rec_final:.4f}")
    new_dish = [r for r in pred.predict_records(records_from_raw(splits["train"])) if "new_dish_no_history" in r["warnings"]]
    check("the one new-dish row (Aloo Matar) is flagged", len(new_dish) == 1 and new_dish[0]["dish_name"] == "Aloo Matar")

    # ------------------------------------------------------------------ D
    section("D. SAMPLE PREDICTIONS")
    for label, meal in [("full inputs + one unseen dish", SAMPLE_MEAL), ("required fields only", SAMPLE_MEAL_MINIMAL)]:
        res = pred.predict_meal(meal)
        print(f"  -- {meal['date']} {meal['meal_type']} ({label}) | model {res['model_version']} | {res['trained_on']}")
        for r in res["predictions"]:
            print(f"     {r['dish_name']:<22} taps {r['interested_taps']:>4} -> predicted {r['predicted_consumers']:>4}"
                  f"  (raw {r['raw_prediction']:7.2f})  warnings={r['warnings']}")
        ok = all(0 <= r["predicted_consumers"] <= meal["total_students"] and isinstance(r["predicted_consumers"], int)
                 for r in res["predictions"])
        check(f"sample '{label}': whole numbers within [0, total_students]", ok)
    unseen = next(r for r in pred.predict_meal(SAMPLE_MEAL)["predictions"] if r["dish_name"] == "Jeera Aloo")
    check("unseen dish accepted and flagged", {"unseen_dish", "new_dish_no_history"} <= set(unseen["warnings"]),
          str(unseen["warnings"]))

    # ------------------------------------------------------------------ E
    section("E. EDGE CASES (valid input, extreme values)")
    base = {"date": "2026-11-17", "meal_type": "dinner", "dish_name": "Rice", "dish_category": "staple_rice",
            "historical_dish_demand": 600.0}
    edge = {
        "zero app responses": {**base, "total_students": 1000, "total_responses": 0, "interested_taps": 0},
        "everyone taps": {**base, "total_students": 1000, "total_responses": 1000, "interested_taps": 1000},
        "tiny mess (50 students), big history": {**base, "total_students": 50, "total_responses": 50,
                                                 "interested_taps": 50, "historical_dish_demand": 800.0},
        "huge history": {**base, "total_students": 1000, "total_responses": 400, "interested_taps": 400,
                         "historical_dish_demand": 5000.0},
        "unseen category": {**base, "dish_name": "Momos", "dish_category": "street_food",
                            "total_students": 1000, "total_responses": 400, "interested_taps": 100},
    }
    for label, rec in edge.items():
        r = pred.predict_records([rec])[0]
        ok = 0 <= r["predicted_consumers"] <= rec["total_students"] and np.isfinite(r["raw_prediction"])
        check(f"{label}: {r['predicted_consumers']} in [0, {rec['total_students']}]", ok, str(r["warnings"]))
    tiny = pred.predict_records([edge["tiny mess (50 students), big history"]])[0]
    check("mess size outside training range is flagged",
          "total_students_outside_training_range" in tiny["warnings"] and "clipped_to_valid_range" in tiny["warnings"])
    ok_date = pred.predict_records([{**base, "date": "2026-11-17", "total_students": 1000, "total_responses": 400,
                                     "interested_taps": 100}])
    check("valid ISO date accepted", len(ok_date) == 1)

    # ------------------------------------------------------------------ F
    section("F. INVALID INPUT IS REJECTED")
    good = {"date": "2026-11-17", "meal_type": "lunch", "dish_name": "Rice", "dish_category": "staple_rice",
            "total_students": 1000, "total_responses": 400, "interested_taps": 100}
    bad_cases = {
        "missing interested_taps": {k: v for k, v in good.items() if k != "interested_taps"},
        "negative taps": {**good, "interested_taps": -1},
        "taps > total_responses": {**good, "interested_taps": 401},
        "responses > total_students": {**good, "total_responses": 1001},
        "total_students = 0": {**good, "total_students": 0, "total_responses": 0, "interested_taps": 0},
        "total_students negative": {**good, "total_students": -5},
        "fractional student count": {**good, "total_students": 999.5},
        "NaN taps": {**good, "interested_taps": float("nan")},
        "infinite temperature": {**good, "temperature": float("inf")},
        "text instead of number": {**good, "rainfall": "heavy"},
        "unknown meal_type": {**good, "meal_type": "snacks"},
        "bad date (dd/mm/yyyy)": {**good, "date": "16/11/2026"},
        "impossible date": {**good, "date": "2026-02-30"},
        "rating out of range": {**good, "historical_dish_rating": 7},
        "negative leftover": {**good, "previous_leftover_kg": -2},
        "bool given as text": {**good, "is_holiday": "yes"},
        "day_of_week contradicts date": {**good, "day_of_week": 0},   # 2026-11-17 is a Tuesday (1)
        "empty dish name": {**good, "dish_name": "  "},
    }
    for label, rec in bad_cases.items():
        try:
            pred.predict_records([rec])
            check(f"rejects {label}", False, "was accepted")
        except InputValidationError as e:
            check(f"rejects {label}", True, e.errors[0][:70])
    for label, recs in {"duplicate dish in one meal": [good, good],
                        "different total_responses in one meal": [good, {**good, "dish_name": "Dal Tadka",
                                                                         "dish_category": "dal", "total_responses": 300}]}.items():
        try:
            pred.predict_records(recs)
            check(f"rejects {label}", False, "was accepted")
        except InputValidationError as e:
            check(f"rejects {label}", True, e.errors[0][:70])

    # ------------------------------------------------------------------ G
    section("G. RANDOM VALID INPUTS (bounds fuzz test, seed 0)")
    rng = np.random.default_rng(0)
    dishes = sorted(pred.known_categories["dish_name"])
    cat_of = splits["train"].drop_duplicates("dish_name").set_index("dish_name")["dish_category"].to_dict()
    recs = []
    for i in range(1000):
        ts = int(rng.integers(1, 3000)); tr = int(rng.integers(0, ts + 1)); tp = int(rng.integers(0, tr + 1))
        d = dishes[i % len(dishes)]
        recs.append({"date": f"2026-12-{(i % 28) + 1:02d}", "meal_type": ["breakfast", "lunch", "dinner"][i % 3],
                     "dish_name": d, "dish_category": cat_of[d], "total_students": ts, "total_responses": tr,
                     "interested_taps": tp, "is_holiday": bool(rng.random() < 0.1),
                     "temperature": float(rng.uniform(-5, 45)), "rainfall": float(rng.uniform(0, 100)),
                     "historical_dish_demand": None if rng.random() < 0.1 else float(rng.uniform(0, 3000)),
                     "historical_dish_rating": float(rng.uniform(1, 5)),
                     "previous_leftover_kg": float(rng.uniform(0, 100)),
                     "previous_meal_attendance": float(rng.uniform(0, ts))})
    # one record per (date, meal, dish) so every "meal" is valid
    out = []
    for i in range(0, len(recs), 1):
        out.extend(pred.predict_records([recs[i]]))
    finals = np.array([r["predicted_consumers"] for r in out]); totals = np.array([r["total_students"] for r in recs])
    check("1000 random inputs: all finite", np.isfinite(finals).all())
    check("1000 random inputs: all within [0, total_students]", ((finals >= 0) & (finals <= totals)).all(),
          f"{int(sum('clipped_to_valid_range' in r['warnings'] for r in out))} needed clipping")

    # ------------------------------------------------------------------ H
    section("H. DETERMINISM, NO REFITTING, FRESH PROCESS")
    a, b = pred.predict_meal(SAMPLE_MEAL), pred.predict_meal(SAMPLE_MEAL)
    check("same input -> identical output", a == b)
    check("preprocessor unchanged in memory after all predictions", joblib.hash(pred.preprocessor) == pre_hash_before)
    check("model unchanged in memory after all predictions", joblib.hash(pred.model) == model_hash_before)
    for name, md5 in selection["frozen_artifact_md5"].items():
        check(f"{name} on disk still frozen", file_md5(MODELS_DIR / name) == md5)
    code = ("import sys, json; sys.path.insert(0, 'ml'); from src.predict import MessMindPredictor; "
            "p = MessMindPredictor(); print(json.dumps(p.info()))")
    proc = subprocess.run([sys.executable, "-c", code], cwd=ML_ROOT.parent, capture_output=True, text=True)
    check("loads in a fresh Python process from another folder", proc.returncode == 0,
          proc.stdout.strip() or proc.stderr.strip()[-200:])

    # ------------------------------------------------------------------ summary
    n_fail = sum(not ok for _, ok, _ in RESULTS)
    print(f"\nSUMMARY: {len(RESULTS) - n_fail}/{len(RESULTS)} checks passed")
    if n_fail:
        sys.exit(1)


if __name__ == "__main__":
    main()
