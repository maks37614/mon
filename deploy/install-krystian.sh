#!/usr/bin/env bash
# Install only the independent krystian bot. Never modify evgen-mon or h00k-app.
set -Eeuo pipefail
umask 077
if [[ $(id -u) -ne 0 ]]; then echo 'Use sudo bash deploy/install-krystian.sh' >&2; exit 1; fi
for exe in docker curl systemctl git; do
  command -v "$exe" >/dev/null || { echo "Missing: $exe" >&2; exit 1; }
done
root=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
[[ $(git -C "$root" branch --show-current) == feature/krystian-hook-feed ]] ||
  { echo 'Expected feature/krystian-hook-feed checkout.' >&2; exit 1; }
[[ -z $(git -C "$root" status --porcelain) ]] ||
  { echo 'Checkout has local changes. Refusing unreproducible deployment.' >&2; exit 1; }
if docker inspect krystian-mon >/dev/null 2>&1; then
  echo 'krystian-mon already exists. No automatic overwrite.' >&2; exit 1
fi
if [[ -d /var/lib/krystian-mon && -n $(ls -A /var/lib/krystian-mon) ]]; then
  echo 'Krystian state already exists. Manual migration required.' >&2; exit 1
fi
if ss -lnt '( sport = :3011 )' | grep -q LISTEN; then
  echo 'Port 3011 already occupied.' >&2; exit 1
fi
revision=$(git -C "$root" rev-parse --short=12 HEAD)
image="krystian-mon:$revision"
docker build --pull -t "$image" "$root"

if [[ ! -f /etc/krystian-mon.env ]]; then
  read -r -s -p 'New Krystian admin password (12+ characters): ' password
  echo
  hash=$(printf '%s' "$password" | docker run --rm -i --entrypoint node "$image" scripts/password.mjs --stdin)
  unset password
  setup=$(mktemp -d /var/lib/krystian-mon-setup.XXXXXX)
  trap 'rm -f "$setup/krystian-mon.env"; rmdir "$setup" 2>/dev/null || true' EXIT
  docker run --rm --user 0 --env MON_SETUP_PASSWORD_HASH="$hash" \
    --env MON_SETUP_ORIGIN=https://krystian.h00k.top \
    --mount "type=bind,src=$setup,dst=/setup" \
    --entrypoint node "$image" scripts/configure.mjs /setup/krystian-mon.env
  unset hash
  install -m 600 "$setup/krystian-mon.env" /etc/krystian-mon.env
  sed -i -e 's|^PORT=3010$|PORT=3011|' -e 's|^DATA_DIR=/var/lib/evgen-mon$|DATA_DIR=/data|' /etc/krystian-mon.env
  read -r -s -p 'HOOK_PAPER_FEED_TOKEN from h00k.top (32+ characters): ' token
  echo
  if [[ ${#token} -lt 32 || "$token" == *$'\n'* ]]; then
    echo 'Invalid source feed token.' >&2; exit 1
  fi
  printf 'MON_MARKET_SOURCE=hook\nHOOK_MARKET_FEED_URL=https://h00k.top\nHOOK_MARKET_FEED_TOKEN=%s\n' "$token" >> /etc/krystian-mon.env
  unset token
  rm -f "$setup/krystian-mon.env"
  rmdir "$setup"
  trap - EXIT
fi
chmod 600 /etc/krystian-mon.env

# Validate the actual h00k feed before launching a container.
docker run --rm --env-file /etc/krystian-mon.env --entrypoint node "$image" -e '
(async()=>{
  const base=process.env.HOOK_MARKET_FEED_URL;
  const token=process.env.HOOK_MARKET_FEED_TOKEN;
  if(process.env.MON_MARKET_SOURCE!=="hook" || !base || !token || token.length<32 ||
    process.env.APP_ORIGIN!=="https://krystian.h00k.top" ||
    process.env.ENABLE_LIVE_TRADING!=="false") throw Error("Krystian requires the independent paper-only hook configuration");
  const response=await fetch(base+"/api/mon/feed",{
    headers:{Authorization:"Bearer "+token},signal:AbortSignal.timeout(10000)
  });
  if(!response.ok) throw Error("h00k feed not deployed/available: HTTP "+response.status);
  const data=await response.json();
  if(data.success!==true || data.version!==1 || !Array.isArray(data.snapshots) || !Array.isArray(data.density))
    throw Error("Unexpected h00k feed version");
  console.log("h00k verified feed available; cached snapshot groups:",data.snapshots.length);
})().catch(error=>{console.error(error.message);process.exit(1)});
'
install -d -m 700 -o 1000 -g 1000 /var/lib/krystian-mon
docker run -d --name krystian-mon --restart unless-stopped \
  --memory 768m --memory-swap 768m --cpus 0.5 --pids-limit 128 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=32m \
  --env-file /etc/krystian-mon.env --env HOST=0.0.0.0 \
  --env PORT=3011 --env DATA_DIR=/data --env ENABLE_LIVE_TRADING=false \
  --mount type=bind,src=/var/lib/krystian-mon,dst=/data \
  --publish 127.0.0.1:3011:3011 "$image"
healthy=false
for ((i=0;i<40;i++)); do
  if curl -fsS --max-time 2 http://127.0.0.1:3011/healthz |
    docker exec -i krystian-mon node -e '
      let t="";process.stdin.on("data",c=>t+=c);process.stdin.on("end",()=>{
        try{const x=JSON.parse(t);process.exit(x.app==="mon"&&x.ok===true?0:1)}
        catch{process.exit(1)}});
    '; then healthy=true; break; fi
  sleep 1
done
if [[ "$healthy" != true ]]; then
  docker logs --tail=60 krystian-mon >&2 || true
  docker rm -f krystian-mon
  echo 'Krystian failed health check. Old services not touched.' >&2
  exit 1
fi
if systemctl is-active --quiet caddy && [[ -f /etc/caddy/Caddyfile ]]; then
  if ! grep -Eq '^[[:space:]]*krystian[.]h00k[.]top[[:space:]]*[{]' /etc/caddy/Caddyfile; then
    cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.before-krystian-$(date +%s)"
    cat >> /etc/caddy/Caddyfile <<'CADDY'

krystian.h00k.top {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3011
}
CADDY
    if ! caddy validate --config /etc/caddy/Caddyfile || ! systemctl reload caddy; then
      echo 'Caddy update failed; restore the saved Caddyfile before using HTTPS.' >&2
      exit 1
    fi
  fi
else
  echo 'Caddy is not active: configure HTTPS krystian.h00k.top -> 127.0.0.1:3011 manually.'
fi
echo 'Krystian running at https://krystian.h00k.top (subject to DNS/HTTPS).'
echo 'Separate /var/lib/krystian-mon and /etc/krystian-mon.env. PAPER ONLY.'
echo 'Existing evgen-mon and h00k-app were not modified.'
