import math

import pytest
from fastapi.testclient import TestClient

import web_app


@pytest.fixture
def client(monkeypatch):
    # Don't download or load the real model during tests.
    monkeypatch.setattr(web_app, "load_letters_model", lambda: None)
    with TestClient(web_app.app) as c:
        yield c


def letter(n=60):
    return [{"t": 100 + i * 0.01, "acc": [0.1 * math.sin(i / 5), 0, 1], "gyro": [80 * math.sin(i / 5), 20, 0],
             "orientation": [5 * math.sin(i / 5), 2, i * 0.2]} for i in range(n)]


def test_page_and_gesture_files_are_served(client):
    assert "AirWrite" in client.get("/").text
    assert client.get("/gestures/core.js").status_code == 200
    assert client.get("/gestures/model.json").json()["classes"]
    assert client.get("/demo/gestures.json").status_code == 200


def test_training_data_and_old_demo_are_not_served(client):
    assert client.get("/gestures/all_training_windows.npz").status_code == 404
    assert client.get("/gestures/gesture_demo.html").status_code == 404


def test_predict_is_refused_while_model_unavailable(client, monkeypatch):
    monkeypatch.setitem(web_app.letters_status, "state", "unavailable")
    assert client.get("/api/health").json()["letters"]["state"] == "unavailable"
    assert client.post("/api/letters/predict", json={"samples": letter()}).status_code == 503


def test_predict_validates_input(client, monkeypatch):
    monkeypatch.setitem(web_app.letters_status, "state", "ready")
    assert client.post("/api/letters/predict", json={"samples": letter(1)}).status_code == 422
    bad = letter()
    bad[3]["gyro"] = [1, 2]
    assert client.post("/api/letters/predict", json={"samples": bad}).status_code == 422
    assert client.post("/api/letters/predict", json={"samples": letter(web_app.MAX_SAMPLES + 1)}).status_code == 422


def test_predict_passes_samples_to_classifier(client, monkeypatch):
    seen = {}

    def fake_predict(samples, threshold, mode):
        seen.update(samples=samples, mode=mode)
        return {"letter": "L", "accepted": True, "confidence": 0.8, "latency_ms": 3.0,
                "top3": [{"class_id": 11, "letter": "L", "score": 0.8},
                         {"class_id": 8, "letter": "I", "score": 0.4},
                         {"class_id": 4, "letter": "E", "score": 0.2}]}

    monkeypatch.setitem(web_app.letters_status, "state", "ready")
    monkeypatch.setattr(web_app.classifier, "predict_samples", fake_predict)
    res = client.post("/api/letters/predict", json={"samples": letter()})
    assert res.status_code == 200
    body = res.json()
    assert body["letter"] == "L" and [t["letter"] for t in body["top3"]] == ["L", "I", "E"]
    first = seen["samples"]["pen"][0]
    assert seen["mode"] == "auto" and "watch" not in seen["samples"] and set(first) == {"timestamp", "acc", "gyro", "orientation"}


def fake_classifier(monkeypatch, seen):
    def predict(samples, threshold, mode):
        seen.append({"sensors": sorted(samples), "mode": mode, "watch": samples.get("watch")})
        return {"letter": "A", "accepted": True, "confidence": 0.7, "latency_ms": 1.0,
                "top3": [{"class_id": 0, "letter": "A", "score": 0.7}]}
    monkeypatch.setitem(web_app.letters_status, "state", "ready")
    monkeypatch.setattr(web_app.classifier, "predict_samples", predict)


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


def test_letter_uses_watch_samples_from_the_same_moment(client, monkeypatch):
    seen = []
    fake_classifier(monkeypatch, seen)
    code = client.post("/api/watch/pair").json()["code"]
    # letter() spans t = 100.00 .. 100.59; watch samples before, during and long after it
    client.post(f"/api/watch/{code}", json=[watch_payload(t) for t in (90.0, 100.1, 100.3, 100.5, 120.0)])
    body = client.post("/api/letters/predict", json={"samples": letter(), "watch_code": code}).json()
    assert body["used_watch"] is True
    assert seen[-1]["sensors"] == ["pen", "watch"] and seen[-1]["mode"] == "auto"
    assert [s["timestamp"] for s in seen[-1]["watch"]] == [100.1, 100.3, 100.5]


def test_letter_falls_back_to_pen_without_matching_watch_data(client, monkeypatch):
    seen = []
    fake_classifier(monkeypatch, seen)
    code = client.post("/api/watch/pair").json()["code"]
    client.post(f"/api/watch/{code}", json=[watch_payload(t) for t in (10.0, 11.0)])
    for watch_code in (code, "GONE99"):
        body = client.post("/api/letters/predict", json={"samples": letter(), "watch_code": watch_code}).json()
        assert body["used_watch"] is False and seen[-1]["sensors"] == ["pen"]


def test_unusable_watch_data_does_not_cost_the_letter(client, monkeypatch):
    calls = []
    def predict(samples, threshold, mode):
        calls.append(sorted(samples))
        if "watch" in samples:
            raise ValueError("Sensor timestamps must be strictly increasing")
        return {"letter": "B", "accepted": True, "confidence": 0.6, "latency_ms": 1.0,
                "top3": [{"class_id": 1, "letter": "B", "score": 0.6}]}
    monkeypatch.setitem(web_app.letters_status, "state", "ready")
    monkeypatch.setattr(web_app.classifier, "predict_samples", predict)
    code = client.post("/api/watch/pair").json()["code"]
    client.post(f"/api/watch/{code}", json=[watch_payload(100.2), watch_payload(100.2)])
    body = client.post("/api/letters/predict", json={"samples": letter(), "watch_code": code}).json()
    assert body["letter"] == "B" and body["used_watch"] is False
    assert calls == [["pen", "watch"], ["pen"]]
