import math
import numpy as np
from processing.preprocessing import build_svm_inputs

def _letter(packets_per_timestamp: int) -> list[dict]:
    samples = []
    for i in range(120):
        t = 1000 + (i // packets_per_timestamp) * 0.01 * packets_per_timestamp
        a = math.sin(i / 8)
        samples.append({"timestamp": t, "acc": (a, 0.1, 1.0), "gyro": (a * 150, a * 40, 0.0),
                        "orientation": (a * 20, a * 5, i * 0.3)})
    return samples

def test_duplicate_timestamps_do_not_break_svm_inputs():
    steps = np.linspace(0, 154, 31).astype(int)
    raw, combined = build_svm_inputs(_letter(2), steps)
    assert raw.shape == (1, 31 * 6) and combined.shape == (1, 31 * 12)
    assert np.isfinite(raw).all() and np.isfinite(combined).all()
