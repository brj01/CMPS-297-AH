# AirWrite

AirWrite is a local FastAPI/WebSocket application for IMU air-writing. The UI works in simulation mode without hardware; live predictions use the pinned private Hugging Face 6DMG SVM fusion bundle.

## Windows 11 setup

1. Install Python 3.11 and enable Bluetooth.
2. Open PowerShell in this directory and run `.\start.bat`.
3. Open http://localhost:8000.
4. Scan for the WitMotion device, select its address, and connect. BLE notification characteristics are discovered rather than hardcoded.
5. For SensorLog, send JSON POST requests to the URL shown by `/api/status`. Put the laptop and watch/iPhone on the same LAN. If `AIRWRITE_WATCH_TOKEN` is set, send it as `X-AirWrite-Token`; allow Python/port 8000 through Windows Firewall only on a trusted private network.

Create a virtual environment manually with `python -m venv .venv` and install with `.venv\Scripts\python.exe -m pip install -r requirements.txt`. The launcher updates the lightweight SVM dependencies on every start. The current `airwrite_live.joblib` model does not require TensorFlow. Optional legacy Keras support is listed separately in `requirements-keras.txt`; TensorFlow on Windows may require enabling long paths.

## Hugging Face models

Copy `.env.example` to `.env`, then set `HF_TOKEN` through your local environment or authenticate with `hf auth login`. The configured default repository is `Faisaljoudi/airwriting-6dmg-svm-fusion` at the supplied commit; change `AIRWRITE_HF_REPO` or `AIRWRITE_HF_REVISION` if needed. Download models with:

```powershell
.\.venv\Scripts\python.exe scripts\download_models.py
```

The same operation is available from `POST /api/models/download`; set `AIRWRITE_MODEL_MANAGEMENT_TOKEN` before enabling LAN access. The server never sends tokens to the browser. Downloaded files remain usable offline. The SVM loader validates the bundle's alphabet mapping, sample indices, classifier class IDs, and 186/372-feature contracts; it does not require legacy `labels.json` or `feature_order` metadata.

Automatic letter insertion remains disabled until `models\labels.json` contains an authoritative mapping with `"verified": true`. Do not replace it with A-Z ordering unless the original dataset confirms that mapping. A model's validation/test metrics are metadata, not live recognition accuracy.

## Diagnostics and limits

The UI's simulation is synthetic transport data, not classification accuracy. The packet parser supports the documented 20-byte `55 61` WT9011DCL-compatible payload, but scale factors and firmware must be verified against the device. SensorLog payloads are normalized with configurable aliases; inspect the raw body in a development request before finalizing a production field mapping. No model is fabricated when `.keras` files are absent.

The current application includes the live acquisition path, watch receiver, timestamped buffers, interpolation helper, segmentation state machine, pen/watch reciprocal-rank fusion, calibration, recording, prediction history, text controls, and focused unit tests. The Bluetooth driver retries a connection after an unexpected disconnect.

## Website (letters + gestures)

`web_app.py` serves a hostable website with two tabs: **Letters** (the SVM letters model) and **Gestures** (the random forest in `gestures/`). The browser connects to the sensor over Web Bluetooth, so one connection feeds both tabs and the server never needs Bluetooth. Gestures are recognised in the browser; for letters, the browser detects each letter and sends only that letter's motion to `POST /api/letters/predict`, so the private model stays on the server.

Run it locally (Chrome or Edge; `localhost` counts as secure for Web Bluetooth):

```bash
.venv/bin/pip install -r requirements-web.txt
.venv/bin/python -m uvicorn web_app:app --port 8000
```

Then open http://localhost:8000. Without the model the site still runs: gestures work, and the Letters tab draws your strokes and says recognition is unavailable.

### Hosting on Hugging Face Spaces

Web Bluetooth only works over HTTPS, which Spaces provides. The letters model is downloaded at startup using the `HF_TOKEN` secret.

1. On huggingface.co, create a new Space: SDK **Docker**, blank template, visibility **Public** (so people can open it without logging in).
2. In the Space's **Settings → Variables and secrets**, add a secret `HF_TOKEN` with a token that can read the letters model repository.
3. Deploy from this repo (needs `hf auth login` with a token that has write access to the Space):

   ```bash
   scripts/deploy_hf_space.sh <hf-username>/<space-name>
   ```

4. The Space builds the `Dockerfile` and goes live at `https://<hf-username>-<space-name>.hf.space`. Re-run the script to deploy updates.

The same `Dockerfile` also runs on Render (Docker web service; set `HF_TOKEN` as an environment variable).

### Apple Watch on the website

The **Apple Watch** panel next to the sensor gives each browser a pairing address, `https://<site>/api/watch/<code>`. Put it in SensorLog as an HTTP (JSON) streaming target; each letter is then classified with both pen and watch, matching watch samples by timestamp (±0.25 s, as in the desktop app). Pairings live in server memory and expire after 30 minutes without activity, so run a single server process. SensorLog's field names are read with the same aliases as the desktop app (`sensors/apple_watch.py`); the panel warns if data arrives without any recognised motion values.

The letter drawing is only a picture for the writer: by default it reconstructs the pen's path from its acceleration (gravity removed using orientation, drift removed by assuming the pen is still before and after a letter). The trace settings can switch to the simpler tilt-based drawing.

`scripts/build_gesture_demo.py` rebuilds `web/demo/gestures.json`, the sample recording behind "Play sample gestures".
