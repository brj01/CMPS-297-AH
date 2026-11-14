import asyncio
import math
import time
from collections import deque
from .apple_watch import normalize_payload
from .imu_bluetooth import BluetoothImu
from .synchronization import SensorSynchronizer

class SensorManager:
    def __init__(self) -> None:
        self.synchronizer = SensorSynchronizer()
        self.pen = BluetoothImu(self._on_pen)
        self.watch_connected = False
        self.latest = {}
        self.simulation = False
        self.clients = set()
        self.sample_queue = deque()
        self.packet_count = 0
        self.first_packet_at = None
        self.last_packet_at = None
        self.last_raw_packet = None
        self.watch_count = 0
        self.watch_first_at = None
        self.watch_last_at = None
        self.recording = False
        self.recording_samples: list[dict] = []

    def _on_pen(self, reading) -> None:
        received_at = time.time()
        self.packet_count += 1
        self.first_packet_at = self.first_packet_at or received_at
        self.last_packet_at = received_at
        self.last_raw_packet = reading.raw.hex(" ").upper()
        sample = {
            "timestamp": reading.timestamp, "received_at": received_at,
            "acc": reading.acc, "gyro": reading.gyro,
            "orientation": reading.orientation, "raw": self.last_raw_packet,
        }
        self.latest["pen"] = sample
        self.synchronizer.add("pen", sample)
        self.sample_queue.append(sample)
        if self.recording:
            self.recording_samples.append({"sensor": "pen", "sample": sample})

    def on_watch(self, payload: dict) -> dict:
        sample = normalize_payload(payload)
        self.latest["watch"] = sample
        self.watch_connected = True
        self.watch_count += 1
        self.watch_first_at = self.watch_first_at or sample["received_at"]
        self.watch_last_at = sample["received_at"]
        self.synchronizer.add("watch", sample)
        if self.recording:
            self.recording_samples.append({"sensor": "watch", "sample": sample})
        return sample

    def watch_samples_for(self, start: float, end: float) -> list[dict]:
        return [
            sample for sample in self.synchronizer.buffers["watch"]
            if start - 0.25 <= sample["timestamp"] <= end + 0.25
        ]

    async def simulate(self) -> None:
        self.simulation = True
        started = time.time()
        while self.simulation:
            t = time.time()
            phase = t - started
            motion = math.sin(phase * 7) * (1 if int(phase) % 4 < 2 else 0.02)
            sample = {"timestamp": t, "received_at": t, "acc": (motion, 0.1 * motion, 1.0), "gyro": (motion * 20, 0, 0)}
            self.latest["pen"] = sample
            self.synchronizer.add("pen", sample)
            await asyncio.sleep(1 / 62)
