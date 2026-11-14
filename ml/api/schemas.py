"""Request / response models — a direct translation of shared/api_contract.md v0.3.

Validation here is the FIRST layer (types, required fields, ranges, cross-field rules).
src/predict.py validates again before predicting (second layer), so the model never sees bad input.
"""

from __future__ import annotations

import datetime as dt
from typing import Annotated, Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

CONTRACT_VERSION = "0.3"

# Strict types: integers must be JSON integers, booleans JSON true/false, numbers finite.
Int = Annotated[int, Field(strict=True)]
Bool = Annotated[bool, Field(strict=True)]
FiniteFloat = Annotated[float, Field(strict=True, allow_inf_nan=False)]
NonEmptyStr = Annotated[str, Field(strict=True, min_length=1, max_length=100)]


class _Strict(BaseModel):
    # Unknown fields are rejected so a typo (e.g. "historical_demand") cannot silently drop history.
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class DishIn(_Strict):
    dish_id: NonEmptyStr
    dish_name: NonEmptyStr
    dish_category: NonEmptyStr
    is_veg: Bool
    is_special: Bool = False
    interested_taps: Annotated[Int, Field(ge=0)]
    historical_dish_demand: Optional[Annotated[FiniteFloat, Field(ge=0)]] = None
    historical_dish_rating: Optional[Annotated[FiniteFloat, Field(ge=1, le=5)]] = None
    previous_leftover_kg: Optional[Annotated[FiniteFloat, Field(ge=0)]] = None


class MealRequest(_Strict):
    meal_id: NonEmptyStr
    date: Annotated[str, Field(strict=True, pattern=r"^\d{4}-\d{2}-\d{2}$",
                               description="YYYY-MM-DD", examples=["2026-11-16"])]
    meal_type: Literal["breakfast", "lunch", "dinner"]
    total_students: Annotated[Int, Field(gt=0)]
    total_responses: Annotated[Int, Field(ge=0)]
    is_holiday: Bool = False
    is_exam_day: Bool = False
    is_festival: Bool = False
    temperature: Optional[Annotated[FiniteFloat, Field(ge=-30, le=60)]] = None
    rainfall: Optional[Annotated[FiniteFloat, Field(ge=0)]] = None
    previous_meal_attendance: Optional[Annotated[Int, Field(ge=0)]] = None
    dishes: Annotated[list[DishIn], Field(min_length=1, max_length=30)]

    @field_validator("date")
    @classmethod
    def real_calendar_date(cls, v: str) -> str:
        try:
            dt.date.fromisoformat(v)
        except ValueError:
            raise ValueError(f"'{v}' is not a real calendar date")
        return v

    @model_validator(mode="after")
    def cross_field_rules(self) -> "MealRequest":
        problems = []
        if self.total_responses > self.total_students:
            problems.append("total_responses must be <= total_students")
        if self.previous_meal_attendance is not None and self.previous_meal_attendance > self.total_students:
            problems.append("previous_meal_attendance must be <= total_students")
        for i, d in enumerate(self.dishes):
            if d.interested_taps > self.total_responses:
                problems.append(f"dishes[{i}].interested_taps must be <= total_responses")
        ids = [d.dish_id for d in self.dishes]
        names = [d.dish_name for d in self.dishes]
        if len(set(ids)) != len(ids):
            problems.append("dish_id values must be unique within a meal")
        if len(set(names)) != len(names):
            problems.append("dish_name values must be unique within a meal")
        if problems:
            raise ValueError("; ".join(problems))
        return self

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, json_schema_extra={"examples": [{
        "meal_id": "2026-11-16-lunch", "date": "2026-11-16", "meal_type": "lunch",
        "total_students": 1000, "total_responses": 410, "is_holiday": False, "is_exam_day": False,
        "is_festival": False, "temperature": 29.5, "rainfall": 0.0, "previous_meal_attendance": 720,
        "dishes": [
            {"dish_id": "D001", "dish_name": "Rice", "dish_category": "staple_rice", "is_veg": True,
             "is_special": False, "interested_taps": 170, "historical_dish_demand": 680.0,
             "historical_dish_rating": 3.8, "previous_leftover_kg": 12.0},
            {"dish_id": "D045", "dish_name": "Jeera Aloo", "dish_category": "main_veg", "is_veg": True,
             "interested_taps": 90}]}]})


# ---------------- responses ----------------
class DishPrediction(BaseModel):
    dish_id: str
    interested_taps: int
    predicted_consumers: int
    warnings: list[str]


class MealResponse(BaseModel):
    meal_id: str
    model_version: str
    trained_on: str
    predictions: list[DishPrediction]


class BatchRequest(BaseModel):
    # Items are validated one by one in the route, so one bad meal cannot reject the whole batch.
    meals: Annotated[list[Any], Field(min_length=1, max_length=100)]


class ErrorItem(BaseModel):
    loc: list[str | int]
    msg: str
    type: str = "value_error"


class BatchItemResult(BaseModel):
    index: int
    meal_id: Optional[str]
    status: Literal["ok", "error"]
    prediction: Optional[MealResponse] = None
    errors: Optional[list[ErrorItem]] = None


class BatchResponse(BaseModel):
    model_version: str
    trained_on: str
    n_meals: int
    n_succeeded: int
    n_failed: int
    results: list[BatchItemResult]


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    model_loaded: bool
    model_version: Optional[str]


class ModelInfoResponse(BaseModel):
    model_version: str
    model_type: str
    trained_on: str
    frozen_on: str
    feature_schema_version: str
    contract_version: str
    target: str
    n_features: int
    feature_names: list[str]
    meal_types: list[str]
    known_dish_categories: list[str]
    known_dish_names: list[str]
    metrics: dict[str, float]
    limitations: list[str]
