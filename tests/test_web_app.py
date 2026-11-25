import base64
import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

import web_app


@pytest.fixture
def client(monkeypatch):
    # Don't download or load the real model during tests.
    monkeypatch.setattr(web_app, "load_letters_model", lambda: None)
    with TestClient(web_app.app) as c:
        yield c


def png_data_url():
    image = Image.new("RGB", (64, 64), "black")
    ImageDraw.Draw(image).line((14, 12, 14, 50, 42, 50), fill="white", width=6)
    output = io.BytesIO()
    image.save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")


def test_page_and_gesture_files_are_served(client):
    page = client.get("/").text
    assert "AirWrite" in page
    assert 'id="tab-games"' in page and 'id="panel-games"' in page
    assert client.get("/js/game.js").status_code == 200
    assert client.get("/gestures/core.js").status_code == 200
    assert client.get("/gestures/model.json").json()["classes"]
    assert client.get("/demo/gestures.json").status_code == 200


def test_site_files_are_never_served_stale(client):
    for path in ("/", "/js/app.js", "/js/letters.js", "/css/site.css", "/gestures/core.js"):
        assert client.get(path).headers["cache-control"] == "no-cache", path


def test_training_data_and_old_demo_are_not_served(client):
    assert client.get("/gestures/all_training_windows.npz").status_code == 404
    assert client.get("/gestures/gesture_demo.html").status_code == 404


def test_predict_is_refused_while_model_unavailable(client, monkeypatch):
    monkeypatch.setitem(web_app.letters_status, "state", "unavailable")
    assert client.get("/api/health").json()["letters"]["state"] == "unavailable"
    assert client.post("/api/letters/predict", json={"image": png_data_url()}).status_code == 503


def test_predict_validates_input(client, monkeypatch):
    monkeypatch.setitem(web_app.letters_status, "state", "ready")
    assert client.post("/api/letters/predict", json={"image": "not a png"}).status_code == 422
    assert client.post("/api/letters/predict", json={"image": png_data_url(), "mode": "latin"}).status_code == 422


def test_predict_passes_png_and_mode_to_classifier(client, monkeypatch):
    seen = {}

    def fake_predict(image, mode):
        seen.update(image=image, mode=mode)
        return {
            "prediction": "ب", "class_id": 27, "mode": mode, "score": 0.8,
            "top3": [{"character": "ب", "class_id": 27, "score": 0.8}],
            "inference_ms": 3.0, "model": "airwrite-multilingual-74",
            "score_normalization": "original model probabilities", "preview_png": b"png",
        }

    monkeypatch.setitem(web_app.letters_status, "state", "ready")
    monkeypatch.setattr(web_app.image_classifier, "predict_png", fake_predict)
    data_url = png_data_url()
    res = client.post("/api/letters/predict", json={"image": data_url, "mode": "arabic"})
    assert res.status_code == 200
    body = res.json()
    assert body["prediction"] == "ب" and body["top3"][0]["character"] == "ب"
    assert seen["image"] == web_app.decode_png_data_url(data_url)
    assert seen["mode"] == "arabic"
    assert body["preview"].startswith("data:image/png;base64,")


def watch_payload(t, motion=True):
    v = 0.3 if motion else 0
    return {"timestamp": t, "acceleration_x": v, "acceleration_y": 0, "acceleration_z": v,
            "rotation_rate_x": v, "rotation_rate_y": 0, "rotation_rate_z": 0,
            "orientation_x": 1, "orientation_y": 2, "orientation_z": 3}


def test_watch_pairing_and_status(client):
    code = client.post("/api/watch/pair").json()["code"]
    assert len(code) == 6
    assert client.get(f"/api/watch/{code}/status").json()["receiving"] is False
    assert client.post(f"/api/watch/{code}", json=watch_payload(100.0)).json() == {"received": 1}
    batch = [watch_payload(100.0 + i / 50) for i in range(1, 11)]
    assert client.post(f"/api/watch/{code}", json=batch).json() == {"received": 10}
    status = client.get(f"/api/watch/{code}/status").json()
    assert status["receiving"] and status["samples"] == 11 and status["motion_fields"]
    assert client.post("/api/watch/NOPE00", json=watch_payload(1)).status_code == 404
    assert client.post(f"/api/watch/{code}", json=[1, 2]).status_code == 422
    client.delete(f"/api/watch/{code}")
    assert client.get(f"/api/watch/{code}/status").status_code == 404


def test_status_flags_payloads_without_motion_values(client):
    code = client.post("/api/watch/pair").json()["code"]
    client.post(f"/api/watch/{code}", json={"timestamp": 1.0, "batteryLevel": 0.8})
    assert client.get(f"/api/watch/{code}/status").json()["motion_fields"] is False


def test_watch_pairing_and_status(client):
    code = client.post("/api/watch/pair").json()["code"]
    assert len(code) == 6
    assert client.get(f"/api/watch/{code}/status").json()["receiving"] is False
    client.post(f"/api/watch/{code}", json=[watch_payload(100.0 + i / 50) for i in range(10)])
    status = client.get(f"/api/watch/{code}/status").json()
    assert status["receiving"] and status["samples"] == 10 and status["motion_fields"]
    assert client.post("/api/watch/NOPE00", json=watch_payload(1)).status_code == 404
    assert client.post(f"/api/watch/{code}", json=[1, 2]).status_code == 422
    client.delete(f"/api/watch/{code}")
    assert client.get(f"/api/watch/{code}/status").status_code == 404
