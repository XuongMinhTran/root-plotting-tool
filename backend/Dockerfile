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

# The image has Python but no pip, so Flask comes from Ubuntu's package
# manager instead. numpy is listed too in case a future image drops it.
# The rm at the end just keeps the image small.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-flask python3-numpy \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . /app

# Log lines appear immediately in `docker logs` instead of being buffered.
ENV PYTHONUNBUFFERED=1

EXPOSE 8000
CMD ["python3", "app.py"]
