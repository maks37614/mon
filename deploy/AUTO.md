# Third independent mon bot for auto.h00k.top

This **branch of maks37614/mon** reuses the original mon scanner, formation engine,
trading / position management, and its real-market paper execution model.

## Isolation and market sourcing

- Deploy only to **/home/ubuntu/auto**; never into /home/ubuntu/mon or /home/ubuntu/h00k.
- The VPS container **auto-mon** has its own named Docker volume `auto_mon_data`.
- Existing Caddy `auto.h00k.top` routing to `127.0.0.1:3027` is reused.
- No edits to h00k.top or any of its containers, files, scans, charts, orderbook, or alerts.
- The source adapter only reads existing public h00k quotes **once every five minutes at most**.
  A read necessarily has some small HTTP processing cost; this is not zero load.
- Only fresh, active, liquid Binance USDT perpetual symbols; up to ten ranked by
  24h volatility. No fallback to the rest of Binance on source failure.
- All candles, ticks, mark prices, funding and orderbooks come **directly from the Binance real-market endpoints**.
- Historical backtests and Binance Testnet are not used.
- **Only paper mode**, live execution disabled even if credentials exist.
- Existing paper positions can continue to be monitored if the top ten changes.

## Preparation on VPS (do not run on existing bot folders)

```sh
cd /home/ubuntu
git clone --single-branch --branch feature/auto-h00k-top10-binance-paper \
  https://github.com/maks37614/mon.git auto
cd auto
```

Generate a fresh scrypt password hash with the repository's `scripts/password.mjs`,
which requires Node 24 (the Docker builder supplies Node 24).
Create the local `.env` using `deploy/.env.auto.example`. Set `ADMIN_PASSWORD_HASH`,
`ENCRYPTION_KEY` (32 random bytes base64), `CRON_SECRET` (at least 32 random characters).
Never paste or commit secrets. Use the Compose file `deploy/auto.compose.yaml` from this folder.

**Before switching port 3027**, build and test the new image. Then stop only the
previous `impulse-hunter` container (NOT `h00k-app-1`, `evgen-mon` or `krystian-mon`),
bring up only `auto-mon`, verify local health, HTTPS, login, and site source status.

Run with:
```sh
docker compose -f deploy/auto.compose.yaml build auto-mon
docker compose -f deploy/auto.compose.yaml up -d --no-deps auto-mon
```

**Testing real-market conditions** means live exchange prices and simulated fills.
It does **not** mean transmitting real orders. The original mon Binance paper
risk-tier model requires a **read-only Binance API key**; do not enable real trading.
Order execution, margin, orderbook and fee models are approximations and should not
be mistaken for actual trades. Automatic entries remain off by default until the
operator enables them in the authenticated UI.

The original `mon` project is untouched on its main branch, as are other running bots.
