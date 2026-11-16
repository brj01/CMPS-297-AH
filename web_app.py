"""Hostable AirWrite website: letters + gestures on one page.

The browser talks to the sensor over Web Bluetooth and does all the live work.
This server only (1) serves the page and (2) classifies a finished letter with
the private SVM bundle, so the model weights never leave the server.

Run locally:  uvicorn web_app:app --port 8000   then open http://localhost:8000
"""
import asyncio
import logging
import math
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from config import AUTO_DOWNLOAD, CONFIDENCE_THRESHOLD, HF_REPO, HF_REVISION, MODEL_DIR
from recognition.classifier import Classifier
from recognition.model_downloader import ModelDownloader

ROOT = Path(__file__).parent
WEB_DIR = ROOT / "web"
GESTURE_FILES = {"core.js": "text/javascript", "model.json": "application/json"}
MAX_SAMPLES = 2000  # 20 s at 100 Hz; a letter is capped at 5 s by the detector

logger = logging.getLogger("airwrite.web")
classifier = Classifier(MODEL_DIR)
letters_status: dict = {"state": "loading", "detail": ""}


def load_letters_model() -> None:
    """Download (if allowed and needed) and load the letters model."""
    try:
        if AUTO_DOWNLOAD:
            try:
                ModelDownloader(MODEL_DIR, HF_REPO, HF_REVISION).download()
            except RuntimeError as exc:
                logger.error("Model download failed: %s", exc)
        model_path = MODEL_DIR / "airwrite_live.joblib"
        if not model_path.exists():
            letters_status.update(state="unavailable", detail="model file not found")
            return
        classifier.load(model_path.name)
        letters_status.update(state="ready", detail="")
    except Exception as exc:  # never take the site down because of the model
        logger.error("Letters model unavailable: %s", exc)
        letters_status.update(state="unavailable", detail=str(exc))


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(asyncio.to_thread(load_letters_model))
    yield
    task.cancel()


app = FastAPI(title="AirWrite", lifespan=lifespan, docs_url=None, redoc_url=None)


class Sample(BaseModel):
    t: float
    acc: list[float] = Field(min_length=3, max_length=3)
    gyro: list[float] = Field(min_length=3, max_length=3)
    orientation: list[float] = Field(min_length=3, max_length=3)

    @field_validator("t", "acc", "gyro", "orientation")
    @classmethod
    def finite(cls, value):
        values = value if isinstance(value, list) else [value]
        if not all(math.isfinite(v) for v in values):
            raise ValueError("values must be finite numbers")
        return value


class LetterRequest(BaseModel):
    samples: list[Sample] = Field(min_length=2, max_length=MAX_SAMPLES)


@app.get("/api/health")
async def health():
    return {"letters": dict(letters_status), "gestures": {"state": "ready"}}


@app.post("/api/letters/predict")
async def predict_letter(req: LetterRequest):
    if letters_status["state"] != "ready":
        raise HTTPException(503, "Letter recognition is not available on this server")
    samples = [
        {"timestamp": s.t, "acc": tuple(s.acc), "gyro": tuple(s.gyro), "orientation": tuple(s.orientation)}
        for s in req.samples
    ]
    try:
        result = await asyncio.to_thread(classifier.predict_samples, {"pen": samples}, CONFIDENCE_THRESHOLD, "pen")
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {
        "letter": result["letter"], "accepted": result["accepted"], "confidence": result["confidence"],
        "top3": [{"letter": t["letter"], "score": t["score"]} for t in result["top3"]],
        "latency_ms": result["latency_ms"],
    }


# Only the two gesture files the page needs; not the training data or the old demo.
@app.get("/gestures/{name}")
async def gesture_file(name: str):
    if name not in GESTURE_FILES:
        raise HTTPException(404)
    return FileResponse(ROOT / "gestures" / name, media_type=GESTURE_FILES[name],
                        headers={"Cache-Control": "public, max-age=3600"})


app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="site")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("PORT", "8000")))
