"""MessMind inference module — load the frozen model once, validate raw input, predict.

Usage (from the ml/ folder, or anywhere with ml/ on the Python path):

    from src.predict import MessMindPredictor
    predictor = MessMindPredictor()                 # loads + verifies artifacts once
    result = predictor.predict_meal({
        "date": "2026-11-16", "meal_type": "lunch", "total_students": 1000, "total_responses": 410,
        "dishes": [{"dish_name": "Rice", "dish_category": "staple_rice", "interested_taps": 160,
                    "historical_dish_demand": 650.0}, ...],
    })

Guarantees
----------
* Uses the SAVED, train-fitted preprocessing pipeline. Nothing is fitted or refitted here.
* Feature names and order are checked against the frozen schema on every call.
* Output is a whole number of students in [0, total_students] (round, then clip).
* Invalid input raises InputValidationError listing every problem (nothing is silently dropped).
* Unseen dishes / categories are accepted and reported in `warnings`.

This module has no FastAPI/Pydantic dependency so it can be reused by the API, scripts and tests.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import re
import sys
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pandas as pd

ML_ROOT = Path(__file__).resolve().parents[1]
if str(ML_ROOT) not in sys.path:          # the pickled preprocessor imports `src.preprocessing`
    sys.path.insert(0, str(ML_ROOT))

import joblib  # noqa: E402

from src.evaluation import file_md5  # noqa: E402

DEFAULT_MODELS_DIR = ML_ROOT / "models"
MEAL_TYPES = ("breakfast", "lunch", "dinner")
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
REQUIRED = ("date", "meal_type", "dish_name", "dish_category", "total_students", "total_responses",
            "interested_taps")
OPTIONAL_NUMERIC = ("temperature", "rainfall", "previous_meal_attendance", "historical_dish_demand",
                    "historical_dish_rating", "previous_leftover_kg")
OPTIONAL_BOOL = ("is_holiday", "is_exam_day", "is_festival")
MEAL_LEVEL = ("date", "meal_type", "total_students", "total_responses", "is_holiday", "is_exam_day",
              "is_festival", "temperature", "rainfall", "previous_meal_attendance")


class InputValidationError(ValueError):
    """Raised when raw input is invalid. `.errors` lists every problem found."""

    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__("Invalid prediction input:\n  - " + "\n  - ".join(errors))


class ArtifactError(RuntimeError):
    """Raised when model artifacts are missing, changed, or inconsistent."""


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def _is_missing(v: Any) -> bool:
    return v is None or (isinstance(v, float) and math.isnan(v))


def _as_number(v: Any, field: str, row: int, errors: list[str], integer: bool = False):
    if isinstance(v, bool) or not isinstance(v, (int, float, np.integer, np.floating)):
        errors.append(f"dish {row}: '{field}' must be a number, got {v!r}")
        return None
    v = float(v)
    if not math.isfinite(v):
        errors.append(f"dish {row}: '{field}' must be finite, got {v}")
        return None
    if integer and not v.is_integer():
        errors.append(f"dish {row}: '{field}' must be a whole number, got {v}")
        return None
    return v


def _as_bool(v: Any, field: str, row: int, errors: list[str]):
    if isinstance(v, (bool, np.bool_)):
        return bool(v)
    if isinstance(v, (int, np.integer)) and v in (0, 1):
        return bool(v)
    errors.append(f"dish {row}: '{field}' must be true/false, got {v!r}")
    return None


# ---------------------------------------------------------------------------
# Predictor
# ---------------------------------------------------------------------------
class MessMindPredictor:
    def __init__(self, models_dir: Path | str = DEFAULT_MODELS_DIR, verify_checksums: bool = True):
        self.models_dir = Path(models_dir)
        card_path = self.models_dir / "model_card.json"
        if not card_path.exists():
            raise ArtifactError(f"{card_path} not found - run `python -m src.package_model` first.")
        self.card = json.loads(card_path.read_text(encoding="utf-8"))
        arts = self.card["artifacts"]

        for key in ("model", "preprocessor", "feature_schema"):
            path = self._artifact(arts[key])
            if not path.exists():
                raise ArtifactError(f"missing artifact: {path}")
            if verify_checksums and file_md5(path) != arts[key]["md5"]:
                raise ArtifactError(f"{path.name} does not match the packaged (frozen) version (MD5 mismatch)")

        self.model = joblib.load(self._artifact(arts["model"]))
        self.preprocessor = joblib.load(self._artifact(arts["preprocessor"]))
        self.schema = json.loads((self._artifact(arts["feature_schema"])).read_text(encoding="utf-8"))
        self.feature_names: list[str] = self.schema["feature_names"]

        pre_out = list(self.preprocessor.named_steps["columns"].get_feature_names_out())
        if not (pre_out == self.feature_names == list(self.model.feature_names_in_)
                == self.card["features"]["ordered_names"]):
            raise ArtifactError("feature names/order differ between preprocessor, schema, model and model card")

        encoder = self.preprocessor.named_steps["columns"].named_transformers_["categorical"].named_steps["onehot"]
        cats = dict(zip(["meal_type", "dish_category", "dish_name"], encoder.categories_))
        self.known_categories = {k: set(map(str, v)) for k, v in cats.items()}
        rng = self.card["training_ranges"]["total_students"]
        self.total_students_range = (rng["min"], rng["max"])
        self.model_version: str = self.card["model_version"]
        self.trained_on: str = self.card["trained_on"]

    def _artifact(self, entry: dict) -> Path:
        """Artifact files live next to model_card.json (the card stores 'models/<file>')."""
        return self.models_dir / Path(entry["path"]).name

    # ---------------- public API ----------------
    def predict_meal(self, meal: dict) -> dict:
        """Predict every dish of ONE meal. Meal-level fields + a `dishes` list (like the API request)."""
        if not isinstance(meal, dict) or not isinstance(meal.get("dishes"), list) or not meal["dishes"]:
            raise InputValidationError(["meal must be an object with a non-empty 'dishes' list"])
        shared = {k: meal[k] for k in MEAL_LEVEL if k in meal}
        records = []
        for d in meal["dishes"]:
            if not isinstance(d, dict):
                raise InputValidationError(["every item in 'dishes' must be an object"])
            clash = [k for k in MEAL_LEVEL if k in d and k in shared and d[k] != shared[k]]
            if clash:
                raise InputValidationError([f"dish '{d.get('dish_name')}' overrides meal-level fields {clash}"])
            records.append({**shared, **d})
        out = self.predict_records(records)
        return {"meal_type": meal.get("meal_type"), "date": meal.get("date"),
                "model_version": self.model_version, "trained_on": self.trained_on, "predictions": out}

    def predict_records(self, records: Iterable[dict]) -> list[dict]:
        """Predict a list of flat per-dish records (may contain several meals)."""
        df, warnings = self.validate(list(records))
        X = self.preprocessor.transform(df)                       # transform only - never fit
        if list(X.columns) != self.feature_names:
            raise ArtifactError("transformed feature order does not match the schema")
        if not np.isfinite(X.to_numpy(dtype=float)).all():
            raise ArtifactError("non-finite value after preprocessing")

        raw = self.model.predict(X)
        total = df["total_students"].to_numpy(dtype=float)
        final = np.clip(np.rint(raw), 0, total)

        if not (np.isfinite(raw).all() and np.isfinite(final).all()):
            raise ArtifactError("model produced a non-finite prediction")
        if ((final < 0) | (final > total)).any():
            raise ArtifactError("prediction outside [0, total_students] after post-processing")

        results = []
        for i, rec in enumerate(df.itertuples(index=False)):
            w = list(warnings[i])
            if raw[i] < 0 or raw[i] > total[i]:
                w.append("clipped_to_valid_range")
            results.append({"dish_name": rec.dish_name, "meal_type": rec.meal_type,
                            "date": rec.date.strftime("%Y-%m-%d"),
                            "interested_taps": int(rec.interested_taps),
                            "predicted_consumers": int(final[i]),
                            "raw_prediction": round(float(raw[i]), 2),
                            "warnings": w})
        return results

    # ---------------- validation ----------------
    def validate(self, records: list[dict]) -> tuple[pd.DataFrame, list[list[str]]]:
        """Check raw records and build the exact DataFrame the saved pipeline expects."""
        if not records:
            raise InputValidationError(["no records given"])
        errors: list[str] = []
        rows, warnings = [], []
        for i, rec in enumerate(records):
            w: list[str] = []
            missing = [f for f in REQUIRED if f not in rec or _is_missing(rec[f])]
            if missing:
                errors.append(f"dish {i}: missing required field(s) {missing}")
                rows.append(None); warnings.append(w)
                continue
            row: dict[str, Any] = {}

            # Strict ISO date: pandas alone would also accept ambiguous forms like 16/11/2026.
            d = rec["date"]
            if isinstance(d, (dt.date, pd.Timestamp)):
                row["date"] = pd.Timestamp(d).normalize()
            elif isinstance(d, str) and ISO_DATE.match(d.strip()):
                try:
                    row["date"] = pd.Timestamp(dt.date.fromisoformat(d.strip()))
                except ValueError:
                    row["date"] = None
            else:
                row["date"] = None
            if row["date"] is None:
                errors.append(f"dish {i}: 'date' must be a valid YYYY-MM-DD date, got {d!r}")

            mt = rec["meal_type"]
            if mt not in MEAL_TYPES:
                errors.append(f"dish {i}: 'meal_type' must be one of {list(MEAL_TYPES)}, got {mt!r}")
            row["meal_type"] = mt

            for field in ("dish_name", "dish_category"):
                v = rec[field]
                if not isinstance(v, str) or not v.strip():
                    errors.append(f"dish {i}: '{field}' must be a non-empty string")
                row[field] = v.strip() if isinstance(v, str) else v
            if isinstance(row["dish_name"], str) and row["dish_name"] not in self.known_categories["dish_name"]:
                w.append("unseen_dish")
            if isinstance(row["dish_category"], str) and row["dish_category"] not in self.known_categories["dish_category"]:
                w.append("unseen_dish_category")

            ts = _as_number(rec["total_students"], "total_students", i, errors, integer=True)
            tr = _as_number(rec["total_responses"], "total_responses", i, errors, integer=True)
            tp = _as_number(rec["interested_taps"], "interested_taps", i, errors, integer=True)
            if ts is not None and ts <= 0:
                errors.append(f"dish {i}: 'total_students' must be > 0, got {ts:g}")
            if tr is not None and ts is not None and not (0 <= tr <= ts):
                errors.append(f"dish {i}: 'total_responses' must be in [0, total_students], got {tr:g}")
            if tp is not None and tr is not None and not (0 <= tp <= tr):
                errors.append(f"dish {i}: 'interested_taps' must be in [0, total_responses], got {tp:g}")
            if tr == 0:
                w.append("no_app_responses")
            lo, hi = self.total_students_range
            if ts is not None and ts > 0 and not (lo <= ts <= hi):
                w.append("total_students_outside_training_range")
            row.update(total_students=ts, total_responses=tr, interested_taps=tp)

            for field in OPTIONAL_BOOL:
                v = rec.get(field)
                row[field] = False if _is_missing(v) else _as_bool(v, field, i, errors)

            for field in OPTIONAL_NUMERIC:
                v = rec.get(field)
                if _is_missing(v):
                    row[field] = np.nan
                    if field == "historical_dish_demand":
                        w.append("new_dish_no_history")
                    else:
                        w.append(f"imputed:{field}")
                    continue
                row[field] = _as_number(v, field, i, errors)
            self._check_ranges(row, i, errors)

            # day_of_week / is_weekend: derived from date; if given they must agree with it
            if row["date"] is not None:
                dow = int(row["date"].day_of_week)
                if "day_of_week" in rec and not _is_missing(rec["day_of_week"]) and rec["day_of_week"] != dow:
                    errors.append(f"dish {i}: 'day_of_week'={rec['day_of_week']} does not match date ({dow})")
                if "is_weekend" in rec and not _is_missing(rec["is_weekend"]) and bool(rec["is_weekend"]) != (dow >= 5):
                    errors.append(f"dish {i}: 'is_weekend' does not match date")
                row["day_of_week"], row["is_weekend"] = dow, dow >= 5
            rows.append(row)
            warnings.append(w)

        if errors:
            raise InputValidationError(errors)

        df = pd.DataFrame(rows)
        meal = df.groupby(["date", "meal_type"])
        if meal["dish_name"].apply(lambda s: s.duplicated().any()).any():
            raise InputValidationError(["the same dish_name appears twice in one meal"])
        for col in ("total_students", "total_responses"):
            if (meal[col].nunique() > 1).any():
                raise InputValidationError([f"'{col}' must be identical for every dish of a meal"])

        for col in ("total_students", "total_responses", "interested_taps", "day_of_week"):
            df[col] = df[col].astype(int)
        for col in OPTIONAL_BOOL + ("is_weekend",):
            df[col] = df[col].astype(bool)
        for col in OPTIONAL_NUMERIC:
            df[col] = df[col].astype(float)
        return df, warnings

    @staticmethod
    def _check_ranges(row: dict, i: int, errors: list[str]) -> None:
        def v(k):
            x = row.get(k)
            return None if x is None or (isinstance(x, float) and math.isnan(x)) else x
        ts = row.get("total_students")
        if v("temperature") is not None and not (-30 <= v("temperature") <= 60):
            errors.append(f"dish {i}: 'temperature' must be in [-30, 60] degC")
        if v("rainfall") is not None and v("rainfall") < 0:
            errors.append(f"dish {i}: 'rainfall' must be >= 0")
        if v("previous_meal_attendance") is not None and ts and not (0 <= v("previous_meal_attendance") <= ts):
            errors.append(f"dish {i}: 'previous_meal_attendance' must be in [0, total_students]")
        if v("historical_dish_demand") is not None and v("historical_dish_demand") < 0:
            errors.append(f"dish {i}: 'historical_dish_demand' must be >= 0")
        if v("historical_dish_rating") is not None and not (1 <= v("historical_dish_rating") <= 5):
            errors.append(f"dish {i}: 'historical_dish_rating' must be in [1, 5]")
        if v("previous_leftover_kg") is not None and v("previous_leftover_kg") < 0:
            errors.append(f"dish {i}: 'previous_leftover_kg' must be >= 0")

    def info(self) -> dict:
        """Short summary (for /health or /model-info in the API)."""
        return {"model_version": self.model_version, "model_type": self.card["model_type"],
                "trained_on": self.trained_on, "n_features": len(self.feature_names),
                "test_mae": self.card["metrics"]["test"]["random_forest_raw"]["mae"]}
