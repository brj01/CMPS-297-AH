from pathlib import Path
import json

def load_recordings(directory: Path) -> list[dict]:
    recordings = []
    for path in directory.glob("*.json"):
        recordings.append(json.loads(path.read_text(encoding="utf-8")))
    return recordings
