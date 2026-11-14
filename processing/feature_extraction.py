import numpy as np

def extra_features(values: np.ndarray) -> np.ndarray:
    if values.ndim != 3 or values.shape[-1] != 6:
        raise ValueError("Expected shape (batch, time, 6)")
    delta = np.diff(values, axis=1, prepend=values[:, :1, :])
    acc_norm = np.linalg.norm(values[..., :3], axis=-1, keepdims=True)
    gyro_norm = np.linalg.norm(values[..., 3:6], axis=-1, keepdims=True)
    return np.concatenate([delta, acc_norm, gyro_norm], axis=-1).astype(np.float32)

def extract_features(values: np.ndarray) -> np.ndarray:
    """Return the 14-channel representation used by the hybrid model."""
    if values.ndim != 3 or values.shape[-1] != 6:
        raise ValueError("Expected shape (batch, time, 6)")
    return np.concatenate([values, extra_features(values)], axis=-1).astype(np.float32)
