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
