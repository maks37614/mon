#!/usr/bin/env bash
set -euo pipefail
umask 077

# Isolated installer for the ORIGINAL 2026-11-08 h00k-main.zip.
# Does not touch /home/ubuntu/h00k, /home/ubuntu/mon or their Docker projects.
ROOT="${OLD_H00K_STAGE_ROOT:-/home/ubuntu/h00k-old-stage}"
PORT="${OLD_STAGE_PORT:-3058}"
GITHUB_RAW="https://raw.githubusercontent.com/maks37614/mon"
SETUP_BASE="$GITHUB_RAW/deploy/isolated-h00k-old-stage/old-h00k-stage"
BACKUP_URL="$GITHUB_RAW/main/h00k-main.zip"
EXPECTED_SHA256="5941fa9f61fbd5fa0917ad8d3d4c248a14cb5bc04d13c24902df3791e75fd7d2"

if [[ "$ROOT" != /home/ubuntu/h00k-old-stage ]]; then
  echo "Refusing nonstandard destination. Set up only /home/ubuntu/h00k-old-stage." >&2
  exit 1
fi
if [[ ! "$PORT" =~ ^[0-9]{2,5}$ ]] || (( PORT > 65535 )); then
  echo "Invalid OLD_STAGE_PORT" >&2; exit 1
fi
for cmd in curl unzip python3 docker ss sha256sum; do
  command -v "$cmd" >/dev/null || { echo "Missing: $cmd" >&2; exit 1; }
done
docker compose version >/dev/null
if [[ -e "$ROOT/old-site" ]]; then
  echo "Stage source already exists at $ROOT/old-site. Nothing overwritten." >&2
  exit 1
fi
if ss -H -ltn | awk '{print $4}' | grep -Eq ":${PORT}$"; then
  echo "TCP port $PORT is busy. No containers were started." >&2
  exit 1
fi

mkdir -p "$ROOT"
echo "Downloading verified old backup from GitHub into $ROOT ..."
curl --fail --location --show-error --silent --retry 3 --max-time 180 \
  "$BACKUP_URL" --output "$ROOT/h00k-main.zip"
printf '%s  %s\n' "$EXPECTED_SHA256" "$ROOT/h00k-main.zip" | sha256sum --check --

for file in prepare.py Dockerfile.stage compose.stage.yaml; do
  curl --fail --location --show-error --silent --retry 3 \
    "$SETUP_BASE/$file" --output "$ROOT/$file"
done
mkdir -p "$ROOT/_extract"
unzip -q "$ROOT/h00k-main.zip" -d "$ROOT/_extract"
test -f "$ROOT/_extract/h00k-main/server.ts"
test -f "$ROOT/_extract/h00k-main/package-lock.json"
mv "$ROOT/_extract/h00k-main" "$ROOT/old-site"
rmdir "$ROOT/_extract"
cp "$ROOT/Dockerfile.stage" "$ROOT/old-site/Dockerfile.stage"
python3 "$ROOT/prepare.py" "$ROOT/old-site"

echo "Checking isolated Docker Compose configuration..."
docker compose -f "$ROOT/compose.stage.yaml" config -q
docker compose -f "$ROOT/compose.stage.yaml" up -d --build --no-deps app
docker compose -f "$ROOT/compose.stage.yaml" ps
printf '\nRead-only local health:\n'
curl --fail --silent --show-error --max-time 10 \
  "http://127.0.0.1:${PORT}/api/health" || true
printf '\nStaging is on 127.0.0.1:%s only. The production site and mon bots were not changed.\n' "$PORT"
