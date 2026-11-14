"""API tests for the MessMind ML service (shared/api_contract.md v0.3).

Run from the ml/ folder:
    .\\venv\\Scripts\\python.exe -m pytest
"""

from __future__ import annotations

import copy
import json
import shutil

import pytest
from fastapi.testclient import TestClient

from api.main import create_app
from src.predict import MessMindPredictor

MEAL = {
    "meal_id": "2026-11-16-lunch", "date": "2026-11-16", "meal_type": "lunch",
    "total_students": 1000, "total_responses": 410,
    "is_holiday": False, "is_exam_day": False, "is_festival": False,
    "temperature": 29.5, "rainfall": 0.0, "previous_meal_attendance": 720,
    "dishes": [
        {"dish_id": "D001", "dish_name": "Rice", "dish_category": "staple_rice", "is_veg": True,
         "is_special": False, "interested_taps": 170, "historical_dish_demand": 680.0,
         "historical_dish_rating": 3.8, "previous_leftover_kg": 12.0},
        {"dish_id": "D002", "dish_name": "Chapati", "dish_category": "bread", "is_veg": True,
         "interested_taps": 160, "historical_dish_demand": 630.0, "historical_dish_rating": 3.8,
         "previous_leftover_kg": 9.0},
        {"dish_id": "D003", "dish_name": "Dal Tadka", "dish_category": "dal", "is_veg": True,
         "interested_taps": 140, "historical_dish_demand": 560.0, "historical_dish_rating": 3.6,
         "previous_leftover_kg": 14.0},
        {"dish_id": "D012", "dish_name": "Paneer Butter Masala", "dish_category": "main_veg",
         "is_veg": True, "interested_taps": 230, "historical_dish_demand": 520.0,
         "historical_dish_rating": 4.5, "previous_leftover_kg": 6.0},
        {"dish_id": "D045", "dish_name": "Jeera Aloo", "dish_category": "main_veg", "is_veg": True,
         "interested_taps": 90},
    ],
}


def meal(**changes) -> dict:
    m = copy.deepcopy(MEAL)
    m.update(changes)
    return m


def dish_change(index: int, **changes) -> dict:
    m = copy.deepcopy(MEAL)
    m["dishes"][index].update(changes)
    return m


@pytest.fixture(scope="module")
def client():
    with TestClient(create_app()) as c:      # `with` runs startup -> model loaded once
        yield c


@pytest.fixture(scope="module")
def predictor():
    return MessMindPredictor()


# ---------------------------------------------------------------- health / info
def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "model_loaded": True, "model_version": "rf-v1-synthetic"}


def test_model_info(client):
    r = client.get("/model-info")
    assert r.status_code == 200
    body = r.json()
    assert body["model_type"] == "random_forest"
    assert body["target"] == "actual_dish_consumers"
    assert body["trained_on"] == "synthetic"
    assert body["n_features"] == 69 == len(body["feature_names"])
    assert body["feature_names"][0] == "historical_dish_demand"
    assert "fruit" in body["known_dish_categories"]
    assert body["contract_version"] == "0.3"
    assert abs(body["metrics"]["test_mae"] - 31.44) < 0.01


def test_model_info_exposes_no_paths(client):
    text = client.get("/model-info").text.lower()
    for fragment in (":\\", ":/", "users", "onedrive", ".joblib", "models/", "src/"):
        assert fragment not in text, fragment


# ---------------------------------------------------------------- valid predictions
def test_predict_single_meal(client):
    r = client.post("/predict", json=MEAL)
    assert r.status_code == 200
    body = r.json()
    assert body["meal_id"] == MEAL["meal_id"]
    assert body["model_version"] == "rf-v1-synthetic" and body["trained_on"] == "synthetic"
    assert [p["dish_id"] for p in body["predictions"]] == [d["dish_id"] for d in MEAL["dishes"]]
    for p, d in zip(body["predictions"], MEAL["dishes"]):
        assert set(p) == {"dish_id", "interested_taps", "predicted_consumers", "warnings"}
        assert isinstance(p["predicted_consumers"], int)
        assert 0 <= p["predicted_consumers"] <= MEAL["total_students"]
        assert p["interested_taps"] == d["interested_taps"]


