"""HTTP endpoints (shared/api_contract.md v0.3)."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import ValidationError

from api.model_loader import ModelService
from api.schemas import (BatchItemResult, BatchRequest, BatchResponse, HealthResponse, MealRequest,
                         MealResponse, ModelInfoResponse)
from src.predict import InputValidationError

log = logging.getLogger("messmind.api")
router = APIRouter()


def _service(request: Request) -> ModelService:
    return request.app.state.service


def _require_model(request: Request) -> ModelService:
    svc = _service(request)
    if not svc.loaded:
        raise HTTPException(status_code=503, detail="model not loaded")
    return svc


def clean_pydantic_errors(exc: ValidationError) -> list[dict]:
    """Pydantic errors without the raw input (may contain NaN or large payloads) or internals."""
    return [{"loc": [p for p in e["loc"] if p != "body"], "msg": e["msg"], "type": e["type"]}
            for e in exc.errors()]


def predictor_errors(exc: InputValidationError) -> list[dict]:
    return [{"loc": [], "msg": m, "type": "value_error"} for m in exc.errors]


@router.get("/health", response_model=HealthResponse, tags=["service"])
def health(request: Request):
    svc = _service(request)
    return {"status": "ok" if svc.loaded else "degraded", "model_loaded": svc.loaded,
            "model_version": svc.predictor.model_version if svc.loaded else None}


@router.get("/model-info", response_model=ModelInfoResponse, tags=["service"])
def model_info(request: Request):
    return _require_model(request).model_info()


@router.post("/predict", response_model=MealResponse, tags=["prediction"])
def predict(meal: MealRequest, request: Request):
    """Predict actual consumers for every dish of ONE meal."""
    svc = _require_model(request)
    try:
        return svc.predict(meal)
    except InputValidationError as exc:
        raise HTTPException(status_code=422, detail=predictor_errors(exc))


@router.post("/predict/batch", response_model=BatchResponse, tags=["prediction"])
def predict_batch(batch: BatchRequest, request: Request):
    """Predict several meals. Each meal is validated independently (per-meal results and errors)."""
    svc = _require_model(request)
    results = []
    for i, raw in enumerate(batch.meals):
        if not isinstance(raw, dict):
            results.append(BatchItemResult(index=i, meal_id=None, status="error",
                                           errors=[{"loc": [], "msg": "meal must be a JSON object"}]))
            continue
        meal_id = raw.get("meal_id") if isinstance(raw.get("meal_id"), str) else None
        try:
            meal = MealRequest.model_validate(raw)
            results.append(BatchItemResult(index=i, meal_id=meal.meal_id, status="ok",
                                           prediction=svc.predict(meal)))
        except ValidationError as exc:
            results.append(BatchItemResult(index=i, meal_id=meal_id, status="error",
                                           errors=clean_pydantic_errors(exc)))
        except InputValidationError as exc:
            results.append(BatchItemResult(index=i, meal_id=meal_id, status="error",
                                           errors=predictor_errors(exc)))
    ok = sum(r.status == "ok" for r in results)
    return {"model_version": svc.predictor.model_version, "trained_on": svc.predictor.trained_on,
            "n_meals": len(results), "n_succeeded": ok, "n_failed": len(results) - ok, "results": results}
