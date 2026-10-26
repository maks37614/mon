import test from "node:test";
import assert from "node:assert/strict";
import type { TradeHistoryEntry } from "../backend/config";
import { tradeHistoryCsv } from "../src/tradeHistoryCsv";

function trade(overrides: Partial<TradeHistoryEntry> = {}): TradeHistoryEntry {
  return {
    id: "trade-1", exchange: "binance", symbol: "BTCUSDT", direction: "SHORT",
    formation: "Double Bottom", timeframe: "15m", signalDirection: "LONG",
    signalConfidence: 83, signalStatus: "watching", entryPrice: 100, exitPrice: 99,
    quantity: 0.25, grossPnl: 0.25, netPnl: 0.22015, fee: 0.02985,
    openedAt: Date.parse("2026-10-25T00:30:00.123Z"),
    closedAt: Date.parse("2026-10-25T01:30:00.456Z"), reason: "TP", estimated: true,
    ...overrides,
  };
}

// These fixtures contain no embedded newlines. The escaping test checks those separately.
function records(csv: string): Record<string, string>[] {
  assert.equal(csv[0], "\uFEFF");
  const [headers, ...rows] = csv.slice(1).split("\r\n").map((row) =>
    [...row.matchAll(/"((?:[^"]|"")*)"(?:;|$)/g)].map((m) => m[1].replaceAll('""', '"')),
  );
  return rows.map((row) => {
    assert.equal(row.length, headers.length);
    return Object.fromEntries(headers.map((header, i) => [header, row[i]]));
  });
}

test("CSV records both UTC timestamps and original formation metadata beside reversed execution", () => {
  const [row] = records(tradeHistoryCsv([trade()]));
  assert.equal(row["Відкрито (UTC)"], "2026-10-25T00:30:00.123Z");
  assert.equal(row["Закрито (UTC)"], "2026-10-25T01:30:00.456Z");
  assert.equal(row["Таймфрейм"], "15m");
  assert.equal(row["Формація"], "Подвійне дно");
  assert.equal(row["Оцінка формації (0–100)"], "83");
  assert.equal(row["Підтвердження на вході"], "Без підтвердження");
  assert.equal(row["Напрям сигналу"], "LONG");
  assert.equal(row["Напрям"], "SHORT");
  assert.equal(row["Комісія"], "0.02985");
  assert.equal(row["PnL"], "0.22015");
  assert.equal(row["Причина закриття"], "TP");
  assert.equal(row["Біржа"], "binance");
  assert.equal(row["Тип результату"], "Симуляція");
  assert.equal(row["Повнота комісій"], "Розрахункові");
});

test("legacy missing metadata stays blank and zero scores are not mistaken for missing values", () => {
  const legacy = trade();
  delete legacy.signalConfidence;
  delete legacy.signalStatus;
  delete legacy.signalDirection;
  delete legacy.timeframe;
  delete legacy.openedAt;
  const csv = tradeHistoryCsv([legacy, trade({ signalConfidence: 0, signalStatus: "confirmed" })]);
  const [old, current] = records(csv);
  for (const key of ["Оцінка формації (0–100)", "Підтвердження на вході", "Напрям сигналу", "Таймфрейм", "Відкрито (UTC)"])
    assert.equal(old[key], "", key);
  assert.equal(current["Оцінка формації (0–100)"], "0");
  assert.equal(current["Підтвердження на вході"], "Підтверджена");
  assert.ok(!csv.includes("undefined"));
  assert.ok(!csv.includes("null"));
  assert.equal(records(tradeHistoryCsv([trade({ openedAt: NaN, closedAt: Infinity })]))[0]["Закрито (UTC)"], "");
});

test("CSV distinguishes complete, incomplete and unknown venue fees from simulated fees", () => {
  const rows = records(tradeHistoryCsv([
    trade({ estimated: false, feesComplete: true, exchange: "bybit" }),
    trade({ estimated: false, feesComplete: false }),
    trade({ estimated: false }),
  ]));
  assert.equal(rows[0]["Біржа"], "bybit");
  assert.equal(rows[0]["Тип результату"], "Біржові виконання");
  assert.deepEqual(rows.map((row) => row["Повнота комісій"]), ["Повні", "Неповні", ""]);
});

test("CSV escapes delimiters, quotes and newlines, and keeps formulas inert without changing numeric losses", () => {
  const csv = tradeHistoryCsv([trade({
    formation: 'Custom; "formation"\r\nsecond line',
    reason: '=HYPERLINK("https://example.com")', netPnl: -1.25,
  })]);
  assert.ok(csv.includes('"Custom; ""formation""\r\nsecond line"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""https://example.com"")"'));
  assert.ok(csv.includes(';"-1.25";'));
  assert.ok(!csv.includes('"\'-1.25"'));
});

test("CSV exports every retained trade instead of the 100 rows shown in the interface", () => {
  const history = Array.from({ length: 1000 }, (_, i) => trade({ id: String(i), symbol: `COIN${i}USDT` }));
  const rows = records(tradeHistoryCsv(history));
  assert.equal(rows.length, 1000);
  assert.equal(rows.at(-1)!["Монета"], "COIN999USDT");
  assert.equal(tradeHistoryCsv([]).slice(1).split("\r\n").length, 1);
});
