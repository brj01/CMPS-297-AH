from datetime import datetime
from typing import Any
import time
import math

def _number(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default

def _first(data: dict[str, Any], names: tuple[str, ...], default: float = 0.0) -> float:
    for name in names:
        if name in data:
            return _number(data[name], default)
    return default

def normalize_payload(payload: dict[str, Any]) -> dict[str, Any]:
    timestamp = payload.get("timestamp", payload.get("time", time.time()))
    if isinstance(timestamp, str):
        try:
            timestamp = datetime.fromisoformat(timestamp.replace("Z", "+00:00")).timestamp()
        except ValueError:
            timestamp = time.time()
    acceleration = tuple(_first(payload, (f"acceleration_{axis}", f"acc_{axis}", axis)) for axis in "xyz")
    rotation = tuple(_first(payload, (f"rotation_rate_{axis}", f"gyro_{axis}", f"rotation_{axis}")) for axis in "xyz")
    gravity = tuple(_first(payload, (f"gravity_{axis}",)) for axis in "xyz") if any(f"gravity_{a}" in payload for a in "xyz") else None
    orientation = tuple(_first(payload, (f"orientation_{axis}", f"angle_{axis}")) for axis in "xyz")
    return {
        "timestamp": float(timestamp), "received_at": time.time(),
        "acc": acceleration, "gyro": rotation, "gravity": gravity,
        "orientation": orientation, "raw": payload,
        "acc_norm": math.sqrt(sum(value * value for value in acceleration)),
        "gyro_norm": math.sqrt(sum(value * value for value in rotation)),
    }
