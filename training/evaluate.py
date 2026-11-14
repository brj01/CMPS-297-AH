"""Evaluation entry point reserved for participant-held-out model evaluation."""
import argparse
from pathlib import Path
from .dataset_loader import load_recordings

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("data", type=Path)
    args = parser.parse_args()
    print({"recordings": len(load_recordings(args.data)), "status": "dataset inventory only"})

if __name__ == "__main__":
    main()
