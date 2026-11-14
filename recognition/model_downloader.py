import json
import os
from pathlib import Path
from typing import Any

MODEL_FILES = {
    "airwrite_live.joblib", "model_config.json", "selection.json", "labels.json",
    "validation_results.csv", "fusion_results.csv", "6dmg_validation_results.csv",
    "feature_stats.npz", "test_metrics.json", "README.md", "requirements.txt",
    "raw6_frozen.keras", "raw6_fine.keras", "hybrid14_frozen.keras", "hybrid14_fine.keras",
}

class ModelDownloader:
    def __init__(self, directory: Path, repo_id: str, revision: str) -> None:
        self.directory, self.repo_id, self.revision = directory, repo_id, revision
        self.status: dict[str, Any] = {"state": "not_downloaded", "repo": repo_id, "revision": revision}

    def download(self) -> dict[str, Any]:
        try:
            from huggingface_hub import snapshot_download
        except ImportError as exc:
            raise RuntimeError("Install huggingface_hub before downloading models") from exc
        self.directory.mkdir(parents=True, exist_ok=True)
        if (self.directory / "airwrite_live.joblib").exists():
            self.status = {
                "state": "ready", "repo": self.repo_id, "revision": self.revision,
                "local_dir": str(self.directory), "source": "local_cache",
            }
            return self.status
        try:
            commit = snapshot_download(
                repo_id=self.repo_id, revision=self.revision,
                local_dir=self.directory, token=os.getenv("HF_TOKEN"),
                allow_patterns=list(MODEL_FILES),
                ignore_patterns=["**/checkpoint*", "**/recordings/**", "**/*.ckpt"],
            )
        except Exception as exc:
            self.status = {"state": "error", "repo": self.repo_id, "revision": self.revision, "error": str(exc)}
            raise RuntimeError(f"Could not download model bundle: {exc}") from exc
        self.status = {"state": "ready", "repo": self.repo_id, "revision": self.revision, "local_dir": str(commit)}
        (self.directory / "bundle_status.json").write_text(json.dumps(self.status, indent=2), encoding="utf-8")
        return self.status

    def read_status(self) -> dict[str, Any]:
        status_path = self.directory / "bundle_status.json"
        if status_path.exists():
            return json.loads(status_path.read_text(encoding="utf-8"))
        return self.status
