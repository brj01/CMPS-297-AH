import asyncio
import logging
import socket
import time
import json
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from bleak.exc import BleakError
from config import (
    AUTO_CONNECT_IMU, AUTO_DOWNLOAD, CONFIDENCE_THRESHOLD, HOST, HF_REPO, HF_REVISION,
    IMU_ADDRESS, MODEL_DIR, MODEL_MANAGEMENT_TOKEN, PORT, RECORDINGS_DIR, SENSOR_MODE, WATCH_TOKEN,
)
from processing.segmentation import Segmenter
from recognition.classifier import Classifier
from recognition.model_downloader import ModelDownloader
from recognition.text_manager import TextManager
from sensors.sensor_manager import SensorManager

logger = logging.getLogger("airwrite")
manager, segmenter, classifier, text = SensorManager(), Segmenter(), Classifier(MODEL_DIR), TextManager()
websockets: set[WebSocket] = set()
simulation_task = None
session_active = False
recording: list[dict] = []
recording_meta: dict = {}
prediction_history: list[dict] = []
model_downloader = ModelDownloader(MODEL_DIR, HF_REPO, HF_REVISION)

def local_ip() -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80)); return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()

async def broadcaster() -> None:
    while True:
        message = {"type": "sample", "data": {"latest": manager.latest, "state": segmenter.state.value,
                   "sync": manager.synchronizer.quality(), "text": text.text}}
        for ws in list(websockets):
            try: await ws.send_json(message)
            except Exception: websockets.discard(ws)
        await asyncio.sleep(0.1)

async def process_sensor_samples() -> None:
    while True:
        if session_active and manager.sample_queue:
            sample = manager.sample_queue.popleft()
            segment = segmenter.update(sample)
            if segment and classifier.model is not None:
                try:
                    watch = manager.watch_samples_for(segment[0]["timestamp"], segment[-1]["timestamp"])
                    samples = {"pen": segment, "watch": watch}
                    result = await asyncio.to_thread(
                        classifier.predict_samples, samples, CONFIDENCE_THRESHOLD, SENSOR_MODE
                    )
                    result.update({"timestamp": time.time(), "sensor_mode": SENSOR_MODE,
                                   "status": "accepted" if result["accepted"] else "rejected"})
                    prediction_history.append(result)
                    if len(prediction_history) > 100:
                        del prediction_history[:-100]
                    if result["accepted"]:
                        text.add(result["letter"])
                    segmenter.reset()
                    for ws in list(websockets):
                        try: await ws.send_json({"type": "prediction", "data": result})
                        except Exception: websockets.discard(ws)
                except (ValueError, FileNotFoundError, RuntimeError) as exc:
                    logger.error("Sensor sample processing failed: %s", exc)
                    prediction_history.append({"accepted": False, "status": "error", "error": str(exc), "timestamp": time.time()})
        await asyncio.sleep(0.005)

@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(broadcaster())
    processor = asyncio.create_task(process_sensor_samples())
    if AUTO_DOWNLOAD:
        try:
            await asyncio.to_thread(model_downloader.download)
        except RuntimeError as exc:
            logger.error("Model download failed: %s", exc)
    model_path = MODEL_DIR / "airwrite_live.joblib"
    if model_path.exists():
        try:
            classifier.load(model_path.name)
        except (FileNotFoundError, RuntimeError, ValueError) as exc:
            logger.error("Model load failed: %s", exc)
    if AUTO_CONNECT_IMU:
        try:
            await manager.pen.connect(IMU_ADDRESS)
        except (BleakError, OSError, RuntimeError, asyncio.TimeoutError) as exc:
            logger.error("Automatic IMU connection failed: %s", exc)
    yield
    task.cancel()
    processor.cancel()
    manager.simulation = False

app = FastAPI(title="AirWrite", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=Path(__file__).parent / "static"), name="static")

class ConnectRequest(BaseModel):
    address: str
class ModelRequest(BaseModel):
    filename: str
class WatchPayload(BaseModel):
    data: dict
class SimulationRequest(BaseModel):
    enabled: bool = True

@app.get("/")
async def index(): return FileResponse(Path(__file__).parent / "static" / "index.html")
@app.get("/api/status")
async def status():
    now = time.time()
    packet_age = now - manager.last_packet_at if manager.last_packet_at else None
    packet_rate = (
        (manager.packet_count - 1) / (manager.last_packet_at - manager.first_packet_at)
        if manager.first_packet_at and manager.last_packet_at and manager.last_packet_at > manager.first_packet_at
        else 0
    )
    watch_rate = (
        (manager.watch_count - 1) / (manager.watch_last_at - manager.watch_first_at)
        if manager.watch_first_at and manager.watch_last_at and manager.watch_last_at > manager.watch_first_at
        else 0
    )
    return {"pen_connected": manager.pen.connected, "watch_connected": manager.watch_connected,
            "simulation": manager.simulation, "state": segmenter.state.value, "local_ip": local_ip(),
            "watch_url": f"http://{local_ip()}:{PORT}/api/sensors/watch", "sync": manager.synchronizer.quality(),
            "model": classifier.name, "model_status": model_downloader.read_status(),
            "model_repo": HF_REPO, "pen_address": manager.pen.device,
            "notification_characteristic": manager.pen.notification_characteristic,
            "packets": manager.packet_count, "packet_rate_hz": round(packet_rate, 1),
            "packet_age_seconds": packet_age, "raw_packet": manager.last_raw_packet,
            "session_active": session_active, "watch_packets": manager.watch_count,
            "watch_rate_hz": round(watch_rate, 1),
            "watch_age_seconds": time.time() - manager.watch_last_at if manager.watch_last_at else None}
