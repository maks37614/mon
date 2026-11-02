#!/usr/bin/env bash
# Rebuild and replace only the independent paper-mode Krystian container.
# On failure, restore the old named container; retain its data and credentials.
set -Eeuo pipefail
umask 077
if [[ $(id -u) -ne 0 ]]; then echo "Run with sudo" >&2; exit 1; fi
for binary in docker git curl; do
  command -v "$binary" >/dev/null || { echo "Missing $binary" >&2; exit 1; }
done
root=$(cd "$(dirname "$0")/.." && pwd -P)
[[ $(git -C "$root" branch --show-current) == feature/krystian-hook-feed ]] ||
  { echo "Expected the feature/krystian-hook-feed branch" >&2; exit 1; }
[[ -z $(git -C "$root" status --porcelain) ]] ||
  { echo "Local source changes detected. Preserve and review them before updating." >&2; exit 1; }
docker inspect krystian-mon >/dev/null 2>&1 ||
  { echo "The krystian-mon container does not exist. Use the install workflow." >&2; exit 1; }
[[ -f /etc/krystian-mon.env && -d /var/lib/krystian-mon ]] ||
  { echo "Krystian config/data missing; refusing update" >&2; exit 1; }
grep -qx 'MON_MARKET_SOURCE=hook' /etc/krystian-mon.env ||
  { echo "Source is not h00k, refusing update" >&2; exit 1; }
grep -qx 'APP_ORIGIN=https://krystian.h00k.top' /etc/krystian-mon.env ||
  { echo "Unexpected app origin, refusing update" >&2; exit 1; }
grep -qx 'ENABLE_LIVE_TRADING=false' /etc/krystian-mon.env ||
  { echo "Live trading must be disabled for this paper-mode update" >&2; exit 1; }
revision=$(git -C "$root" rev-parse --short=12 HEAD)
new_image="krystian-mon:$revision"
echo "Building verified Krystian image $new_image (old bot stays running)"
docker build -t "$new_image" "$root"

stamp=$(date -u +%Y%m%d-%H%M%S)
backup_name="krystian-mon-preupdate-$stamp"
backup_dir="/root/krystian-updates/$stamp"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
cp -a /etc/krystian-mon.env "$backup_dir/krystian-mon.env"
docker inspect krystian-mon --format '{{.Image}}' > "$backup_dir/old-image-id"
stopped=false
renamed=false
complete=false
recover() {
  if [[ "$complete" == true ]]; then return; fi
  echo "Update did not finish; attempting to restore the original Krystian container." >&2
  if [[ "$renamed" == true ]]; then
    docker rm -f krystian-mon >/dev/null 2>&1 || true
    if docker rename "$backup_name" krystian-mon; then
      docker start krystian-mon || true
      echo "Old Krystian container restored. Other services were not touched." >&2
    else
      echo "Recovery needs attention: backup container $backup_name still exists." >&2
    fi
  elif [[ "$stopped" == true ]]; then
    docker start krystian-mon || true
  fi
}
trap recover EXIT
echo "Stopping only krystian-mon for a consistent backup"
docker stop krystian-mon
stopped=true
tar -C /var/lib -czpf "$backup_dir/krystian-data.tar.gz" krystian-mon
docker rename krystian-mon "$backup_name"
renamed=true
echo "Starting new Krystian container on local port 3011"
docker run -d --name krystian-mon --restart unless-stopped \
  --memory 768m --memory-swap 768m --cpus 0.5 --pids-limit 128 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=32m \
  --env-file /etc/krystian-mon.env --env HOST=0.0.0.0 \
  --env PORT=3011 --env DATA_DIR=/data --env ENABLE_LIVE_TRADING=false \
  --mount type=bind,src=/var/lib/krystian-mon,dst=/data \
  --publish 127.0.0.1:3011:3011 "$new_image" >/dev/null

healthy=false
for ((i=0;i<40;i++)); do
  if curl --silent --show-error --fail --max-time 2 \
    http://127.0.0.1:3011/healthz 2>/dev/null |
      grep -q '"ok":true'; then
    healthy=true
    break
  fi
  sleep 1
done
if [[ "$healthy" != true ]]; then
  echo "Krystian failed the HTTP health check" >&2
  docker logs --tail 25 krystian-mon >&2 || true
  exit 1
fi
complete=true
trap - EXIT
echo "Krystian updated and responding on port 3011."
echo "Rollback container: $backup_name (stopped; leave it intact until confirmed)."
echo "Protected backup directory: $backup_dir"
echo "Both h00k-app and evgen-mon were untouched."
