# AirWrite

AirWrite includes a local FastAPI/WebSocket IMU application and a hostable browser website. The website reconstructs IMU strokes and classifies completed character images with a multilingual CNN; the separate desktop application retains its existing SVM classifier.

## Windows 11 setup

1. Install Python 3.11 and enable Bluetooth.
2. Open PowerShell in this directory and run `.\start.bat` to start the desktop app (`app.py`).
3. For the browser website, use the separate `web_app.py` command in the Website section below.
4. In the desktop app, scan for the WitMotion device, select its address, and connect. BLE notification characteristics are discovered rather than hardcoded.
5. For SensorLog, send JSON POST requests to the URL shown by `/api/status`. Put the laptop and watch/iPhone on the same LAN. If `AIRWRITE_WATCH_TOKEN` is set, send it as `X-AirWrite-Token`; allow Python/port 8000 through Windows Firewall only on a trusted private network.

Create a virtual environment manually with `python -m venv .venv` and install with `.venv\Scripts\python.exe -m pip install -r requirements.txt`. The desktop launcher retains its SVM dependencies. The website's multilingual image classifier requires `requirements-web.txt`, including TensorFlow.

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

`web_app.py` serves a hostable website with two tabs: **Letters** (the 74-class multilingual image CNN) and **Gestures** (the random forest in `gestures/`). The browser connects to the sensor over Web Bluetooth, so the server never needs Bluetooth. For IMU letters, the browser preserves the reconstructed trajectory and submits a rasterized image to `POST /api/letters/predict`.

Run it locally (Chrome or Edge; `localhost` counts as secure for Web Bluetooth):

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-web.txt
.\.venv\Scripts\python.exe -m uvicorn web_app:app --host 127.0.0.1 --port 8000
```

Then open http://localhost:8000. On first startup, the website downloads the model checkpoint and its exact labels/preprocessing metadata from `Faisaljoudi/airwrite-multilingual-74`; it loads the model once and reports availability at `/api/health`. To use local assets instead, place `airwrite_multilingual.keras`, `airwrite_multilingual.labels.json`, and `airwrite_multilingual.preprocessing.json` in `models/`, or set `AIRWRITE_IMAGE_MODEL_PATH` to the checkpoint path. `AIRWRITE_IMAGE_HF_REPO` changes the Hugging Face repository. Hugging Face authentication is read from the environment, never exposed to the browser.

The Letters tab offers Auto, English, Arabic, and Numbers modes, an adjustable multi-stroke inactivity delay, and manual recognition for IMU-written characters. CNN predictions appear in the existing letter result area. The published test accuracies (English 82.17%, Arabic 95.63%, Western digits 94.98%, Arabic-Indic digits 99.05%) are results on the model's public image test sets, not measured AirWrite IMU accuracy. IMU-to-image recognition accuracy has not yet been evaluated.

### Hosting on Hugging Face Spaces

Web Bluetooth only works over HTTPS, which Spaces provides. The multilingual CNN is downloaded at startup from its configured Hugging Face repository. Add `HF_TOKEN` as a Space secret only if the model repository requires authentication.

1. On huggingface.co, create a new Space: SDK **Docker**, blank template. Choose public visibility if you want people to open it without logging in.
2. The model repo defaults to `Faisaljoudi/airwrite-multilingual-74`, which is public; no Space `HF_TOKEN` is needed for model downloads. Set `AIRWRITE_IMAGE_HF_REPO` only if you use another repo, and add `HF_TOKEN` as a Space secret only if that repo is private.
3. In PowerShell, authenticate the Hugging Face CLI with a token that can write to the Space:

   ```powershell
   .\.venv\Scripts\hf.exe auth login
   ```

   Then in Git Bash, deploy the current working tree:

   ```bash
   bash scripts/deploy_hf_space.sh <hf-username>/<space-name>
   ```

4. The Space builds the `Dockerfile` and serves the site at `https://<hf-username>-<space-name>.hf.space`. Wait for the build to finish and `/api/health` to report `image_model.state: ready`; the first start downloads and loads the CNN. Re-run the script to deploy updates.

The same `Dockerfile` also runs on Render (Docker web service; set `AIRWRITE_IMAGE_HF_REPO` or `HF_TOKEN` as needed).

### Apple Watch on the website

The **Apple Watch** panel next to the sensor gives each browser a pairing address, `https://<site>/api/watch/<code>`. Put it in SensorLog as an HTTP (JSON) streaming target. Pairings live in server memory and expire after 30 minutes without activity, so run a single server process. SensorLog's field names are read with the same aliases as the desktop app (`sensors/apple_watch.py`); the panel warns if data arrives without any recognised motion values. The website's image CNN classifies the reconstructed pen image; watch samples are still received by the existing pairing service but are not model inputs to this CNN.

The website's drawing and calibration path reconstructs the pen trajectory with a Kalman filter per room axis (position, speed, accelerometer error), and an RTS smoother for the finished strokes. **Calibrate** still asks for two seconds holding still, then one clockwise circle in front of you; this sets the writing plane, direction, scale, and the estimated relation between rotation and motion. The calibration resets when the sensor reconnects. On the website, each pause-terminated segment is kept as a separate stroke; after the adjustable inactivity delay, the completed character image is classified, so dots and multi-stroke characters can be included. As with all IMU-only position estimates, reconstruction accuracy depends on the sensor and motion and has not been benchmarked against the image model's public dataset metrics.

`scripts/build_gesture_demo.py` rebuilds `web/demo/gestures.json`, the sample recording behind "Play sample gestures".