def test_predict_matches_inference_module(client, predictor):
    """The API must give exactly what src/predict.py gives for the same input."""
    api = client.post("/predict", json=MEAL).json()["predictions"]
    record = {k: v for k, v in MEAL.items() if k not in ("meal_id", "dishes")}
    record["dishes"] = [{k: v for k, v in d.items() if k not in ("dish_id", "is_veg", "is_special")}
                        for d in MEAL["dishes"]]
    direct = predictor.predict_meal(record)["predictions"]
    assert [p["predicted_consumers"] for p in api] == [p["predicted_consumers"] for p in direct]
    assert [p["warnings"] for p in api] == [p["warnings"] for p in direct]


def test_predict_is_deterministic(client):
    assert client.post("/predict", json=MEAL).json() == client.post("/predict", json=MEAL).json()


def test_optional_fields_can_be_omitted(client):
    minimal = {"meal_id": "m1", "date": "2026-11-16", "meal_type": "breakfast", "total_students": 1000,
               "total_responses": 300,
               "dishes": [{"dish_id": "T", "dish_name": "Tea", "dish_category": "beverage", "is_veg": True,
                           "interested_taps": 150}]}
    r = client.post("/predict", json=minimal)
    assert r.status_code == 200
    w = r.json()["predictions"][0]["warnings"]
    assert "new_dish_no_history" in w and "imputed:temperature" in w


def test_batch_all_valid(client):
    dinner = meal(meal_id="2026-11-16-dinner", meal_type="dinner")
    r = client.post("/predict/batch", json={"meals": [MEAL, dinner]})
    assert r.status_code == 200
    body = r.json()
    assert body["n_meals"] == 2 and body["n_succeeded"] == 2 and body["n_failed"] == 0
    assert [x["index"] for x in body["results"]] == [0, 1]
    assert body["results"][1]["meal_id"] == "2026-11-16-dinner"
    single = client.post("/predict", json=MEAL).json()
    assert body["results"][0]["prediction"] == single


def test_batch_per_meal_errors(client):
    bad = meal(meal_id="bad-meal", total_students=0)
    r = client.post("/predict/batch", json={"meals": [MEAL, bad, "not a meal"]})
    assert r.status_code == 200
    body = r.json()
    assert (body["n_succeeded"], body["n_failed"]) == (1, 2)
    ok, err, junk = body["results"]
    assert ok["status"] == "ok" and ok["prediction"] is not None
    assert err["status"] == "error" and err["meal_id"] == "bad-meal" and err["prediction"] is None
    assert any("total_students" in e["loc"] for e in err["errors"])
    assert junk["status"] == "error" and junk["meal_id"] is None


@pytest.mark.parametrize("body", [{}, {"meals": []}, {"meals": "x"}, {"meals": [MEAL] * 101}])
def test_batch_malformed_body(client, body):
    assert client.post("/predict/batch", json=body).status_code == 422


# ---------------------------------------------------------------- missing fields
@pytest.mark.parametrize("field", ["meal_id", "date", "meal_type", "total_students", "total_responses", "dishes"])
def test_missing_meal_field(client, field):
    m = meal(); del m[field]
    r = client.post("/predict", json=m)
    assert r.status_code == 422
    assert any(field in e["loc"] for e in r.json()["detail"])


@pytest.mark.parametrize("field", ["dish_id", "dish_name", "dish_category", "is_veg", "interested_taps"])
def test_missing_dish_field(client, field):
    m = meal(); del m["dishes"][0][field]
    assert client.post("/predict", json=m).status_code == 422


def test_empty_dishes_and_unknown_field(client):
    assert client.post("/predict", json=meal(dishes=[])).status_code == 422
    assert client.post("/predict", json=dish_change(0, historical_demand=600)).status_code == 422  # typo


# ---------------------------------------------------------------- invalid numbers / types
@pytest.mark.parametrize("raw", ["NaN", "Infinity", "-Infinity"])
def test_nan_and_infinity_rejected(client, raw):
    text = json.dumps(MEAL).replace('"temperature": 29.5', f'"temperature": {raw}')
    r = client.post("/predict", content=text, headers={"Content-Type": "application/json"})
    assert r.status_code == 422
    assert any("temperature" in e["loc"] for e in r.json()["detail"])


@pytest.mark.parametrize("changes", [
    {"interested_taps": -1}, {"interested_taps": 411},              # < 0, > total_responses
    {"interested_taps": "170"}, {"interested_taps": 170.5}, {"interested_taps": True},
    {"historical_dish_demand": -5.0}, {"historical_dish_rating": 7.0}, {"historical_dish_rating": 0.5},
    {"previous_leftover_kg": -1.0}, {"historical_dish_demand": "lots"}, {"is_veg": "yes"},
])
def test_invalid_dish_values(client, changes):
    assert client.post("/predict", json=dish_change(0, **changes)).status_code == 422


