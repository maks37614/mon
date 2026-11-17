# h00k old backup — isolated VPS preview

**Source:** exact file `maks37614/mon/main/h00k-main.zip` (2026-11-08).

SHA-256: `5941fa9f61fbd5fa0917ad8d3d4c248a14cb5bc04d13c24902df3791e75fd7d2`.

## Safety
- The normal h00k.top checkout in `/home/ubuntu/h00k` is NEVER touched.
- The normal `mon` bots are NEVER touched.
- The installer downloads the original ZIP **directly** from GitHub and verifies its SHA-256.
- Files are extracted to `/home/ubuntu/h00k-old-stage/old-site` and patched **only inside that copy**.
- Separate Docker project `h00k-old-stage`, loopback port `127.0.0.1:3058`, 0.5 CPU, 1024 MB RAM.
- Old Telegram bot, background CRON, monitoring and depth WS starters are disabled.
- Old Firebase boot connection disabled, config swapped for placeholder. All API writes and private GET routes denied.
- Some old features will not work: no Firebase account, Telegram, private alerts, or user authentication. Public read-only chart APIs are rate limited.
- The old site's static UI, CSS and candles remain the same. The installer changes the HTML page title and adds noindex.
- Never pass the production `.env` file to this container.

## Install from GitHub (on VPS)
Save the script separately first so you can inspect it:

```bash
cd /home/ubuntu
curl -fL --retry 3 -o install-old-h00k-stage.sh \
  https://raw.githubusercontent.com/maks37614/mon/deploy/isolated-h00k-old-stage/old-h00k-stage/install.sh

sed -n '1,220p' install-old-h00k-stage.sh
bash -n install-old-h00k-stage.sh
bash install-old-h00k-stage.sh
```

The installer verifies GitHub ZIP sha256, downloads the three staging helpers, patches a separate copy and starts ONLY the `h00k-old-stage` project. It does not reload Nginx/Caddy, change DNS, or update `main`.

Check:

```bash
docker compose -f /home/ubuntu/h00k-old-stage/compose.stage.yaml ps
curl -fsS http://127.0.0.1:3058/api/health
docker compose -f /home/ubuntu/h00k/compose.yaml ps
curl -I https://h00k.top
```

## View privately (on your computer)
```bash
ssh -N -L 3058:127.0.0.1:3058 ubuntu@YOUR_VPS_IP
```
Then visit `http://localhost:3058` on that computer.
Do not publish port 3058 without TLS and access restrictions.

## Stop / remove
Stop temporarily:
```bash
docker compose -f /home/ubuntu/h00k-old-stage/compose.stage.yaml stop
```
Start again:
```bash
docker compose -f /home/ubuntu/h00k-old-stage/compose.stage.yaml start
```
Remove ONLY staging container:
```bash
docker compose -f /home/ubuntu/h00k-old-stage/compose.stage.yaml down
```
Optional, after checking staging-only data:
```bash
docker volume rm h00k-old-stage_data
```
Optional, after stopping the container:
```bash
rm -rf /home/ubuntu/h00k-old-stage
```

**Not run on your VPS.** No runtime build, login, browser screenshots or GPU/colour measurement has been performed.
