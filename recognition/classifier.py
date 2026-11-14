import json
import string
import time
from pathlib import Path
import numpy as np
from processing.feature_extraction import extra_features
from scipy.stats import rankdata
from processing.preprocessing import build_svm_inputs

class Classifier:
    def __init__(self, model_dir: Path) -> None:
        self.model_dir, self.model, self.labels, self.name = model_dir, None, {}, None
        self.input_channels, self.version, self.mapping_verified = None, None, False
        self.kind, self.config, self.bundle = None, {}, None
        labels = model_dir / "labels.json"
        if labels.exists():
            payload = json.loads(labels.read_text(encoding="utf-8"))
            self.mapping_verified = bool(payload.get("verified", False))
            self.labels = payload.get("mapping", payload if isinstance(payload, dict) else {})

    def load(self, filename: str) -> None:
        path = self.model_dir / filename
        if not path.exists():
            raise FileNotFoundError(f"Model file not found: {path}")
        if path.suffix == ".joblib":
            try:
                import joblib
            except ImportError as exc:
                raise RuntimeError("Install joblib to load the SVM model") from exc
            self.model = joblib.load(path)
            self.kind = "joblib"
            if not isinstance(self.model, dict) or "adapted_models" not in self.model:
                raise ValueError("airwrite_live.joblib does not contain the expected model bundle")
            self.bundle = self.model
        elif path.suffix == ".keras":
            try:
                from tensorflow import keras
            except ImportError as exc:
                raise RuntimeError("TensorFlow is required to load a .keras model") from exc
            self.model = keras.models.load_model(path, compile=False)
            shape = self.model.input_shape
            channels = shape[-1] if shape and len(shape) == 3 else None
            if channels not in {6, 14}:
                raise ValueError(f"Unsupported model input shape: {shape}")
            self.input_channels = int(channels)
            self.kind = "keras"
        else:
            raise ValueError("Only .joblib and .keras models may be selected")
        self.name = filename
        config_path = self.model_dir / "model_config.json"
        if config_path.exists():
            self.config = json.loads(config_path.read_text(encoding="utf-8"))
            self.version = self.config.get("version")
        if self.kind == "joblib":
            required = {"adapted_models", "fusion_weights", "class_names", "sample_steps"}
            missing = required.difference(self.bundle)
            if missing:
                raise ValueError(f"SVM bundle is missing required fields: {', '.join(sorted(missing))}")
            if list(self.bundle["class_names"]) != list(string.ascii_uppercase):
                raise ValueError("SVM bundle class_names must be the uppercase English alphabet")
            steps = np.asarray(self.bundle["sample_steps"])
            if steps.ndim != 1 or len(steps) != 31 or np.any(steps < 0) or np.any(steps >= 155):
                raise ValueError("SVM bundle sample_steps must contain 31 indices between 0 and 154")
            for name, expected in {
                "Pen_Raw6": 186, "Pen_Orientation": 372,
                "Watch_Raw6": 186, "Watch_Orientation": 372,
            }.items():
                model = self.bundle["adapted_models"].get(name)
                if model is None or not np.array_equal(model.classes_, np.arange(26)):
                    raise ValueError(f"{name} must expose classes 0 through 25")
                if getattr(model, "n_features_in_", None) != expected:
                    raise ValueError(f"{name} must accept {expected} features")
            self.input_channels = 6
            self.mapping_verified = True

    def prepare_input(self, values: np.ndarray) -> np.ndarray:
        if values.shape != (1, 155, 6):
            raise ValueError("Classifier input must have shape (1, 155, 6) before feature construction")
        if self.input_channels == 6:
            return values.astype(np.float32)
        stats_path = self.model_dir / "feature_stats.npz"
        if not stats_path.exists():
            raise FileNotFoundError("feature_stats.npz is required for a 14-channel model")
        stats = np.load(stats_path, allow_pickle=False)
        mean, std = stats["mean"], stats["std"]
        extras = extra_features(values)
        if mean.shape != (8,) or std.shape != (8,):
            raise ValueError("feature_stats mean/std must each contain eight values")
        return np.concatenate([values, (extras - mean) / np.where(std == 0, 1, std)], axis=-1).astype(np.float32)

    def predict(self, values: np.ndarray, threshold: float = 0.6) -> dict:
        if self.model is None:
            raise RuntimeError("No trained model selected; install/load a compatible .keras model first")
        started = time.perf_counter()
        if self.kind == "keras":
            values = self.prepare_input(values)
            probabilities = np.asarray(self.model.predict(values, verbose=0))[0]
        else:
            raise ValueError("Use predict_samples for the orientation-fusion SVM")
        order = np.argsort(probabilities)[::-1][:3]
        top = [{"class_id": int(i), "letter": self.labels.get(str(int(i))) if self.mapping_verified else None,
                "confidence": float(probabilities[i])} for i in order]
        accepted = top[0]["confidence"] >= threshold and self.mapping_verified
        return {"letter": top[0]["letter"] if accepted else None, "class_id": top[0]["class_id"],
                "confidence": top[0]["confidence"], "top3": top, "accepted": accepted,
                "latency_ms": (time.perf_counter() - started) * 1000, "model": self.name, "version": self.version}

    def predict_samples(self, samples: list[dict] | dict[str, list[dict]], threshold: float = 0.0,
                        sensor_mode: str = "auto") -> dict:
        if self.kind != "joblib" or self.bundle is None:
            raise RuntimeError("The selected model is not the SVM fusion bundle")
        started = time.perf_counter()
        models = self.bundle["adapted_models"]
        if isinstance(samples, list):
            samples = {"pen": samples}
        available = {name: value for name, value in samples.items() if len(value) >= 2}
        if sensor_mode in {"pen", "watch"}:
            available = {sensor_mode: available.get(sensor_mode, [])}
        if not available:
            raise ValueError("No sensor samples are available for SVM inference")
        combined = None
        fusion_parts = []
        for sensor, sensor_samples in available.items():
            raw_input, orientation_input = build_svm_inputs(sensor_samples, self.bundle["sample_steps"])
            prefix = "Pen" if sensor == "pen" else "Watch"
            raw_model, orientation_model = models[f"{prefix}_Raw6"], models[f"{prefix}_Orientation"]
            raw_scores = 1.0 / rankdata(-raw_model.decision_function(raw_input), axis=1, method="average")
            orientation_scores = 1.0 / rankdata(-orientation_model.decision_function(orientation_input), axis=1, method="average")
            weights = self.bundle["fusion_weights"][f"{prefix} Fusion"]
            sensor_scores = weights[f"{prefix}_Raw6"] * raw_scores + weights[f"{prefix}_Orientation"] * orientation_scores
            combined = sensor_scores if combined is None else combined + sensor_scores
            fusion_parts.append(f"{prefix}_Raw6 + {prefix}_Orientation")
        combined /= len(fusion_parts)
        scores = combined[0]
        order = np.argsort(scores)[::-1][:3]
        names = self.bundle["class_names"]
        top = [{"class_id": int(index), "letter": str(names[index]), "score": float(scores[index])} for index in order]
        accepted = top[0]["score"] >= threshold
        return {"letter": top[0]["letter"] if accepted else None, "class_id": top[0]["class_id"],
                "confidence": top[0]["score"], "top3": top, "accepted": accepted,
                "latency_ms": (time.perf_counter() - started) * 1000, "model": self.name,
                "fusion": " + ".join(fusion_parts), "score_type": "reciprocal_rank"}

    def _joblib_features(self, values: np.ndarray) -> np.ndarray:
        """Create only the feature contract declared by model_config.json."""
        contract = self.config.get("feature_order")
        if not isinstance(contract, list) or not contract:
            raise ValueError("model_config.json must declare a non-empty feature_order for SVM inference")
        if values.shape != (1, 155, 6):
            raise ValueError("SVM input must have shape (1, 155, 6) before feature construction")
        derived = {
            "acc_x": values[0, :, 0], "acc_y": values[0, :, 1], "acc_z": values[0, :, 2],
            "gyro_x": values[0, :, 3], "gyro_y": values[0, :, 4], "gyro_z": values[0, :, 5],
        }
        features = []
        for name in contract:
            base, separator, aggregation = name.rpartition("_")
            if not separator or base not in derived or aggregation not in {"mean", "std", "min", "max"}:
                raise ValueError(f"Unsupported or undocumented SVM feature: {name}")
            signal = derived[base]
            features.append(float(getattr(np, aggregation)(signal)))
        expected = getattr(self.model, "n_features_in_", len(features))
        if len(features) != expected:
            raise ValueError(f"SVM expects {expected} features but model_config declares {len(features)}")
        return np.asarray(features, dtype=np.float32).reshape(1, -1)
