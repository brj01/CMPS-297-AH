from config import HF_REPO, HF_REVISION, MODEL_DIR
from recognition.model_downloader import ModelDownloader

if __name__ == "__main__":
    print(ModelDownloader(MODEL_DIR, HF_REPO, HF_REVISION).download())
