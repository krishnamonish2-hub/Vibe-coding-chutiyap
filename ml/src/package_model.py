"""MessMind Phase 8 — build the model card (models/model_card.json) for the frozen Random Forest.

Run from the ml/ folder:
    .\\venv\\Scripts\\python.exe -m src.package_model

This script only READS the frozen artifacts and earlier records and writes ONE new file. It never
retrains, refits or rewrites the model, the preprocessor, the schema or any report.
The model card is the single document the inference code (src/predict.py) and the API rely on.
"""

from __future__ import annotations

import json
import re

import joblib
import numpy as np
import pandas as pd
import sklearn

from src.evaluation import ML_ROOT, MODELS_DIR, PREPROCESSOR_PATH, SCHEMA_PATH, file_md5

MODEL_CARD_PATH = MODELS_DIR / "model_card.json"
PACKAGE_VERSION = "1.0.0"

# Raw input accepted by src/predict.py (one record per dish). This is the ML-side input spec;
# the HTTP request format is defined separately in shared/api_contract.md.
INPUT_SPEC = {
    "date":                     {"type": "date YYYY-MM-DD", "required": True},
    "meal_type":                {"type": "category", "required": True, "allowed": ["breakfast", "lunch", "dinner"]},
    "dish_name":                {"type": "string", "required": True, "unseen": "allowed (falls back to dish_category)"},
    "dish_category":            {"type": "category", "required": True, "unseen": "allowed (encoded as all zeros)"},
    "total_students":           {"type": "int", "required": True, "rule": "> 0"},
    "total_responses":          {"type": "int", "required": True, "rule": "0 <= x <= total_students; same for every dish of a meal"},
    "interested_taps":          {"type": "int", "required": True, "rule": "0 <= x <= total_responses"},
    "is_holiday":               {"type": "bool", "required": False, "default": False},
    "is_exam_day":              {"type": "bool", "required": False, "default": False},
    "is_festival":              {"type": "bool", "required": False, "default": False},
    "day_of_week":              {"type": "int 0-6", "required": False, "default": "derived from date (must match if given)"},
    "is_weekend":               {"type": "bool", "required": False, "default": "derived from date (must match if given)"},
    "temperature":              {"type": "float degC", "required": False, "rule": "-30..60", "if_missing": "train median"},
    "rainfall":                 {"type": "float mm", "required": False, "rule": ">= 0", "if_missing": "train median"},
    "previous_meal_attendance": {"type": "float", "required": False, "rule": "0..total_students", "if_missing": "train median"},
    "historical_dish_demand":   {"type": "float", "required": False, "rule": ">= 0; mean of last 5 PAST servings",
                                 "if_missing": "treated as NEW dish: is_new_dish=1 + train median of (dish_category, meal_type)"},
    "historical_dish_rating":   {"type": "float", "required": False, "rule": "1..5; mean of last 5 PAST ratings",
                                 "if_missing": "train median of (dish_category, meal_type)"},
    "previous_leftover_kg":     {"type": "float", "required": False, "rule": ">= 0; this dish, previous serving",
                                 "if_missing": "train median of (dish_category, meal_type)"},
}


def generator_args() -> str:
    text = (ML_ROOT / "docs" / "data_dictionary.md").read_text(encoding="utf-8")
    m = re.search(r"Generated with: `([^`]+)`", text)
    return m.group(1) if m else "unknown"


