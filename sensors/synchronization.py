from collections import deque
import time
import numpy as np

class SensorSynchronizer:
    def __init__(self, rate_hz: float = 62, max_gap_seconds: float = 0.25, capacity: int = 4096) -> None:
        self.rate_hz = rate_hz
        self.max_gap = max_gap_seconds
        self.buffers = {"pen": deque(maxlen=capacity), "watch": deque(maxlen=capacity)}

    def add(self, sensor: str, sample: dict) -> None:
        if sensor not in self.buffers:
            raise ValueError(f"Unknown sensor: {sensor}")
        self.buffers[sensor].append(sample)

    def quality(self) -> dict:
        now = time.time()
        result = {}
        for name, samples in self.buffers.items():
            age = now - samples[-1]["received_at"] if samples else None
            result[name] = {"samples": len(samples), "stale": age is None or age > 2.0, "age": age}
        return result

    def aligned(self, start: float, end: float) -> dict[str, np.ndarray]:
        grid = np.arange(start, end, 1.0 / self.rate_hz)
        result: dict[str, np.ndarray] = {}
        for name, samples in self.buffers.items():
            if not samples:
                continue
            timestamps = np.array([s["timestamp"] for s in samples])
            values = np.array([list(s["acc"]) + list(s["gyro"]) for s in samples], dtype=float)
            valid = np.argsort(timestamps)
            timestamps, values = timestamps[valid], values[valid]
            keep = (grid >= timestamps[0]) & (grid <= timestamps[-1])
            if not keep.any():
                continue
            result[name] = np.column_stack([np.interp(grid[keep], timestamps, values[:, i]) for i in range(values.shape[1])])
        return result

