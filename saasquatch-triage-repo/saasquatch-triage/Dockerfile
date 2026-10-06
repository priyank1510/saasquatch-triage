# API + frontend in one small image. SQLite lives on a mounted volume at /data.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    TRIAGE_DB_PATH=/data/triage.db TRIAGE_FRONTEND_DIR=/app/frontend
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend backend
COPY frontend frontend
RUN mkdir -p /data && useradd --create-home app && chown app /data
USER app
WORKDIR /app/backend
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:' + __import__('os').getenv('PORT', '8000') + '/api/health')"
CMD ["sh", "-c", "uvicorn triage_api.app:app --host 0.0.0.0 --port ${PORT:-8000} --workers 2"]
