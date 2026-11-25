"""Hostable AirWrite website: letters + gestures on one page.

The browser talks to the sensor over Web Bluetooth, reconstructs pen motion,
and submits finished character images for multilingual CNN classification.
The gesture model and live sensor data stay in their existing browser paths.

Run locally:  uvicorn web_app:app --port 8000   then open http://localhost:8000
"""
import asyncio
import base64
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator

from config import IMAGE_HF_REPO, IMAGE_MODEL_PATH
from recognition.multilingual_image import MAX_IMAGE_BYTES, MultilingualImageClassifier, decode_png_data_url
from web_watch import WatchHub

ROOT = Path(__file__).parent
WEB_DIR = ROOT / "web"
GESTURE_FILES = {"core.js": "text/javascript", "model.json": "application/json"}
MAX_WATCH_BATCH = 500
MAX_IMAGE_DATA_URL_LENGTH = ((MAX_IMAGE_BYTES + 2) // 3) * 4 + len("data:image/png;base64,")

logger = logging.getLogger("airwrite.web")
image_classifier = MultilingualImageClassifier(IMAGE_MODEL_PATH, IMAGE_HF_REPO)
letters_status: dict = {"state": "loading", "detail": ""}
watch_hub = WatchHub()


def load_letters_model() -> None:
    """Load the image classifier once during application startup."""
    try:
        image_classifier.load()
        letters_status.update(state="ready", detail="", model="airwrite-multilingual-74")
    except Exception as exc:  # never take the site down because of the model
        logger.error("Letters model unavailable: %s", exc)
        letters_status.update(state="unavailable", detail=str(exc), model="airwrite-multilingual-74")


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(asyncio.to_thread(load_letters_model))
    yield
    task.cancel()


app = FastAPI(title="AirWrite", lifespan=lifespan, docs_url=None, redoc_url=None)


@app.middleware("http")
async def always_fresh_site_files(request: Request, call_next):
    """Make browsers check for a newer page/script on every load, so an update
    shows up without a hard refresh. Unchanged files still come back as a
    cheap "304 Not Modified"."""
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


class LetterRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    image: str = Field(min_length=32, max_length=MAX_IMAGE_DATA_URL_LENGTH, strict=True)
    mode: Literal["auto", "english", "arabic", "numbers"] = "auto"

    @field_validator("image")
    @classmethod
    def png_data_url(cls, value):
        if not value.startswith("data:image/png;base64,"):
            raise ValueError("image must be a base64-encoded PNG data URL")
        return value


@app.get("/api/health")
async def health():
    return {
        "letters": dict(letters_status),
        "image_model": {"state": letters_status["state"], "name": "airwrite-multilingual-74"},
        "gestures": {"state": "ready"},
    }


@app.post("/api/letters/predict")
async def predict_letter(req: LetterRequest):
    if letters_status["state"] != "ready":
        detail = letters_status.get("detail") or "Multilingual image model is not ready"
        raise HTTPException(503, f"Letter recognition is unavailable: {detail}")
    try:
        png = decode_png_data_url(req.image)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    try:
        result = await asyncio.to_thread(image_classifier.predict_png, png, req.mode)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except RuntimeError as exc:
        logger.error("Multilingual image prediction failed: %s", exc)
        raise HTTPException(503, str(exc)) from exc
    return {
        "prediction": result["prediction"],
        "class_id": result["class_id"],
        "mode": result["mode"],
        "score": result["score"],
        "top3": result["top3"],
        "inference_ms": result["inference_ms"],
        "model": result["model"],
        "score_normalization": result["score_normalization"],
        "preview": "data:image/png;base64," + base64.b64encode(result["preview_png"]).decode("ascii"),
    }


# ---- Apple Watch (SensorLog) pairing -------------------------------------------------

@app.post("/api/watch/pair")
async def watch_pair():
    return {"code": watch_hub.create()}


@app.post("/api/watch/{code}")
async def watch_receive(code: str, request: Request):
    try:
        payload = await request.json()
    except ValueError as exc:
        raise HTTPException(400, "Body must be JSON") from exc
    if isinstance(payload, dict) and isinstance(payload.get("data"), (dict, list)):
        payload = payload["data"]  # {"data": ...} wrapper, as the desktop app accepted
    payloads = payload if isinstance(payload, list) else [payload]
    if not payloads or len(payloads) > MAX_WATCH_BATCH or not all(isinstance(p, dict) for p in payloads):
        raise HTTPException(422, f"Send a JSON object or a list of up to {MAX_WATCH_BATCH} objects")
    try:
        return {"received": watch_hub.add(code, payloads)}
    except KeyError as exc:
        raise HTTPException(404, "Unknown or expired pairing code") from exc


@app.get("/api/watch/{code}/status")
async def watch_status(code: str):
    try:
        return watch_hub.status(code)
    except KeyError as exc:
        raise HTTPException(404, "Unknown or expired pairing code") from exc


@app.delete("/api/watch/{code}")
async def watch_unpair(code: str):
    watch_hub.remove(code)
    return {"removed": True}


# Only the two gesture files the page needs; not the training data or the old demo.
@app.get("/gestures/{name}")
async def gesture_file(name: str):
    if name not in GESTURE_FILES:
        raise HTTPException(404)
    return FileResponse(ROOT / "gestures" / name, media_type=GESTURE_FILES[name])


app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="site")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("PORT", "8000")))
