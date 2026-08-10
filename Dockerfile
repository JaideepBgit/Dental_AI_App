# ---------------------------------------------------------------------------
# Stage 1: build the React frontend
# ---------------------------------------------------------------------------
FROM node:20-slim AS frontend

WORKDIR /build

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./

# Empty API URL -> axios uses same-origin relative paths, so the API and the
# UI are served from one container on one port. src/services/apiClient.js falls
# back to http://localhost:8000 only when this is unset.
ENV VITE_API_URL=""
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: the application
# ---------------------------------------------------------------------------
FROM python:3.11-slim

# libgl1 + libglib2.0-0: OpenCV imports fail without them, even the headless
# build, which pulls in libGL via its Qt-less image codecs.
# ffmpeg: Whisper shells out to it to decode uploaded audio.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
        ffmpeg \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only Torch from PyTorch's index. Plain `torch` drags in ~2.5 GB of CUDA
# libraries that a t3.large can never use.
RUN pip install --no-cache-dir \
        --index-url https://download.pytorch.org/whl/cpu \
        torch torchvision

COPY requirements.txt .

# psycopg2-binary is the Postgres driver, needed for RDS. It is absent from
# requirements.txt because this app targets SQLite locally.
RUN pip install --no-cache-dir -r requirements.txt psycopg2-binary

# Bake the Whisper weights in, otherwise every container start re-downloads
# ~140 MB from OpenAI before the first transcription can run. main.py reads the
# same variable at runtime, so baking and loading always agree on the size.
ENV SMILEAI_WHISPER_MODEL=base
RUN python -c "import os, whisper; whisper.load_model(os.environ['SMILEAI_WHISPER_MODEL'])"

# auth.py is imported by main.py; seed_users.py is run once after first deploy
# to create the admin account, so it has to be in the image too.
COPY main.py db.py auth.py seed_users.py inference.py annotator.py referral.py watcher.py ./
COPY models/ ./models/

# Migrations. init_db() runs `alembic upgrade head` at startup, so the container
# cannot boot without these -- the whole COPY list here is explicit, and a
# missing alembic/ would only surface as a crash on the first start.
COPY alembic.ini ./
COPY alembic/ ./alembic/

COPY --from=frontend /build/dist ./frontend/dist

ENV DATA_DIR=/data
ENV PYTHONUNBUFFERED=1
# No GPU on t3.large; skip the CUDA probe at startup.
ENV SMILEAI_USE_GPU=0

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 \
    CMD curl -fsS http://localhost:8000/api/health || exit 1

# One worker: each would load its own ~1.5 GB Whisper copy, and two will not
# fit in 8 GB alongside Torch and YOLO.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
