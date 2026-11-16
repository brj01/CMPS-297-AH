import asyncio
import app
from processing.segmentation import State

def test_failed_classification_returns_segmenter_to_idle(monkeypatch):
    monkeypatch.setattr(app.classifier, "model", object())
    def boom(*_args, **_kwargs):
        raise ValueError("Times must be in strictly increasing order.")
    monkeypatch.setattr(app.classifier, "predict_samples", boom)
    app.segmenter.state = State.PROCESSING
    segment = [{"timestamp": 1.0, "acc": (0, 0, 1), "gyro": (0, 0, 0)},
               {"timestamp": 1.1, "acc": (0, 0, 1), "gyro": (0, 0, 0)}]
    result = asyncio.run(app.classify_segment(segment))
    assert result["status"] == "error" and "strictly increasing" in result["error"]
    assert app.segmenter.state == State.IDLE

def test_missing_model_also_returns_segmenter_to_idle(monkeypatch):
    monkeypatch.setattr(app.classifier, "model", None)
    app.segmenter.state = State.PROCESSING
    result = asyncio.run(app.classify_segment([{"timestamp": 1.0}, {"timestamp": 1.1}]))
    assert result["status"] == "error"
    assert app.segmenter.state == State.IDLE
