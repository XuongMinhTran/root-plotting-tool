# Backend image: CERN ROOT (with PyROOT) + Flask.
#
# Build (from the repo root):   docker build --platform linux/amd64 -t rootfit-backend backend
# Run:                          docker run --rm -p 8000:8000 rootfit-backend
#
# rootproject/root is the official ROOT image (Ubuntu + ROOT + python3 + numpy).
# "latest" tracks the newest ROOT release; pin a tag such as
# rootproject/root:6.32.02-ubuntu24.04 once everything works, so future
# rebuilds stay reproducible.
FROM rootproject/root:latest

# Flask is the only extra Python package. Newer Ubuntu images make pip refuse
# to install into the system Python unless told it's fine, hence the fallback.
RUN python3 -m pip install --no-cache-dir flask numpy \
    || python3 -m pip install --no-cache-dir --break-system-packages flask numpy

WORKDIR /app
COPY . /app

# Log lines appear immediately in `docker logs` instead of being buffered.
ENV PYTHONUNBUFFERED=1

EXPOSE 8000
CMD ["python3", "app.py"]