def main() -> None:
    selection = json.loads((MODELS_DIR / "model_selection.json").read_text(encoding="utf-8"))
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    rf_meta = json.loads((MODELS_DIR / "random_forest_metadata.json").read_text(encoding="utf-8"))
    final = json.loads((MODELS_DIR / "final_evaluation.json").read_text(encoding="utf-8"))

    # The card is only valid for the frozen artifacts: refuse if anything changed.
    for name, md5 in selection["frozen_artifact_md5"].items():
        if file_md5(MODELS_DIR / name) != md5:
            raise SystemExit(f"{name} differs from the frozen version - refusing to package.")

    model = joblib.load(MODELS_DIR / selection["model_file"])
    preprocessor = joblib.load(PREPROCESSOR_PATH)
    pre_features = list(preprocessor.named_steps["columns"].get_feature_names_out())
    if not (pre_features == schema["feature_names"] == list(model.feature_names_in_)):
        raise SystemExit("Feature order mismatch between preprocessor, schema and model.")

    test = final["metrics"]["test"]
    # Ranges seen in TRAINING data: inputs far outside them are extrapolation (warned at inference).
    from src.preprocessing import chronological_split, load_raw
    train_raw = chronological_split(load_raw())["train"]
    training_ranges = {c: {"min": float(train_raw[c].min()), "max": float(train_raw[c].max())}
                       for c in ("total_students", "total_responses", "interested_taps", "historical_dish_demand",
                                 "actual_dish_consumers")}
    card = {
        "package_version": PACKAGE_VERSION,
        "model_name": "MessMind dish-demand model",
        "model_version": selection["model_version"],
        "model_type": "RandomForestRegressor (scikit-learn)",
        "task": "Predict how many students will actually eat each dish at one meal (dish-wise, not total attendance).",
        "target": {"name": schema["target"], "type": "int", "range": "[0, total_students]",
                   "note": "interested_taps is an INPUT; actual consumers are the target"},
        "status": {"selection": selection["status"], "frozen_on": selection["frozen_on"],
                   "selected_on": "validation results only (Phases 5-6)"},
        "trained_on": "synthetic",
        "synthetic_data_limitation": (
            "Trained and evaluated ONLY on synthetic data from src/generate_data.py. Metrics show how well the "
            "simulator's rules are learned, not accuracy in a real mess. Retrain and re-test on real exported "
            "records (shared/api_contract.md section 3) before using predictions for real cooking decisions."),
        "hyperparameters": rf_meta["hyperparameters"],
        "random_state": rf_meta["random_state"],
        "features": {"n_features": schema["n_features"], "ordered_names": schema["feature_names"],
                     "groups": schema["feature_groups"], "excluded": schema["excluded"]},
        "input_spec": INPUT_SPEC,
        "training_ranges": training_ranges,
        "preprocessing": {
            "steps": ["engineer: stateless pre-meal features (tap_share, response_rate, projected_interest, "
                      "num_dishes_in_meal, is_new_dish)",
                      "history: GroupMedianImputer - train medians per (dish_category, meal_type) -> meal_type -> overall",
                      "numeric: SimpleImputer(median), fitted on train",
                      "boolean: SimpleImputer(most_frequent), fitted on train",
                      "categorical: SimpleImputer('unknown') + OneHotEncoder(handle_unknown='ignore'), fitted on train",
                      "no scaling (tree model)"],
            "fitted_on": "train split only; never refitted at inference",
        },
        "postprocessing": "round to nearest integer, then clip to [0, total_students]",
        "dataset": {"id": "messmind-synthetic-v1", "data_source": "synthetic",
                    "generator": "src/generate_data.py", "generator_args": generator_args(),
                    "raw_data_md5": schema["raw_data_md5"], "rows": sum(v["rows"] for v in schema["split"].values())},
        "splits": schema["split"],
        "metrics": {
            "train": rf_meta["metrics"]["train"]["random_forest"],
            "validation": {"random_forest": rf_meta["metrics"]["validation"]["random_forest"],
                           "baseline": rf_meta["metrics"]["validation"]["baseline"]},
            "test": {"random_forest_raw": test["random_forest_raw"],
                     "random_forest_rounded_clipped": test["random_forest_api_rounded_clipped"],
                     "baseline": test["baseline"]},
            "test_by_meal_type": final["by_meal_type"]["test"],
            "test_optional_inputs_missing": final["optional_inputs_missing_test"],
            "metric_definitions": {"mae": "mean absolute error (consumers)", "rmse": "root mean squared error",
                                   "r2": "share of variance explained", "bias": "mean(predicted - actual)"},
        },
        "known_limitations": [
            "Exam days not in training: exam-day demand under-predicted (~ -17 to -22 consumers).",
            "Tree model ceiling: demand above the training maximum (830) is under-predicted.",
            "Missing optional inputs (attendance, leftovers, rating) raise MAE to ~42.",
            "Missing historical_dish_demand marks a dish as NEW; known dishes must be sent with their history.",
            "total_students was constant (1000) in training: the model does not know how demand scales with "
            "mess size. Other sizes are only kept valid by clipping (warning: total_students_outside_training_range).",
            "Small evaluation sets (val 182 rows / 13 days, test 215 rows / 14 days).",
        ],
        "baseline_definition": "historical_dish_demand (mean consumers over the dish's last 5 past servings at that meal type)",
        "artifacts": {
            "model": {"path": "models/" + selection["model_file"], "md5": file_md5(MODELS_DIR / selection["model_file"])},
            "preprocessor": {"path": "models/preprocessor.joblib", "md5": file_md5(PREPROCESSOR_PATH),
                             "requires_import": "src.preprocessing (run with ml/ on the Python path)"},
            "feature_schema": {"path": "models/feature_schema.json", "md5": file_md5(SCHEMA_PATH)},
            "selection_record": "models/model_selection.json",
            "training_metadata": "models/random_forest_metadata.json",
            "final_evaluation": "models/final_evaluation.json",
            "reports": ["docs/random_forest_report.md", "docs/final_evaluation_report.md",
                        "docs/preprocessing_report.md"],
        },
        "versions": {"scikit-learn": sklearn.__version__, "pandas": pd.__version__, "numpy": np.__version__,
                     "trained_with": rf_meta["versions"]},
    }
    MODEL_CARD_PATH.write_text(json.dumps(card, indent=2), encoding="utf-8")
    print(f"Model card written: {MODEL_CARD_PATH}")
    print(f"  {card['model_version']} | {card['features']['n_features']} features | "
          f"test MAE {test['random_forest_raw']['mae']:.2f} (synthetic)")


if __name__ == "__main__":
    from src.package_model import main as package_main
    package_main()
