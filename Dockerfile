# Hostable AirWrite website (web_app.py). Works on Hugging Face Spaces (Docker)
# and Render. Set HF_TOKEN as a secret so the private letters model can download.
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=7860 \
    AIRWRITE_MODEL_DIR=/home/user/models

# Hugging Face Spaces runs containers as uid 1000.
RUN useradd -m -u 1000 user
WORKDIR /home/user/app

COPY requirements-web.txt .
RUN pip install --no-cache-dir -r requirements-web.txt

COPY --chown=user config.py web_app.py ./
COPY --chown=user processing processing
COPY --chown=user recognition recognition
COPY --chown=user gestures/core.js gestures/model.json gestures/
COPY --chown=user web web

USER user
EXPOSE 7860
CMD ["sh", "-c", "uvicorn web_app:app --host 0.0.0.0 --port ${PORT}"]
