"""Apple Watch pairing for the hosted site.

Each browser asks for a short pairing code and gives SensorLog the URL
/api/watch/<code>. Watch samples posted there are kept in memory for that code
only, so several people can use the site at once. When a letter is classified,
the browser sends its code and the server picks the watch samples recorded
during that letter (same ±0.25 s matching as the desktop app).

State is in memory: run the server as a single process (uvicorn's default).
"""
import math
import secrets
import time
from collections import deque
from threading import Lock

from sensors.apple_watch import normalize_payload

ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O or 1/I/L
CODE_LENGTH = 6
MATCH_PADDING = 0.25  # seconds, as in SensorManager.watch_samples_for


class WatchHub:
    def __init__(self, max_sessions: int = 500, capacity: int = 3000, idle_timeout: float = 1800.0) -> None:
        self.max_sessions, self.capacity, self.idle_timeout = max_sessions, capacity, idle_timeout
        self.sessions: dict[str, dict] = {}
        self.lock = Lock()

    def _prune(self, now: float) -> None:
        for code in [c for c, s in self.sessions.items() if now - s["touched"] > self.idle_timeout]:
            del self.sessions[code]

    def create(self) -> str:
        now = time.time()
        with self.lock:
            self._prune(now)
            if len(self.sessions) >= self.max_sessions:
                oldest = min(self.sessions, key=lambda c: self.sessions[c]["touched"])
                del self.sessions[oldest]
            while True:
                code = "".join(secrets.choice(ALPHABET) for _ in range(CODE_LENGTH))
                if code not in self.sessions:
                    break
            self.sessions[code] = {"samples": deque(maxlen=self.capacity), "touched": now,
                                   "count": 0, "arrivals": deque(maxlen=200), "motion": False}
            return code

    def _get(self, code: str) -> dict:
        session = self.sessions.get(code.upper())
        if session is None:
            raise KeyError(code)
        return session

    def add(self, code: str, payloads: list[dict]) -> int:
        now = time.time()
        with self.lock:
            session = self._get(code)
            for payload in payloads:
                sample = normalize_payload(payload)
                session["samples"].append(sample)
                session["arrivals"].append(now)
                session["count"] += 1
                if sample["acc_norm"] > 0 or sample["gyro_norm"] > 0:
                    session["motion"] = True
            session["touched"] = now
            return len(payloads)

    def status(self, code: str) -> dict:
        now = time.time()
        with self.lock:
            session = self._get(code)
            session["touched"] = now
            arrivals = [t for t in session["arrivals"] if now - t <= 2.0]
            last = session["arrivals"][-1] if session["arrivals"] else None
            return {
                "samples": session["count"],
                "receiving": last is not None and now - last <= 2.0,
                "rate_hz": round(len(arrivals) / 2.0, 1),
                "age_seconds": None if last is None else round(now - last, 2),
                "motion_fields": session["motion"],
            }

    def window(self, code: str, start: float, end: float) -> list[dict]:
        with self.lock:
            session = self._get(code)
            session["touched"] = time.time()
            return [s for s in session["samples"]
                    if start - MATCH_PADDING <= s["timestamp"] <= end + MATCH_PADDING
                    and all(math.isfinite(v) for v in (*s["acc"], *s["gyro"], *s["orientation"]))]

    def remove(self, code: str) -> None:
        with self.lock:
            self.sessions.pop(code.upper(), None)
