FROM public.ecr.aws/docker/library/python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV AWS_EC2_METADATA_DISABLED=true

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        libexpat1 \
    && rm -rf /var/lib/apt/lists/*

COPY scripts/radar/requirements.txt /tmp/radar-requirements.txt
COPY infra/aws/level2-renderer/requirements.txt /tmp/renderer-requirements.txt

RUN python -m pip install --upgrade pip \
    && python -m pip install --no-cache-dir \
        -r /tmp/radar-requirements.txt \
        -r /tmp/renderer-requirements.txt \
    && python - <<'PY'
import numpy
import PIL
import pyproj
import rasterio
import metpy
from metpy.io import Level2File

print("Dependency check OK")
print("rasterio", rasterio.__version__)
print("metpy", metpy.__version__)
PY

COPY scripts ./scripts
COPY infra/aws/level2-renderer/batch_entrypoint.py ./infra/aws/level2-renderer/batch_entrypoint.py

ENTRYPOINT ["python", "/app/infra/aws/level2-renderer/batch_entrypoint.py"]
