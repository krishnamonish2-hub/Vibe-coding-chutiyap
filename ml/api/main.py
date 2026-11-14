"""FastAPI application setup.

Start (from the ml/ folder):
    .\\venv\\Scripts\\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8001
Docs: http://127.0.0.1:8001/docs

Optional env var MESSMIND_MODELS_DIR points the service at another folder with the packaged artifacts.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from api.model_loader import ModelService
from api.routes import router
from api.schemas import CONTRACT_VERSION

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("messmind.api")


def create_app(models_dir: Optional[Path] = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.service = ModelService.load(models_dir)   # load ONCE at startup
        yield

    app = FastAPI(
        title="MessMind ML Prediction API",
        version=CONTRACT_VERSION,
        description=("Predicts how many students will actually eat each dish of a meal. "
                     "Implements shared/api_contract.md v0.3. Model trained on SYNTHETIC data."),
        lifespan=lifespan,
    )

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError):
        # Same shape as FastAPI's default, minus the raw input (could hold NaN, which breaks JSON).
        detail = [{"loc": [p for p in e["loc"] if p != "body"], "msg": e["msg"], "type": e["type"]}
                  for e in exc.errors()]
        return JSONResponse(status_code=422, content={"detail": detail})

    @app.exception_handler(Exception)
    async def unexpected_error(_: Request, exc: Exception):
        log.exception("Unhandled error: %s", exc)            # details go to the server log only
        return JSONResponse(status_code=500, content={"detail": "internal error"})

    app.include_router(router)
    return app


app = create_app()
