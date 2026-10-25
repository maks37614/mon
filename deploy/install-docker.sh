#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ $(id -u) != 0 ]]; then
  echo 'Запустіть: sudo bash deploy/install-docker.sh' >&2
  exit 1
fi
for mon_command in docker curl systemctl install; do
  command -v "$mon_command" >/dev/null || { echo "Потрібна команда: $mon_command" >&2; exit 1; }
done
if systemctl is-active --quiet evgen-mon.service; then
  echo 'Наявний systemd-сервіс evgen-mon активний. Спочатку узгодьте його міграцію до Docker.' >&2
  exit 1
fi
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
release_id=$(date -u +%Y%m%dT%H%M%SZ)
image="evgen-mon:$release_id"
docker build --pull --tag "$image" "$source_dir"

if [[ ! -f /etc/evgen-mon.env ]]; then
  read -r -s -p 'Створіть пароль входу до термінала (мінімум 12 символів): ' mon_password
  echo
  read -r -s -p 'Повторіть пароль: ' mon_password_again
  echo
  if [[ "$mon_password" != "$mon_password_again" ]]; then echo 'Паролі не збігаються' >&2; exit 1; fi
  export MON_SETUP_PASSWORD_HASH
  MON_SETUP_PASSWORD_HASH=$(printf '%s' "$mon_password" | docker run --rm -i --entrypoint node "$image" scripts/password.mjs --stdin)
  unset mon_password mon_password_again
  setup_directory=$(mktemp -d /var/lib/evgen-mon-setup.XXXXXX)
  cleanup_setup() { rm -f "$setup_directory/evgen-mon.env"; rmdir "$setup_directory" 2>/dev/null || true; }
  trap cleanup_setup EXIT
  docker run --rm --user 0 --env MON_SETUP_PASSWORD_HASH \
    --mount "type=bind,src=$setup_directory,dst=/setup" \
    --entrypoint node "$image" scripts/configure.mjs /setup/evgen-mon.env
  unset MON_SETUP_PASSWORD_HASH
  install -m 600 "$setup_directory/evgen-mon.env" /etc/evgen-mon.env
  cleanup_setup
  trap - EXIT
fi
chmod 600 /etc/evgen-mon.env
install -d -m 700 -o 1000 -g 1000 /var/lib/evgen-mon

previous_container=""
if docker container inspect evgen-mon >/dev/null 2>&1; then
  previous_container="evgen-mon-previous-$release_id"
  docker stop --time 30 evgen-mon
  docker rename evgen-mon "$previous_container"
fi
rollback_container() {
  docker rm -f evgen-mon >/dev/null 2>&1 || true
  if [[ -n "$previous_container" ]]; then docker rename "$previous_container" evgen-mon; docker start evgen-mon; fi
}
if ! docker run -d --name evgen-mon --restart unless-stopped \
    --memory 768m --memory-swap 768m --cpus 0.5 --pids-limit 128 \
    --read-only --tmpfs /tmp:rw,noexec,nosuid,size=32m \
    --env-file /etc/evgen-mon.env --env HOST=0.0.0.0 --env DATA_DIR=/data \
    --mount type=bind,src=/var/lib/evgen-mon,dst=/data \
    --publish 127.0.0.1:3010:3010 "$image"; then
  rollback_container
  exit 1
fi
mon_healthy=false
for ((mon_attempt=0; mon_attempt<30; mon_attempt++)); do
  if curl --fail --silent --max-time 2 http://127.0.0.1:3010/healthz | docker exec -i evgen-mon node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const v=JSON.parse(s);process.exit(v.ok===true&&v.app==="mon"?0:1)}catch{process.exit(1)}})'; then
    mon_healthy=true
    break
  fi
  sleep 1
done
if [[ "$mon_healthy" != true ]]; then
  echo 'Health-перевірка не пройшла; повертаємо попередній контейнер.' >&2
  docker logs --tail 30 evgen-mon >&2 || true
  rollback_container
  exit 1
fi

if systemctl is-active --quiet caddy && [[ -f /etc/caddy/Caddyfile ]]; then
  if ! grep -Eq '^[[:space:]]*evgen[.]h00k[.]top[[:space:]]*[{]' /etc/caddy/Caddyfile; then
    caddy_backup="/etc/caddy/Caddyfile.before-evgen-$release_id"
    cp -a /etc/caddy/Caddyfile "$caddy_backup"
    printf '\n' >> /etc/caddy/Caddyfile
    cat "$source_dir/deploy/evgen.caddy" >> /etc/caddy/Caddyfile
    if ! caddy validate --config /etc/caddy/Caddyfile; then
      cp -a "$caddy_backup" /etc/caddy/Caddyfile
      echo 'Конфігурацію Caddy відновлено. Контейнер доступний лише локально на 3010.' >&2
      exit 1
    fi
    if ! systemctl reload caddy; then
      cp -a "$caddy_backup" /etc/caddy/Caddyfile
      systemctl reload caddy || true
      echo 'Попередню конфігурацію Caddy відновлено.' >&2
      exit 1
    fi
  fi
else
  echo 'Caddy не активний; додайте окремий virtual host з deploy/evgen.caddy вручну.'
fi

echo 'Готово: контейнер evgen-mon пройшов health-перевірку.'
echo 'Адреса: https://evgen.h00k.top | Логін: admin | Пароль: той, який ви щойно створили.'
echo 'У DNS-зоні h00k.top запис A для evgen має вказувати на 57.129.171.244.'
echo 'Після оновлення DNS Caddy отримає HTTPS-сертифікат автоматично.'
echo 'Реальна торгівля та автоматичні входи за замовчуванням вимкнені.'
echo 'Для cron-job.org: POST /api/cron/scan, Content-Type application/json, Authorization Bearer CRON_SECRET з /etc/evgen-mon.env.'
