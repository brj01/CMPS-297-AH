import base64
import io

import numpy as np
import pytest
from PIL import Image, ImageDraw

from recognition.multilingual_image import (
    MultilingualImageClassifier,
    decode_png_data_url,
    preprocess_image,
)


def png_image(background="black", stroke="white"):
    image = Image.new("RGB", (96, 64), background)
    draw = ImageDraw.Draw(image)
    draw.line((24, 12, 24, 50, 64, 50), fill=stroke, width=5)
    draw.ellipse((66, 8, 72, 14), fill=stroke)
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def test_preprocessing_normalizes_polarities_and_keeps_disconnected_dots():
    positive = preprocess_image(Image.open(io.BytesIO(png_image())))
    inverted = preprocess_image(Image.open(io.BytesIO(png_image("white", "black"))))
    np.testing.assert_allclose(positive, inverted, atol=1 / 255)
    assert positive.shape == (1, 28, 28, 1)
    assert positive.dtype == np.float32
    assert 0 < float(positive.max()) <= 1
    pixels = (positive[0, :, :, 0] > 0.2).astype(np.uint8)
    assert pixels[0:5, :].sum() > 0
    assert pixels[4, 20:26].sum() > 0
    assert pixels[4, 2:20].sum() == 0


def test_blank_image_is_rejected():
    blank = Image.new("RGB", (50, 50), "black")
    with pytest.raises(ValueError, match="blank"):
        preprocess_image(blank)


def test_only_png_data_urls_are_accepted():
    with pytest.raises(ValueError, match="PNG"):
        decode_png_data_url("data:image/jpeg;base64,AAAA")
    with pytest.raises(ValueError, match="base64"):
        decode_png_data_url("data:image/png;base64,@@@")


def test_mode_filtering_uses_original_full_model_scores():
    classifier = MultilingualImageClassifier(model_path="unused.keras", hf_repo="")
    classifier.labels = [f"class-{index}" for index in range(74)]
    classifier.groups = {
        "english_letters": [0, 25],
        "arabic_letters": [26, 53],
        "western_digits": [54, 63],
        "arabic_indic_digits": [64, 73],
    }

    scores = np.full((1, 74), 0.0004, dtype=np.float32)
    scores[0, 27] = 0.7
    scores[0, 10] = 0.2
    scores[0, 60] = 0.05
    scores[0, 73] = 0.02
    scores[0, 11] = 0.0012

    class FakeModel:
        def predict(self, batch, verbose=0):
            assert batch.shape == (1, 28, 28, 1)
            return scores

    classifier.model = FakeModel()
    data = png_image()
    arabic = classifier.predict_png(data, "arabic")
    numbers = classifier.predict_png(data, "numbers")
    auto = classifier.predict_png(data)
    assert arabic["class_id"] == 27 and arabic["score"] == pytest.approx(0.7)
    assert [item["class_id"] for item in numbers["top3"]] == [60, 73, 54]
    assert auto["class_id"] == 27
    assert numbers["score_normalization"] == "original model probabilities"
