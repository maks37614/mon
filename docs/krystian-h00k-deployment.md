# Krystian: second independent bot using h00k.top market data

This is a **new, independent installation**, not an upgrade of `evgen-mon`.
Do not run `deploy/migrate-evgen-to-mon.sh` for Krystian.

## How it works

- `h00k.top` runs its existing formations scan; `krystian-mon` never runs its market-wide scanner.
- `/api/mon/feed` (Bearer protected) sends existing formation symbols, cached real prices, real WS order book and density evidence.
- `/api/mon/candles` requests closed 1m/5m exchange candles only for still-eligible formation instruments, bounded to 900 and 90 calls/minute, with explicit freshness and contiguity validation.
- h00k tracks at most 8 current formation instruments with synchronized WS depth. **If no active, fresh, persistent density matches an Ev-Test entry, no signal/order is allowed.**
- Only verified exchange market snapshots are used; stops not visible in public books are never described as known.
- Exchange contract metadata, account/fees and actual order execution continue to use the chosen exchange; they are not price/formation scans.
- The existing paper-trading monitoring retains its own public stream for open positions. This preserves independent position monitoring should the h00k formation feed go offline.
- `evgen-mon`, `h00k-app-1`, `/etc/evgen-mon.env`, `/var/lib/evgen-mon` and existing first-bot rules remain untouched.
- The feed is a dependency: h00k downtime stops **new entry signals**. Existing positions are never automatically abandoned.

## Required order on the VPS

1. Deploy [h00k PR #7](https://github.com/maks37614/h00k/pull/7) safely (review local changes first; existing site must stay up).
2. Ensure the existing h00k container has a unique `HOOK_PAPER_FEED_TOKEN` of at least 32 characters in its environment. **Do not share this token in a chat, shell history, logs or GitHub.**
3. Verify `GET https://h00k.top/api/mon/feed` returns JSON version 1 with Bearer auth and no credentials in the URL. An empty snapshot array is possible until the scanner populates its cache.
4. Set DNS A for `krystian.h00k.top` to the VPS IPv4 address. Configure Caddy for HTTPS, not a public port 3011.
5. Clone `feature/krystian-hook-feed` of the `mon` repository into **a new working tree**, not `~/mon` used by evgen.
6. Run `sudo bash deploy/install-krystian.sh`. This builds a new image, generates Krystian's own admin password, encryption key and cron secret, prompts privately for the h00k feed Bearer token, verifies the source API, starts `krystian-mon` on `127.0.0.1:3011`, and adds only the Caddy host for Krystian when Caddy is active.
7. Log in to `https://krystian.h00k.top`, check the source and strategy status. Use **paper mode**, enable Ev-Test, and keep auto-entries off until validated.
8. Verify logs (`docker logs --tail 100 krystian-mon`) and memory (`docker stats --no-stream`). There is no automatic live trading authorization in this installer.

## Fail-closed behavior

- Old or missing h00k formation snapshots: local source symbols cleared on sync.
- Unavailable or non-contiguous candles, incorrect exchange/market: signals rejected.
- Missing, crossed, stale or unsynchronized public depth: signals/orders rejected.
- No persistent, age >= 15 sec, quality >= 45, direction-aligned wall within 0.8% of intended entry: no Ev-Test entry.
- Prices must have a genuine exchange event timestamp no older than 15 seconds; no fabricated midprice substitutes.
- Only a short list of active formation instruments has density coverage. Non-covered instruments are intentionally skipped.

**Before real trading:** paper-test for an extended period, confirm reconciliation after restarts and market disconnects, and separately approve enabling live trading. The original Ev-Test strategy still does not model every discretionary trading pattern.
