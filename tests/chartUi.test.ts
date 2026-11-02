import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HookChart } from '../src/components/HookChart';

test('Krystian chart is native HookChart only, with real 1m/5m controls and trade prices', () => {
  const html = renderToStaticMarkup(React.createElement(HookChart, {
    symbol: 'BTCUSDT',
    exchange: 'binance',
    direction: 'LONG',
    entryPrice: 78330.1,
    takeProfit: 80288.3525,
    stopLoss: 77938.4495,
    entryTimestamp: Date.parse('2026-11-02T07:00:00Z'),
    verifiedOnly: true,
    initialTimeframe: '1m',
    height: 520,
  }));
  assert.ok(html.includes('HookChart'));
  assert.ok(html.includes('1m'));
  assert.ok(html.includes('5m'));
  assert.ok(!html.includes('>15m<') && !html.includes('>1h<'));
  assert.doesNotMatch(html, /<iframe|TradingView|tradingview/i);
  assert.match(html, /Вхід: 78330\.1/);
  assert.match(html, /TP: 80288\.3525/);
  assert.match(html, /SL: 77938\.4495/);
  assert.match(html, /Перевірені закриті свічки h00k\.top/);
});

test('Historical chart keeps the actual exit instead of inferring a candle close', () => {
  const html = renderToStaticMarkup(React.createElement(HookChart, {
    symbol: 'HYPEUSDT',
    entryPrice: 88,
    takeProfit: 90,
    stopLoss: 87,
    entryTimestamp: Date.parse('2026-11-01T15:25:52Z'),
    exitPrice: 88.5,
    exitTimestamp: Date.parse('2026-11-01T21:24:11Z'),
    focusAt: Date.parse('2026-11-01T15:25:52Z'),
    verifiedOnly: true,
    initialTimeframe: '5m',
  }));
  assert.match(html, /Вихід: 88\.5/);
  assert.doesNotMatch(html, /TradingView|tradingview|<iframe/i);
});
