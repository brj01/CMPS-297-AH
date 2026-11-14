from pathlib import Path
import os
from dotenv import load_dotenv

load_dotenv()

ROOT = Path(__file__).parent
HOST = os.getenv("AIRWRITE_HOST", "127.0.0.1")
PORT = int(os.getenv("AIRWRITE_PORT", "8000"))
IMU_ADDRESS = os.getenv("AIRWRITE_IMU_ADDRESS", "E7:F8:C0:49:D9:44")
AUTO_CONNECT_IMU = os.getenv("AIRWRITE_AUTO_CONNECT_IMU", "true").lower() in {"1", "true", "yes"}
WATCH_TOKEN = os.getenv("AIRWRITE_WATCH_TOKEN", "")
COMMON_RATE_HZ = float(os.getenv("AIRWRITE_COMMON_RATE_HZ", "62"))
HF_REPO = os.getenv("AIRWRITE_HF_REPO", "Faisaljoudi/airwriting-6dmg-svm-fusion")
HF_REVISION = os.getenv(
    "AIRWRITE_HF_REVISION",
    "63d15843f95b1cbf5b2e1a2bfd2742a5d9468ade",
)
MODEL_DIR = Path(os.getenv("AIRWRITE_MODEL_DIR", str(ROOT / "models"))).resolve()
AUTO_DOWNLOAD = os.getenv("AIRWRITE_AUTO_DOWNLOAD", "true").lower() in {"1", "true", "yes"}
CONFIDENCE_THRESHOLD = float(os.getenv("AIRWRITE_CONFIDENCE_THRESHOLD", "0.2"))
SENSOR_MODE = os.getenv("AIRWRITE_SENSOR_MODE", "auto").lower()
RECORDINGS_DIR = ROOT / "data" / "recordings"
MODEL_MANAGEMENT_TOKEN = os.getenv("AIRWRITE_MODEL_MANAGEMENT_TOKEN", "")