@pytest.mark.parametrize("changes", [
    {"total_responses": 1001}, {"total_responses": -1}, {"rainfall": -2.0}, {"temperature": 99.0},
    {"previous_meal_attendance": 1001}, {"meal_type": "snacks"}, {"date": "16/11/2026"},
    {"date": "2026-02-30"}, {"is_holiday": 1}, {"meal_id": ""},
])
def test_invalid_meal_values(client, changes):
    assert client.post("/predict", json=meal(**changes)).status_code == 422


def test_duplicate_dishes_rejected(client):
    m = meal(); m["dishes"][1]["dish_id"] = "D001"
    assert client.post("/predict", json=m).status_code == 422
    m = meal(); m["dishes"][1]["dish_name"] = "Rice"
    assert client.post("/predict", json=m).status_code == 422


def test_malformed_json_body(client):
    r = client.post("/predict", content="{not json", headers={"Content-Type": "application/json"})
    assert r.status_code == 422


# ---------------------------------------------------------------- total_students
@pytest.mark.parametrize("value", [0, -10, 999.5, "1000", None])
def test_invalid_total_students(client, value):
    m = meal(total_students=value, total_responses=0)
    for d in m["dishes"]:
        d["interested_taps"] = 0
    r = client.post("/predict", json=m)
    assert r.status_code == 422
    assert any("total_students" in e["loc"] for e in r.json()["detail"])


# ---------------------------------------------------------------- unseen categories
def test_unseen_dish_and_category(client):
    m = dish_change(4, dish_name="Momos", dish_category="street_food")
    r = client.post("/predict", json=m)
    assert r.status_code == 200
    w = r.json()["predictions"][4]["warnings"]
    assert "unseen_dish" in w and "unseen_dish_category" in w


# ---------------------------------------------------------------- bounds
def test_predictions_within_bounds_small_mess(client):
    m = meal(total_students=50, total_responses=50, previous_meal_attendance=40)
    for d in m["dishes"]:
        d["interested_taps"] = 50
    r = client.post("/predict", json=m)
    assert r.status_code == 200
    for p in r.json()["predictions"]:
        assert 0 <= p["predicted_consumers"] <= 50
        assert "total_students_outside_training_range" in p["warnings"]
    assert any("clipped_to_valid_range" in p["warnings"] for p in r.json()["predictions"])


@pytest.mark.parametrize("taps,responses", [(0, 0), (1000, 1000), (1, 1000)])
def test_predictions_within_bounds_extremes(client, taps, responses):
    m = meal(total_responses=responses)
    for d in m["dishes"]:
        d["interested_taps"] = taps
    r = client.post("/predict", json=m)
    assert r.status_code == 200
    assert all(0 <= p["predicted_consumers"] <= 1000 for p in r.json()["predictions"])


# ---------------------------------------------------------------- artifact loading failures
def _degraded_checks(c: TestClient):
    h = c.get("/health")
    assert h.status_code == 200
    assert h.json() == {"status": "degraded", "model_loaded": False, "model_version": None}
    for method, url, kw in [("get", "/model-info", {}), ("post", "/predict", {"json": MEAL}),
                            ("post", "/predict/batch", {"json": {"meals": [MEAL]}})]:
        r = getattr(c, method)(url, **kw)
        assert r.status_code == 503 and r.json() == {"detail": "model not loaded"}
        assert "users" not in r.text.lower()


def test_missing_artifacts_gives_503(tmp_path):
    with TestClient(create_app(models_dir=tmp_path)) as c:     # empty folder: nothing to load
        _degraded_checks(c)


def test_tampered_artifact_gives_503(tmp_path):
    from src.evaluation import MODELS_DIR
    for name in ("model_card.json", "feature_schema.json", "random_forest.joblib"):
        shutil.copy(MODELS_DIR / name, tmp_path / name)
    (tmp_path / "preprocessor.joblib").write_bytes(b"not the real preprocessor")   # checksum mismatch
    with TestClient(create_app(models_dir=tmp_path)) as c:
        _degraded_checks(c)


def test_env_var_selects_models_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("MESSMIND_MODELS_DIR", str(tmp_path))
    with TestClient(create_app()) as c:
        assert c.get("/health").json()["model_loaded"] is False
