import numpy as np
from scipy.spatial.transform import Rotation, Slerp

def prepare(values: np.ndarray, sequence_length: int = 155, mean=None, std=None) -> np.ndarray:
    if values.ndim != 2 or values.shape[1] != 6:
        raise ValueError("Expected sensor samples with six channels")
    values = np.nan_to_num(values.astype(np.float32))
    if len(values) == 0:
        raise ValueError("Cannot preprocess an empty recording")
    indices = np.linspace(0, len(values) - 1, sequence_length).round().astype(int)
    result = values[indices]
    if mean is not None and std is not None:
        result = (result - mean) / np.where(np.asarray(std) == 0, 1, std)
    return result[None, ...]

def _interpolate(values: np.ndarray, timestamps: np.ndarray, count: int) -> np.ndarray:
    timestamps = np.asarray(timestamps, dtype=np.float64)
    if len(values) < 2:
        raise ValueError("At least two sensor samples are required")
    order = np.argsort(timestamps)
    timestamps, values = timestamps[order], values[order]
    keep = np.concatenate(([True], np.diff(timestamps) > 0))
    timestamps, values = timestamps[keep], values[keep]
    if len(values) < 2 or timestamps[-1] <= timestamps[0]:
        raise ValueError("Sensor timestamps must be strictly increasing")
    grid = np.linspace(timestamps[0], timestamps[-1], count)
    return np.column_stack([np.interp(grid, timestamps, values[:, i]) for i in range(values.shape[1])])

def select_active_segment(samples: list[dict], gap_seconds: float = 0.65) -> list[dict]:
    if len(samples) < 2:
        raise ValueError("A letter needs at least two sensor samples")
    timestamps = np.asarray([s["timestamp"] for s in samples], dtype=np.float64)
    gyro = np.asarray([s["gyro"] for s in samples], dtype=np.float32)
    magnitude = np.linalg.norm(gyro, axis=1)
    window = max(1, int(round(0.1 / max(np.median(np.diff(timestamps)), 1e-3))))
    smoothed = np.convolve(magnitude, np.ones(window) / window, mode="same")
    threshold = max(18.0, 0.12 * np.percentile(smoothed, 95))
    active = smoothed >= threshold
    groups = []
    start = None
    for index, is_active in enumerate(active):
        if is_active and start is None:
            start = index
        if start is not None and (not is_active or index == len(active) - 1):
            end = index if is_active else index - 1
            if end >= start:
                groups.append((start, end))
            start = None
    if not groups:
        raise ValueError("No active movement found")
    merged = []
    for group in groups:
        if merged and timestamps[group[0]] - timestamps[merged[-1][1]] <= gap_seconds:
            merged[-1] = (merged[-1][0], group[1])
        else:
            merged.append(group)
    strongest = max(merged, key=lambda group: float(np.sum(smoothed[group[0]:group[1] + 1] ** 2)))
    pad = 0.15
    begin = np.searchsorted(timestamps, timestamps[strongest[0]] - pad, side="left")
    end = np.searchsorted(timestamps, timestamps[strongest[1]] + pad, side="right")
    return samples[begin:end]

def _strictly_increasing(samples: list[dict]) -> list[dict]:
    """Drop samples whose timestamp does not move forward (e.g. duplicates)."""
    kept: list[dict] = []
    for sample in sorted(samples, key=lambda s: s["timestamp"]):
        if not kept or sample["timestamp"] > kept[-1]["timestamp"]:
            kept.append(sample)
    return kept

def build_svm_inputs(samples: list[dict], sample_steps: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    selected = _strictly_increasing(select_active_segment(samples))
    if len(selected) < 2:
        raise ValueError("A letter needs at least two sensor samples with distinct timestamps")
    timestamps = np.asarray([s["timestamp"] for s in selected], dtype=np.float64)
    motion = np.asarray([[*s["acc"], *s["gyro"]] for s in selected], dtype=np.float32)
    raw6 = _interpolate(motion, timestamps, 155)
    raw6 = (raw6 - raw6.mean(axis=0)) / np.maximum(raw6.std(axis=0), 1e-6)
    euler = np.asarray([s.get("orientation", (0.0, 0.0, 0.0)) for s in selected], dtype=np.float64)
    rotations = Rotation.from_euler("xyz", euler, degrees=True)
    relative = rotations[0].inv() * rotations
    valid_times = timestamps - timestamps[0]
    relative_resampled = Slerp(valid_times, relative)(
        np.linspace(valid_times[0], valid_times[-1], 155)
    )
    matrices = relative_resampled.as_matrix()
    orientation6d = matrices[:, :, :2].transpose(0, 2, 1).reshape(155, 6).astype(np.float32)
    combined = np.concatenate([raw6, orientation6d], axis=-1)
    steps = np.asarray(sample_steps, dtype=np.int64)
    if steps.ndim != 1 or len(steps) != 31 or np.any(steps < 0) or np.any(steps >= 155):
        raise ValueError("Model sample_steps must contain 31 indices between 0 and 154")
    return raw6[steps].reshape(1, -1), combined[steps].reshape(1, -1)