@app.get("/api/bluetooth/scan")
async def scan():
    try: return {"devices": await manager.pen.scan()}
    except ImportError: raise HTTPException(503, "Install bleak to scan Bluetooth devices")
@app.post("/api/bluetooth/connect")
async def connect(req: ConnectRequest):
    try:
        await manager.pen.connect(req.address)
    except (BleakError, OSError, RuntimeError, asyncio.TimeoutError) as exc:
        raise HTTPException(502, f"Bluetooth connection failed: {exc}") from exc
    return {"connected": True, "address": manager.pen.device,
            "notification_characteristic": manager.pen.notification_characteristic}
@app.post("/api/bluetooth/disconnect")
async def disconnect():
    await manager.pen.disconnect(); return {"connected": False}
@app.post("/api/sensors/watch")
async def watch(request: Request):
    if WATCH_TOKEN and request.headers.get("x-airwrite-token") != WATCH_TOKEN: raise HTTPException(401, "Invalid watch token")
    payload = await request.json()
    return manager.on_watch(payload)
@app.post("/api/models/select")
async def select_model(req: ModelRequest):
    if Path(req.filename).name != req.filename or Path(req.filename).suffix not in {".keras", ".joblib"}:
        raise HTTPException(400, "Only a local .keras or .joblib filename may be selected")
    try:
        classifier.load(req.filename)
    except (FileNotFoundError, RuntimeError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"model": classifier.name, "channels": classifier.input_channels, "mapping_verified": classifier.mapping_verified}
@app.get("/api/models")
async def models():
    return {"models": [p.name for p in MODEL_DIR.glob("*.keras")] + [p.name for p in MODEL_DIR.glob("*.joblib")],
            "selected": classifier.name,
            "mapping_verified": classifier.mapping_verified}
def check_model_management(request: Request) -> None:
    if MODEL_MANAGEMENT_TOKEN and request.headers.get("x-airwrite-model-token") != MODEL_MANAGEMENT_TOKEN:
        raise HTTPException(401, "Invalid model management token")
@app.get("/api/models/status")
async def model_status(): return model_downloader.read_status()
@app.post("/api/models/download")
async def download_models(request: Request):
    check_model_management(request)
    try:
        return await asyncio.to_thread(model_downloader.download)
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc
@app.post("/api/simulation")
async def simulation(req: SimulationRequest):
    global simulation_task
    manager.simulation = req.enabled
    if req.enabled and (simulation_task is None or simulation_task.done()):
        simulation_task = asyncio.create_task(manager.simulate())
    return {"enabled": manager.simulation}
@app.post("/api/session/start")
async def start_session():
    global session_active
    session_active = True
    segmenter.reset()
    manager.sample_queue.clear()
    return {"active": True}
@app.post("/api/session/stop")
async def stop_session():
    global session_active
    session_active = False
    segmenter.reset()
    manager.sample_queue.clear()
    return {"active": False}
@app.post("/api/calibrate")
async def calibrate():
    samples = list(manager.synchronizer.buffers["pen"])[-120:]
    try:
        settings = segmenter.calibrate(samples)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"calibrated": True, "settings": settings}
@app.get("/api/predictions")
async def predictions():
    return {"text": text.text, "last": prediction_history[-1] if prediction_history else None, "history": prediction_history}
@app.post("/api/recording/start")
async def recording_start(request: Request):
    global recording, recording_meta
    recording = []
    recording_meta = await request.json()
    manager.recording = True
    manager.recording_samples = []
    return {"recording": True, "metadata": recording_meta}
@app.post("/api/recording/stop")
async def recording_stop():
    global recording
    manager.recording = False
    recording = manager.recording_samples
    return {"recording": False, "samples": len(recording)}
@app.post("/api/recording/{decision}")
async def recording_decision(decision: str):
    if decision not in {"accept", "reject"}:
        raise HTTPException(404, "Unknown recording decision")
    if decision == "accept":
        RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
        path = RECORDINGS_DIR / f"{int(time.time() * 1000)}.json"
        path.write_text(json.dumps({"metadata": recording_meta, "samples": recording}), encoding="utf-8")
    return {"decision": decision}
@app.post("/api/text/{action}")
async def text_action(action: str):
    if action == "space": value = text.space()
    elif action == "delete": value = text.delete()
    elif action == "clear": value = text.clear()
    else: raise HTTPException(404, "Unknown text action")
    return {"text": value}
@app.websocket("/ws")
async def websocket(ws: WebSocket):
    await ws.accept(); websockets.add(ws)
    try:
        while True:
            await asyncio.sleep(0.02)
    except WebSocketDisconnect: websockets.discard(ws)
