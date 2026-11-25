"""Inference for AirWrite's 74-class multilingual image model."""

import base64
import binascii
import io
import json
import logging
import os
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

os.environ.setdefault("CUDA_VISIBLE_DEVICES", "-1")

logger = logging.getLogger("airwrite.multilingual_image")

IMAGE_SIZE = 28
CANVAS_SIZE = 24
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_IMAGE_DIMENSION = 4096
MODE_GROUPS = {
    "english": ("english_letters",),
    "arabic": ("arabic_letters",),
    "numbers": ("western_digits", "arabic_indic_digits"),
}


def decode_png_data_url(value: str) -> bytes:
    """Decode a bounded PNG data URL without accepting other image formats."""
    header, separator, encoded = value.partition(",")
    if not separator or header != "data:image/png;base64":
        raise ValueError("Provide a PNG image encoded as a data URL")
    if len(encoded) > ((MAX_IMAGE_BYTES + 2) // 3) * 4:
        raise ValueError("Image is too large (maximum 4 MiB)")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("Image data is not valid base64") from exc
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise ValueError("Image is empty or too large (maximum 4 MiB)")
    return data


def _read_png(data: bytes) -> Image.Image:
    try:
        with Image.open(io.BytesIO(data)) as source:
            if source.format != "PNG":
                raise ValueError("Only PNG images are supported")
            if getattr(source, "n_frames", 1) != 1:
                raise ValueError("Animated PNG images are not supported")
            if source.width > MAX_IMAGE_DIMENSION or source.height > MAX_IMAGE_DIMENSION:
                raise ValueError("Image dimensions must not exceed 4096 × 4096")
            source.load()
            return source.copy()
    except (Image.DecompressionBombError, OSError) as exc:
        raise ValueError("Image is not a valid, safely sized PNG") from exc


def preprocess_image(image: Image.Image) -> np.ndarray:
    """Crop one character and center it on the model's normalized 28x28 canvas."""
    rgba = image.convert("RGBA")
    alpha = np.asarray(rgba.getchannel("A"), dtype=np.uint8)
    if np.any(alpha < 255):
        visible = np.asarray(rgba.convert("RGB"), dtype=np.uint8)[alpha > 0]
        ink_level = float(visible.mean()) if visible.size else 0
        fill = (0, 0, 0, 255) if ink_level >= 127.5 else (255, 255, 255, 255)
    else:
        fill = (0, 0, 0, 255)
    background = Image.new("RGBA", rgba.size, fill)
    background.alpha_composite(rgba)
    gray = ImageOps.grayscale(background.convert("RGB"))
    pixels = np.asarray(gray, dtype=np.uint8)
    border = np.concatenate((pixels[0, :], pixels[-1, :], pixels[:, 0], pixels[:, -1]))
    background_level = float(np.median(border))
    foreground = (255 - pixels) if background_level >= 127.5 else pixels
    peak = int(foreground.max())
    if peak < 16:
        raise ValueError("Image is blank; draw or upload a character first")
    threshold = max(8, int(peak * 0.06))
    mask = foreground > threshold
    if not mask.any():
        raise ValueError("Image is blank; draw or upload a character first")
    ys, xs = np.nonzero(mask)
    left, right = int(xs.min()), int(xs.max()) + 1
    top, bottom = int(ys.min()), int(ys.max()) + 1
    crop = Image.fromarray(foreground[top:bottom, left:right], mode="L")

    scale = min(CANVAS_SIZE / crop.width, CANVAS_SIZE / crop.height)
    size = (max(1, round(crop.width * scale)), max(1, round(crop.height * scale)))
    resized = crop.resize(size, Image.Resampling.LANCZOS)
    canvas = Image.new("L", (IMAGE_SIZE, IMAGE_SIZE), 0)
    canvas.paste(resized, ((IMAGE_SIZE - size[0]) // 2, (IMAGE_SIZE - size[1]) // 2))
    return (np.asarray(canvas, dtype=np.float32) / np.float32(255.0))[None, :, :, None]


def preview_png(image: np.ndarray) -> bytes:
    """Encode the exact normalized model input as an 8-bit grayscale PNG."""
    pixels = np.clip(np.asarray(image)[0, :, :, 0] * 255.0, 0, 255).round().astype(np.uint8)
    output = io.BytesIO()
    Image.fromarray(pixels, mode="L").save(output, format="PNG")
    return output.getvalue()


class MultilingualImageClassifier:
    def __init__(self, model_path: Path, hf_repo: str):
        self.model_path = Path(model_path)
        self.hf_repo = hf_repo.strip()
        self.model = None
        self.labels = None
        self.groups = None
        self.preprocessing = None

    def _asset(self, filename: str) -> Path:
        local = self.model_path.with_name(filename)
        if local.is_file():
            return local
        if not self.hf_repo:
            raise RuntimeError(f"Missing {filename}; set AIRWRITE_IMAGE_HF_REPO or provide it beside the model")
        try:
            from huggingface_hub import hf_hub_download
            return Path(hf_hub_download(self.hf_repo, filename=filename))
        except Exception as exc:
            raise RuntimeError(f"Could not load {filename} from Hugging Face repository {self.hf_repo}: {exc}") from exc

    def load(self) -> None:
        """Load and validate the model and its exact class/preprocessing metadata."""
        if self.model is not None:
            return
        labels_path = self._asset("airwrite_multilingual.labels.json")
        preprocessing_path = self._asset("airwrite_multilingual.preprocessing.json")
        if self.model_path.is_file():
            model_path = self.model_path
        else:
            if not self.hf_repo:
                raise RuntimeError(f"Model file not found: {self.model_path}")
            try:
                from huggingface_hub import hf_hub_download
                model_path = Path(hf_hub_download(self.hf_repo, filename=self.model_path.name))
            except Exception as exc:
                raise RuntimeError(f"Could not download the multilingual model from {self.hf_repo}: {exc}") from exc

        with labels_path.open(encoding="utf-8") as file:
            labels = json.load(file)
        with preprocessing_path.open(encoding="utf-8") as file:
            metadata = json.load(file)
        if not isinstance(labels, list) or len(labels) != 74 or not all(isinstance(label, str) and label for label in labels):
            raise RuntimeError("The multilingual label file must contain exactly 74 non-empty labels")
        if len(set(labels)) != 74:
            raise RuntimeError("The multilingual label file contains duplicate labels")
        if metadata.get("input_shape") != [28, 28, 1] or metadata.get("range") != [0, 1]:
            raise RuntimeError("Model preprocessing metadata must specify a 28x28x1 input in the [0, 1] range")
        if metadata.get("color") != "grayscale" or metadata.get("foreground") != "white" or metadata.get("background") != "black":
            raise RuntimeError("Model preprocessing metadata must specify white strokes on a black grayscale background")
        if metadata.get("label_count") != len(labels):
            raise RuntimeError("Preprocessing metadata label_count does not match the label file")
        groups = metadata.get("class_groups")
        expected_groups = {
            "english_letters": [0, 25],
            "arabic_letters": [26, 53],
            "western_digits": [54, 63],
            "arabic_indic_digits": [64, 73],
        }
        if groups != expected_groups:
            raise RuntimeError("Model class_groups do not match the documented 74-class layout")

        try:
            import tensorflow as tf
            model = tf.keras.models.load_model(model_path, compile=False)
        except Exception as exc:
            raise RuntimeError(f"Could not load the multilingual Keras checkpoint: {exc}") from exc
        input_shape = tuple(model.input_shape)
        output_shape = tuple(model.output_shape)
        if input_shape[1:] != (28, 28, 1) or output_shape[-1] != len(labels):
            raise RuntimeError(
                f"Checkpoint shape mismatch: expected (None, 28, 28, 1) -> 74, got {input_shape} -> {output_shape}"
            )
        self.model_path = model_path
        self.model = model
        self.labels = labels
        self.groups = groups
        self.preprocessing = metadata
        logger.info("Loaded multilingual model %s with %d labels", model_path, len(labels))

    def predict_png(self, data: bytes, mode: str = "auto") -> dict:
        if mode not in {"auto", *MODE_GROUPS}:
            raise ValueError("Mode must be auto, english, arabic, or numbers")
        if self.model is None:
            raise RuntimeError("Multilingual image model is not loaded")
        image = _read_png(data)
        batch = preprocess_image(image)
        if not np.any(batch):
            raise ValueError("Image is blank; draw or upload a character first")

        started = time.perf_counter()
        try:
            scores = np.asarray(self.model.predict(batch, verbose=0), dtype=np.float64)
        except Exception as exc:
            raise RuntimeError(f"Multilingual model inference failed: {exc}") from exc
        inference_ms = (time.perf_counter() - started) * 1000
        if scores.shape != (1, len(self.labels)) or not np.isfinite(scores).all():
            raise RuntimeError(f"Model returned invalid scores with shape {scores.shape}")
        scores = scores[0]
        is_probability_output = bool(np.all(scores >= 0) and np.isclose(scores.sum(), 1.0, atol=0.02))
        if not is_probability_output:
            shifted = scores - scores.max()
            exp_scores = np.exp(shifted)
            scores = exp_scores / exp_scores.sum()

        if mode == "auto":
            indices = list(range(len(self.labels)))
        else:
            indices = [
                index
                for group_name in MODE_GROUPS[mode]
                for index in range(self.groups[group_name][0], self.groups[group_name][1] + 1)
            ]
        top_ids = sorted(indices, key=lambda index: float(scores[index]), reverse=True)[:3]
        best_id = top_ids[0]
        return {
            "prediction": self.labels[best_id],
            "class_id": best_id,
            "mode": mode,
            "score": float(scores[best_id]),
            "top3": [{"character": self.labels[index], "class_id": index, "score": float(scores[index])} for index in top_ids],
            "inference_ms": inference_ms,
            "model": "airwrite-multilingual-74",
            "score_normalization": "original model probabilities" if is_probability_output else "softmax over all 74 model outputs",
            "preview_png": preview_png(batch),
        }
