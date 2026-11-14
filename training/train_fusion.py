"""Training entry point.

The model architecture and preprocessing metadata must be supplied from the
verified research notebook; this script deliberately refuses to invent them.
"""
import argparse
from pathlib import Path
from .dataset_loader import load_recordings

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("data", type=Path)
    args = parser.parse_args()
    recordings = load_recordings(args.data)
    if not recordings:
        raise SystemExit("No recordings found")
    raise SystemExit("Provide the verified SCLAiR architecture and participant split before training.")

if __name__ == "__main__":
    main()
