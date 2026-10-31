#!/usr/bin/env bash
# Docker migration for the verified VPS layout: evgen-mon -> mon.
# Usage: sudo bash deploy/migrate-evgen-to-mon.sh migrate
#        sudo bash deploy/migrate-evgen-to-mon.sh cleanup
set -Eeuo pipefail
umask 077
if [[ $# -ne 1 || ( "$1" != migrate && "$1" != cleanup ) || $(id -u) != 0 ]]; then
  echo "Usage: sudo bash deploy/migrate-evgen-to-mon.sh migrate|cleanup" >&2
  exit 2
fi
for executable in docker curl git systemctl; do
  command -v "$executable" >/dev/null || { echo "Missing $executable" >&2; exit 2; }
done
healthy() {
  [[ $(docker inspect -f '{{.State.Running}}' mon 2>/dev/null) == true ]] &&
  curl -fsS --max-time 3 http://127.0.0.1:3010/healthz |
    docker exec -i mon node -e '
      let s="";process.stdin.on("data",c=>s+=c);
      process.stdin.on("end",()=>{try {const j=JSON.parse(s);process.exit(j.ok===true&&j.app==="mon"?0:1)}
        catch {process.exit(1)}});
    '
}
if [[ "$1" == cleanup ]]; then
  healthy || { echo "mon is not healthy; refusing cleanup." >&2; exit 1; }
  [[ -f /etc/mon.env && -f /var/lib/mon/mon.sqlite && -f /root/mon-migration.backup ]] ||
    { echo "New data or backup marker missing; refusing cleanup." >&2; exit 1; }
  read -r backup < /root/mon-migration.backup
  [[ "$backup" == /root/mon-migration.* && -f "$backup/evgen-mon.env" && -f "$backup/data/mon.sqlite" ]] ||
    { echo "Cold backup not found; refusing cleanup." >&2; exit 1; }
  if systemctl is-active --quiet evgen-mon.service; then
    echo "Old systemd service is active; refusing cleanup." >&2; exit 1
  fi
  echo "New mon is healthy. Old env/data have cold backups in $backup."
  read -r -p 'Type DELETE-EVGEN to permanently remove old containers/config/data: ' reply
  [[ "$reply" == DELETE-EVGEN ]] || { echo "Cancelled."; exit 0; }
  while IFS= read -r name; do
    if [[ "$name" =~ ^evgen-mon($|-(new|previous|before-mon)-) ]]; then
      docker rm -f "$name"
    fi
  done < <(docker ps -a --format '{{.Names}}')
  while IFS= read -r name; do
    mounts=$(docker inspect -f '{{range .Mounts}}{{println .Source}}{{end}}' "$name")
    if printf '%s\n' "$mounts" | grep -Fxq /var/lib/evgen-mon; then
      echo "Other container $name uses old data; not deleting files." >&2; exit 1
    fi
  done < <(docker ps -a --format '{{.Names}}')
  rm -f -- /etc/evgen-mon.env
  rm -rf -- /var/lib/evgen-mon
  if [[ -f /etc/systemd/system/evgen-mon.service ]]; then
    systemctl disable evgen-mon.service >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/evgen-mon.service
    systemctl daemon-reload
  fi
  # Do not remove /opt/evgen-mon without checking whether another process uses it.
  while IFS= read -r image; do
    if [[ "$image" == evgen-mon:* ]]; then
      docker image rm "$image" || true
    fi
  done < <(docker image ls --format '{{.Repository}}:{{.Tag}}')
  echo "Legacy Docker containers/images and original env/data removed."
  echo "Cold backup kept at $backup. Caddy and h00k-app-1 were untouched."
  exit 0
fi
docker inspect evgen-mon >/dev/null 2>&1 || { echo "evgen-mon missing." >&2; exit 1; }
if docker inspect mon >/dev/null 2>&1; then
  echo "mon container already exists; refusing overwrite." >&2; exit 1
fi
[[ -f /etc/evgen-mon.env && -f /var/lib/evgen-mon/mon.sqlite ]] ||
  { echo "Old env or database missing." >&2; exit 1; }
[[ ! -e /etc/mon.env && ! -e /var/lib/mon ]] ||
  { echo "New env/data already exist; refusing overwrite." >&2; exit 1; }
if systemctl is-active --quiet evgen-mon.service || systemctl is-active --quiet mon.service; then
  echo "Active systemd service; refusing to create a competing bot." >&2; exit 1
fi
old_mount=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' evgen-mon)
mount_count=$(docker inspect -f '{{len .Mounts}}' evgen-mon)
[[ "$old_mount" == /var/lib/evgen-mon && "$mount_count" == 1 ]] ||
  { echo "Unexpected old container mounts; stop and inspect." >&2; exit 1; }
curl -fsS --max-time 3 http://127.0.0.1:3010/healthz >/dev/null ||
  { echo "Old service health check failed." >&2; exit 1; }
# Require auto-entry disabled and zero real positions/pending intents.
docker exec evgen-mon node -e '
  const {DatabaseSync}=require("node:sqlite");
  const db=new DatabaseSync("/data/mon.sqlite",{readOnly:true});
  const read=(key,def)=>{const r=db.prepare("SELECT value FROM kv WHERE key=?").get(key);
    return r?JSON.parse(r.value):def};
  const settings=read("settings",{});
  const live=read("book:live",{positions:[],pending:[]});
  if(settings.autoEntries) {console.error("Disable automatic entries in the UI first.");process.exit(2)}
  if((live.positions||[]).length||(live.pending||[]).length) {
    console.error("Live positions or pending orders exist. Finish/reconcile them first.");process.exit(3)
  }
'
source_dir=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
[[ $(git -C "$source_dir" branch --show-current) == feature/edwin-strategy-builder ]] ||
  { echo "Build must come from the Ev-Test feature branch." >&2; exit 1; }
[[ -z $(git -C "$source_dir" status --porcelain) ]] ||
  { echo "Release source tree is dirty; refusing build." >&2; exit 1; }
revision=$(git -C "$source_dir" rev-parse --short=12 HEAD)
image="mon:ev-test-$revision"
echo "Building $image while the old bot continues serving traffic..."
docker build --pull -t "$image" "$source_dir"
backup=$(mktemp -d /root/mon-migration.XXXXXXXX)
cp -a /etc/evgen-mon.env "$backup/evgen-mon.env"
previous="evgen-mon-before-mon-$(date -u +%Y%m%dT%H%M%SZ)"
rollback_needed=false
committed=false
rollback() {
  if [[ "$rollback_needed" == true && "$committed" != true ]]; then
    echo "Cutover failed; restoring evgen-mon..." >&2
    docker rm -f mon >/dev/null 2>&1 || true
    if docker inspect "$previous" >/dev/null 2>&1; then
      docker rename "$previous" evgen-mon || true
    fi
    docker start evgen-mon || true
  fi
}
trap rollback EXIT
rollback_needed=true
docker stop --time 30 evgen-mon
cp -a /var/lib/evgen-mon "$backup/data"
[[ -s "$backup/data/mon.sqlite" ]] || { echo "Cold database backup failed." >&2; exit 1; }
cp -a /var/lib/evgen-mon /var/lib/mon
cp -a /etc/evgen-mon.env /etc/mon.env
chmod 600 /etc/mon.env
docker rename evgen-mon "$previous"
docker run -d --name mon --restart unless-stopped \
  --memory 768m --memory-swap 768m --cpus 0.5 --pids-limit 128 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=32m \
  --env-file /etc/mon.env --env HOST=0.0.0.0 --env DATA_DIR=/data \
  --mount type=bind,src=/var/lib/mon,dst=/data \
  --publish 127.0.0.1:3010:3010 "$image"
ready=false
for ((i=0;i<40;i++)); do
  if healthy; then ready=true; break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  docker logs --tail 60 mon >&2 || true
  echo "New mon failed health check." >&2; exit 1
fi
printf '%s\n' "$backup" > /root/mon-migration.backup
committed=true
trap - EXIT
echo "SUCCESS. mon healthy, data in /var/lib/mon, env in /etc/mon.env"
echo "Old stopped container: $previous; cold backup: $backup"
echo "After confirming login, history and settings at https://evgen.h00k.top, run cleanup."
