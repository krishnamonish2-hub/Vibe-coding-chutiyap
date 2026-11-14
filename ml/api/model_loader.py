"""Loads the packaged model ONCE and adapts API requests to src/predict.py.

No training, fitting or artifact writing happens here.
"""

from __future__ import annotations

import logging
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

ML_ROOT = Path(__file__).resolve().parents[1]
if str(ML_ROOT) not in sys.path:  # src.* and the pickled preprocessor must be importable
    sys.path.insert(0, str(ML_ROOT))

from src.predict import MessMindPredictor  # noqa: E402

from api.schemas import MealRequest  # noqa: E402

log = logging.getLogger("messmind.api")
DEFAULT_MODELS_DIR = ML_ROOT / "models"
MODELS_DIR_ENV = "MESSMIND_MODELS_DIR"


@dataclass
class ModelService:
    predictor: Optional[MessMindPredictor] = None
    load_error: Optional[str] = None
    extra: dict = field(default_factory=dict)

    @property
    def loaded(self) -> bool:
        return self.predictor is not None

    @classmethod
    def load(cls, models_dir: Optional[Path] = None) -> "ModelService":
        """Load + verify artifacts. Never raises: a failure gives a 'degraded' service (503 on predict)."""
        models_dir = Path(models_dir or os.environ.get(MODELS_DIR_ENV) or DEFAULT_MODELS_DIR)
        try:
            predictor = MessMindPredictor(models_dir=models_dir, verify_checksums=True)
        except Exception as exc:  # any problem: missing file, MD5 mismatch, unpickling error...
            log.error("Model artifacts could not be loaded: %s: %s", type(exc).__name__, exc)
            return cls(predictor=None, load_error=type(exc).__name__)
        log.info("Loaded %s (%d features, trained_on=%s)", predictor.model_version,
                 len(predictor.feature_names), predictor.trained_on)
        return cls(predictor=predictor)

    # ---------------- request adaptation ----------------
    def predict(self, meal: MealRequest) -> dict:
        """Map a validated contract request to the predictor and back to the contract response."""
        record = meal.model_dump(exclude={"meal_id", "dishes"})
        record["dishes"] = [
            {"dish_name": d.dish_name, "dish_category": d.dish_category,
             "interested_taps": d.interested_taps,
             "historical_dish_demand": d.historical_dish_demand,
             "historical_dish_rating": d.historical_dish_rating,
             "previous_leftover_kg": d.previous_leftover_kg}
            for d in meal.dishes
        ]
        out = self.predictor.predict_meal(record)   # raises InputValidationError on bad input
        preds = out["predictions"]
        return {
            "meal_id": meal.meal_id,
            "model_version": out["model_version"],
            "trained_on": out["trained_on"],
            "predictions": [  # predictor keeps input order, so dishes[i] <-> preds[i]
                {"dish_id": d.dish_id, "interested_taps": p["interested_taps"],
                 "predicted_consumers": p["predicted_consumers"], "warnings": p["warnings"]}
                for d, p in zip(meal.dishes, preds)
            ],
        }

    def model_info(self) -> dict:
        p = self.predictor
        card = p.card
        m = card["metrics"]
        return {
            "model_version": p.model_version,
            "model_type": "random_forest",
            "trained_on": p.trained_on,
            "frozen_on": card["status"]["frozen_on"],
            "feature_schema_version": p.schema.get("schema_version", "unknown"),
            "contract_version": "0.3",
            "target": card["target"]["name"],
            "n_features": len(p.feature_names),
            "feature_names": p.feature_names,
            "meal_types": ["breakfast", "lunch", "dinner"],
            "known_dish_categories": sorted(p.known_categories["dish_category"]),
            "known_dish_names": sorted(p.known_categories["dish_name"]),
            "metrics": {"validation_mae": round(m["validation"]["random_forest"]["mae"], 2),
                        "test_mae": round(m["test"]["random_forest_raw"]["mae"], 2),
                        "test_baseline_mae": round(m["test"]["baseline"]["mae"], 2)},
            # Plain-language limitations only (the model card's text names internal files).
            "limitations": ["Trained and evaluated only on SYNTHETIC data: metrics show how well simulated "
                            "patterns are learned, not real-mess accuracy. Retrain on real records before "
                            "using predictions for real cooking decisions.", *card["known_limitations"]],
        }
