"""Build web/demo/gestures.json: a short recording of all six gestures.

It stitches real windows from gestures/all_training_windows.npz together,
with still periods in between, so the website can show gesture recognition
without a sensor. Run:  python scripts/build_gesture_demo.py
"""
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
ORDER = ["swipe_right", "swipe_left", "swipe_up", "swipe_down", "circle_right", "circle_left"]


def main() -> None:
    data = np.load(ROOT / "gestures" / "all_training_windows.npz", allow_pickle=False)
    X, y = data["X"], data["y"]
    idle = X[y == "idle"]
    # Quietest idle windows, so pauses don't look like movement.
    quiet = idle[np.argsort([np.abs(w[:, 3:6]).max() for w in idle])][:12]
    rows = [quiet[0], quiet[1][:50]]
    for k, label in enumerate(ORDER):
        candidates = X[y == label]
        rows.append(candidates[len(candidates) // 2])  # a typical example, not the first one recorded
        rows += [quiet[(2 + 2 * k) % len(quiet)], quiet[(3 + 2 * k) % len(quiet)][:60]]
    sequence = np.concatenate(rows).round(3)
    out = ROOT / "web" / "demo" / "gestures.json"
    out.write_text(json.dumps({"rate": 100, "order": ORDER, "rows": sequence.tolist()}, separators=(",", ":")))
    print(f"wrote {out.relative_to(ROOT)}: {len(sequence)} samples ({len(sequence) / 100:.1f} s)")


if __name__ == "__main__":
    main()
