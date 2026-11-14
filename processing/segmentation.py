from enum import Enum
import math
import time
from collections import deque

class State(str, Enum):
    IDLE = "IDLE"
    WRITING = "WRITING"
    END_OF_LETTER = "END_OF_LETTER"
    PROCESSING = "PROCESSING"

class Segmenter:
    def __init__(self, start_threshold: float = 2.0, stop_threshold: float = 0.8, rest_seconds: float = 0.5,
                 min_duration: float = 0.3, max_duration: float = 5.0, pre_motion: float = 0.15) -> None:
        self.state = State.IDLE
        self.start_threshold, self.stop_threshold = start_threshold, stop_threshold
        self.rest_seconds, self.min_duration, self.max_duration, self.pre_motion = rest_seconds, min_duration, max_duration, pre_motion
        self.samples = deque()
        self.active_samples = []
        self.started_at = None
        self.quiet_since = None

    def update(self, sample: dict, now: float | None = None) -> list[dict]:
        now = now or time.monotonic()
        gyro = sample.get("gyro", (0, 0, 0)); acc = sample.get("acc", (0, 0, 0))
        intensity = math.sqrt(sum(x * x for x in gyro)) + abs(math.sqrt(sum(x * x for x in acc)) - 1.0)
        self.samples.append((now, sample, intensity))
        while self.samples and now - self.samples[0][0] > self.pre_motion:
            self.samples.popleft()
        if self.state == State.IDLE and intensity >= self.start_threshold:
            self.state, self.started_at = State.WRITING, now
            self.quiet_since = None
            self.active_samples = [item[1] for item in self.samples]
        elif self.state == State.WRITING:
            self.active_samples.append(sample)
            if intensity < self.stop_threshold:
                self.quiet_since = self.quiet_since or now
            else:
                self.quiet_since = None
            duration = now - (self.started_at or now)
            if duration >= self.max_duration or (self.quiet_since and now - self.quiet_since >= self.rest_seconds):
                if duration >= self.min_duration:
                    segment = list(self.active_samples)
                    self.state = State.PROCESSING
                    self.samples.clear()
                    self.active_samples = []
                    return segment
                self.state = State.IDLE
        return []

    def reset(self) -> None:
        self.state, self.started_at, self.quiet_since = State.IDLE, None, None
        self.samples.clear()
        self.active_samples = []

    def calibrate(self, samples: list[dict]) -> dict[str, float]:
        if len(samples) < 10:
            raise ValueError("At least 10 resting samples are required for calibration")
        gyro = [math.sqrt(sum(value * value for value in sample.get("gyro", (0, 0, 0)))) for sample in samples]
        acc = [abs(math.sqrt(sum(value * value for value in sample.get("acc", (0, 0, 0)))) - 1.0) for sample in samples]
        baseline = max(sum(gyro) / len(gyro), sum(acc) / len(acc))
        self.start_threshold = max(2.0, baseline * 5.0)
        self.stop_threshold = max(0.8, baseline * 2.0)
        return {"baseline": baseline, "start_threshold": self.start_threshold, "stop_threshold": self.stop_threshold}
