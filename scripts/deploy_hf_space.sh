okay #!/usr/bin/env bash
# Deploys the AirWrite website to a Hugging Face Space (Docker).
# Usage: scripts/deploy_hf_space.sh <hf-username>/<space-name>
# Needs: the Space created on huggingface.co (SDK: Docker), and `hf auth login`.
set -euo pipefail

SPACE="${1:?usage: scripts/deploy_hf_space.sh <hf-username>/<space-name>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HF="${HF:-}"
if [[ -z "$HF" ]]; then
  HF="$(command -v hf || true)"
fi
if [[ -z "$HF" ]]; then
  for candidate in "$ROOT/.venv/Scripts/hf.exe" "$ROOT/.venv/bin/hf"; do
    if [[ -x "$candidate" ]]; then
      HF="$candidate"
      break
    fi
  done
fi
if [[ -z "$HF" ]]; then
  echo "Hugging Face CLI not found. Install requirements-web.txt or set HF to its executable." >&2
  exit 1
fi
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

# Only what the website needs: no training data, recordings, models or secrets.
cp "$ROOT"/{Dockerfile,.dockerignore,requirements-web.txt,config.py,web_app.py,web_watch.py} "$BUILD"/
mkdir -p "$BUILD/sensors"
cp "$ROOT"/sensors/{__init__.py,apple_watch.py} "$BUILD/sensors/"
cp -r "$ROOT"/{processing,recognition,web} "$BUILD"/
mkdir -p "$BUILD/gestures"
cp "$ROOT"/gestures/{core.js,model.json} "$BUILD/gestures/"
cp "$ROOT/deploy/huggingface/README.md" "$BUILD/README.md"
find "$BUILD" -name __pycache__ -prune -exec rm -rf {} +

echo "Uploading to https://huggingface.co/spaces/$SPACE ..."
"$HF" upload "$SPACE" "$BUILD" . --repo-type space --commit-message "Deploy AirWrite website"
echo "Done. The Space rebuilds automatically; watch the build logs on its page."
