"""Keeps docs/integration_handoff.md and shared/api_contract.md honest.

Every example in the handoff marked with
    <!-- example id=<id> [part=request] method=<GET|POST> path=<path> [status=<code>] [server=degraded] -->
is re-sent to the real API, and the response must match the document exactly.
The contract's own /health and /predict examples (v0.3 sections 2.1 and 2.3) are checked too.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api.main import create_app

ML_ROOT = Path(__file__).resolve().parents[1]
HANDOFF = ML_ROOT / "docs" / "integration_handoff.md"
CONTRACT = ML_ROOT.parent / "shared" / "api_contract.md"
MARKER = re.compile(r"<!-- example (?P<attrs>[^>]*?) -->\s*```(?P<lang>\w*)\n(?P<body>.*?)\n```", re.S)


def parse_examples(text: str) -> dict[str, dict]:
    """{id: {"request": (attrs, body) | None, "response": (attrs, body)}}"""
    out: dict[str, dict] = {}
    for m in MARKER.finditer(text):
        attrs = dict(kv.split("=", 1) for kv in m["attrs"].split())
        slot = out.setdefault(attrs["id"], {"request": None, "response": None})
        slot["request" if attrs.get("part") == "request" else "response"] = (attrs, m["body"])
    return out


def send(client: TestClient, attrs: dict, request_body: str | None):
    if attrs["method"] == "GET":
        return client.get(attrs["path"])
    return client.post(attrs["path"], content=request_body,
                       headers={"Content-Type": "application/json"})


@pytest.fixture(scope="module")
def clients(tmp_path_factory):
    empty = tmp_path_factory.mktemp("no_models")
    with TestClient(create_app()) as ok, TestClient(create_app(models_dir=empty)) as degraded:
        yield {"ok": ok, "degraded": degraded}


EXAMPLES = parse_examples(HANDOFF.read_text(encoding="utf-8"))


def test_handoff_has_examples():
    assert len(EXAMPLES) >= 14
    assert all(v["response"] is not None for v in EXAMPLES.values()), "every example needs a response block"


@pytest.mark.parametrize("example_id", sorted(EXAMPLES))
def test_handoff_example_matches_api(clients, example_id):
    ex = EXAMPLES[example_id]
    attrs, expected = ex["response"]
    client = clients["degraded" if attrs.get("server") == "degraded" else "ok"]
    request_body = ex["request"][1] if ex["request"] else None
    r = send(client, attrs, request_body)
    assert r.status_code == int(attrs["status"])
    assert r.json() == json.loads(expected), f"docs example '{example_id}' is out of date"


def _contract_json_blocks(section_heading: str) -> list[dict]:
    text = CONTRACT.read_text(encoding="utf-8")
    section = text.split(section_heading, 1)[1].split("\n### ", 1)[0]
    return [json.loads(b) for b in re.findall(r"```json\n(.*?)\n```", section, re.S)]


def test_contract_v03_predict_example_matches_api(clients):
    request, response = _contract_json_blocks("### 2.3 `POST /predict`")[:2]
    r = clients["ok"].post("/predict", json=request)
    assert r.status_code == 200
    assert r.json() == response


def test_contract_v03_health_example_matches_api(clients):
    assert clients["ok"].get("/health").json() == _contract_json_blocks("### 2.1 `GET /health`")[0]


def test_contract_v03_model_info_keys_match_api(clients):
    text = CONTRACT.read_text(encoding="utf-8").split("### 2.2 `GET /model-info`", 1)[1].split("\n### ", 1)[0]
    contract_keys = re.findall(r'^\s{2}"(\w+)":', text, re.M)
    assert contract_keys == list(clients["ok"].get("/model-info").json())
