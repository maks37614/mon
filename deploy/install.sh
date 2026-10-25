#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ $(id -u) != 0 ]]; then
  echo 'Запустіть: sudo bash deploy/install.sh' >&2
  exit 1
fi
if ! command -v node >/dev/null || ! node -e 'const [a,b,c]=process.versions.node.split(".").map(Number);process.exit(a>24||(a===24&&(b>22||(b===22&&c>=1)))?0:1)'; then
  echo 'Потрібні оновлений Node.js 24 LTS (24.22.1+) і npm. Встановіть їх з офіційного джерела перед запуском.' >&2
  exit 1
fi
for mon_command in npm tar systemctl curl; do
  command -v "$mon_command" >/dev/null || { echo "Потрібна команда: $mon_command" >&2; exit 1; }
done
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
if [[ ! -f "$source_dir/package-lock.json" ]]; then echo 'Відсутній package-lock.json' >&2; exit 1; fi
release_id=$(date -u +%Y%m%dT%H%M%SZ)
release_dir="/opt/evgen-mon/releases/$release_id"
if ! id evgen-mon >/dev/null 2>&1; then useradd --system --home-dir /opt/evgen-mon --shell /usr/sbin/nologin evgen-mon; fi
install -d -m 755 /opt/evgen-mon /opt/evgen-mon/releases
install -d -m 700 -o evgen-mon -g evgen-mon /var/lib/evgen-mon /var/cache/evgen-mon
install -d -m 755 -o evgen-mon -g evgen-mon "$release_dir"
tar -C "$source_dir" --exclude=.git --exclude=node_modules --exclude=dist --exclude=build --exclude=data --exclude='.env*' --exclude='.test-*' -cf - . | tar -C "$release_dir" -xf -
chown -R evgen-mon:evgen-mon "$release_dir"
runuser -u evgen-mon -- env npm_config_cache=/var/cache/evgen-mon bash -c 'cd "$1" && npm ci --no-audit --no-fund && npm run typecheck && npm test && npm run build' bash "$release_dir"

if [[ ! -f /etc/evgen-mon.env ]]; then
  read -r -s -p 'Новий пароль входу (мінімум 12 символів): ' mon_password
  echo
  read -r -s -p 'Повторіть пароль: ' mon_password_again
  echo
  if [[ "$mon_password" != "$mon_password_again" ]]; then echo 'Паролі не збігаються' >&2; exit 1; fi
  mon_password_hash=$(printf '%s' "$mon_password" | node "$release_dir/scripts/password.mjs" --stdin)
  unset mon_password mon_password_again
  MON_SETUP_PASSWORD_HASH="$mon_password_hash" node "$release_dir/scripts/configure.mjs" /etc/evgen-mon.env
  unset mon_password_hash
fi
chmod 600 /etc/evgen-mon.env
previous_release=$(readlink -f /opt/evgen-mon/current 2>/dev/null || true)
if [[ -e /opt/evgen-mon/current && ! -L /opt/evgen-mon/current ]]; then echo '/opt/evgen-mon/current має бути симлінком, а не звичайним каталогом' >&2; exit 1; fi
ln -sfn "$release_dir" /opt/evgen-mon/current
install -m 644 "$release_dir/deploy/evgen-mon.service" /etc/systemd/system/evgen-mon.service
systemctl daemon-reload
systemctl enable evgen-mon.service
systemctl restart evgen-mon.service
mon_healthy=false
for ((mon_attempt=0; mon_attempt<20; mon_attempt++)); do
  if curl --fail --silent --max-time 2 http://127.0.0.1:3010/healthz | node -e 'let s=""; process.stdin.on("data",c=>s+=c); process.stdin.on("end",()=>{try{const v=JSON.parse(s);process.exit(v.ok===true&&v.app==="mon"?0:1)}catch{process.exit(1)}})'; then mon_healthy=true; break; fi
  sleep 1
done
if [[ "$mon_healthy" != true ]]; then
  echo 'Перевірка запуску не пройшла. Перегляньте journalctl -u evgen-mon.' >&2
  if [[ -n "$previous_release" ]]; then ln -sfn "$previous_release" /opt/evgen-mon/current; systemctl restart evgen-mon.service; fi
  exit 1
fi
echo 'Застосунок працює на 127.0.0.1:3010. Поточні налаштування h00k.top не змінювалися.'
echo 'Наступні кроки: окремий DNS-запис evgen, HTTPS virtual host та Authorization header у cron-job.org.'
echo 'Секрет cron міститься у /etc/evgen-mon.env; не публікуйте його та не додавайте в URL.'
