import test from 'node:test';
import assert from 'node:assert/strict';
import { MarketData } from '../backend/market';
import { HookMarketClient } from '../backend/hookMarketFeed';
import { DEFAULT_SETTINGS } from '../backend/config';

const asFetch = (handler: (url: URL) => Response) =>
  (async (url: URL) => handler(new URL(String(url)))) as typeof fetch;
const html = (contentType = 'text/html') => new Response(
  '<!doctype html><html>INTERNAL-SENSITIVE-PAGE</html>', {
    status: 200,
    headers: { 'content-type': contentType },
  },
);

test('paper market monitor identifies Binance mark-price HTML endpoint without leaking body', async () => {
  const market = new MarketData(() => DEFAULT_SETTINGS, asFetch(url =>
    url.pathname === '/fapi/v1/premiumIndex'
      ? html()
      : Response.json({symbol: 'ZECUSDT', price:'1200', time:Date.now()}),
  ));
  await assert.rejects(
    market.getContractState('binance', 'ZECUSDT'),
    error => {
      assert.match((error as Error).message, /API binance \/fapi\/v1\/premiumIndex: HTTP 200 повернув HTML/);
      assert.doesNotMatch((error as Error).message, /INTERNAL-SENSITIVE-PAGE|<!doctype/i);
      return true;
    },
  );
});

test('paper market monitor identifies malformed JSON disguised as JSON, fail closed', async () => {
  const market = new MarketData(() => DEFAULT_SETTINGS, asFetch(url =>
    url.pathname === '/fapi/v2/ticker/price'
      ? html('application/json')
      : Response.json({symbol:'SOLUSDT',time:Date.now(),markPrice:'100',nextFundingTime:Date.now()+100000}),
  ));
  await assert.rejects(
    market.getContractState('binance', 'SOLUSDT'),
    /API binance \/fapi\/v2\/ticker\/price: HTTP 200, некоректна JSON-відповідь/,
  );
});

test('Bybit HTML during paper market data read names the endpoint', async () => {
  const market = new MarketData(() => DEFAULT_SETTINGS, asFetch(() => html()));
  await assert.rejects(market.getContractState('bybit','BTCUSDT'),
    /API bybit \/v5\/market\/tickers: HTTP 200 повернув HTML/);
});

test('misrouted h00k feed returns a useful API-path error, not raw HTML', async () => {
  const h = new HookMarketClient('https://h00k.top','s'.repeat(48),
    asFetch(() => html()));
  await assert.rejects(h.snapshot(), /h00k \/api\/mon\/feed returned HTML rather than JSON/);
});
