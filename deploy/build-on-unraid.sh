#!/bin/bash
#
# Builds and runs the grazing app on Unraid. Run this ON the Unraid server,
# from the directory holding the source.
#
#   ./deploy/build-on-unraid.sh
#
# Re-running it rebuilds the image and recreates the container. The data
# volume is left alone, so the map, its history and the imagery cache survive.
set -euo pipefail

IMAGE="grazing:latest"
NAME="grazing"
DATA="/mnt/user/appdata/grazing"
# 8080 is tank-monitor's.
PORT="${PORT:-8081}"

# Cloudflare Access values are deliberately not in git. Keep them in
# $DATA/local.env on the server (read first, because nothing ever overwrites
# the data directory) or deploy/local.env:
#
#   CF_ACCESS_TEAM_DOMAIN="yourteam"
#   CF_ACCESS_AUD="…"
HERE="$(cd "$(dirname "$0")" && pwd)"
for candidate in "$DATA/local.env" "$HERE/local.env"; do
  if [ -f "$candidate" ]; then
    echo "==> reading $candidate"
    # shellcheck disable=SC1091
    . "$candidate"
    break
  fi
done

PROPERTY_NAME="${PROPERTY_NAME:-Wealwandangie}"
TZ="${TZ:-Australia/Brisbane}"

# Leave these empty while the app is LAN-only. CF_ACCESS_REQUIRED stays true
# either way: it fails closed, so an unconfigured remote request is refused.
CF_ACCESS_TEAM_DOMAIN="${CF_ACCESS_TEAM_DOMAIN:-}"
CF_ACCESS_AUD="${CF_ACCESS_AUD:-}"
CF_ACCESS_REQUIRED="${CF_ACCESS_REQUIRED:-true}"
TRUSTED_PROXIES="${TRUSTED_PROXIES:-loopback,uniquelocal}"

echo "==> building $IMAGE"
docker build -t "$IMAGE" .

echo "==> ensuring data directory $DATA"
mkdir -p "$DATA"

if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "==> removing previous container (data volume is untouched)"
  docker rm -f "$NAME"
fi

echo "==> starting $NAME"
docker run -d \
  --name "$NAME" \
  --restart unless-stopped \
  -p "${PORT}:8080" \
  -v "${DATA}:/data" \
  -e PROPERTY_NAME="$PROPERTY_NAME" \
  -e TZ="$TZ" \
  -e CF_ACCESS_TEAM_DOMAIN="$CF_ACCESS_TEAM_DOMAIN" \
  -e CF_ACCESS_AUD="$CF_ACCESS_AUD" \
  -e CF_ACCESS_REQUIRED="$CF_ACCESS_REQUIRED" \
  -e TRUSTED_PROXIES="$TRUSTED_PROXIES" \
  "$IMAGE"

echo
echo "==> waiting for it to answer"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "up after ~${i}s"
    echo "app: http://$(hostname -i 2>/dev/null | awk '{print $1}'):${PORT}"
    exit 0
  fi
  sleep 1
done

echo "did not answer in 30s — recent logs:" >&2
docker logs --tail 40 "$NAME" >&2
exit 1
