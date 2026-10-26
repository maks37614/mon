import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_TRADING_SCHEDULE, TRADING_SESSION_PRESETS, tradingScheduleState, validateTradingSchedule,
  type TradingSchedule, type TradingWindow,
} from "../backend/tradingSchedule";
import { DEFAULT_SETTINGS, FORMATION_ANALYSIS_VERSION, validateSettings, type Settings, type Signal, type Mode, type Exchange } from "../backend/config";
import { Store } from "../backend/store";
import { Vault } from "../backend/security";
import { Trading } from "../backend/trading";
import { paperVenue } from "./paperFixture";
import { TradingScheduleSettings } from "../src/components/TradingScheduleSettings";

const MONDAY = Date.parse("2026-10-26T12:00:00Z");
function window(overrides: Partial<TradingWindow> = {}): TradingWindow {
  return { id: "custom", name: "Мій розклад", timeZone: "UTC", days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00", ...overrides };
}
const schedule = (...windows: TradingWindow[]): TradingSchedule => ({ enabled: true, windows });
const allowed = (value: TradingSchedule, at: string) => tradingScheduleState(value, Date.parse(at)).allowed;

test("disabled schedule preserves unrestricted hours", () => {
  assert.equal(tradingScheduleState(DEFAULT_TRADING_SCHEDULE, MONDAY).allowed, true);
  assert.equal(tradingScheduleState(undefined, MONDAY).enabled, false);
});
test("opening is inclusive and closing is exclusive at minute boundaries", () => {
  const s = schedule(window());
  for (const [at, expected] of [
    ["2026-10-26T07:59:59Z", false], ["2026-10-26T08:00:00Z", true],
    ["2026-10-26T16:59:59Z", true], ["2026-10-26T17:00:00Z", false],
    ["2026-10-31T12:00:00Z", false],
  ] as const) assert.equal(allowed(s, at), expected, at);
});
test("overlapping windows use a union and return every active session", () => {
  const s = schedule(window(), window({ id: "second", name: "Америка", start: "12:00", end: "21:00" }));
  assert.deepEqual(tradingScheduleState(s, MONDAY).activeWindows, ["Мій розклад", "Америка"]);
  assert.equal(allowed(s, "2026-10-26T20:00:00Z"), true);
  assert.equal(allowed(s, "2026-10-26T21:00:00Z"), false);
});
test("Friday overnight window continues on Saturday without enabling Saturday night", () => {
  const s = schedule(window({ days: [5], start: "22:00", end: "02:00" }));
  assert.equal(allowed(s, "2026-10-30T22:00:00Z"), true);
  assert.equal(allowed(s, "2026-10-31T01:59:59Z"), true);
  assert.equal(allowed(s, "2026-10-31T02:00:00Z"), false);
  assert.equal(allowed(s, "2026-10-31T22:00:00Z"), false);
});
test("overnight window wraps from Sunday to Monday", () => {
  const s = schedule(window({ days: [0], start: "22:00", end: "02:00" }));
  assert.equal(allowed(s, "2026-11-02T01:00:00Z"), true);
  assert.equal(allowed(s, "2026-11-02T22:00:00Z"), false);
});
test("equal start and end mean the entire selected local calendar day", () => {
  const s = schedule(window({ days: [1], start: "00:00", end: "00:00" }));
  assert.equal(allowed(s, "2026-10-26T00:00:00Z"), true);
  assert.equal(allowed(s, "2026-10-26T23:59:59Z"), true);
  assert.equal(allowed(s, "2026-10-27T00:00:00Z"), false);
});
test("Warsaw schedule follows spring and autumn daylight-saving changes", () => {
  const s = schedule(window({ timeZone: "Europe/Warsaw", start: "09:00", end: "10:00" }));
  for (const at of ["2026-03-27T08:00:00Z", "2026-03-30T07:00:00Z", "2026-10-23T07:00:00Z", "2026-10-26T08:00:00Z"])
    assert.equal(allowed(s, at), true, at);
  assert.equal(allowed(s, "2026-10-26T07:30:00Z"), false);
});
test("New York and London preserve their own time zones during different DST transition weeks", () => {
  const s = schedule(window({ timeZone: "America/New_York", start: "09:30", end: "10:30" }));
  assert.equal(allowed(s, "2026-10-26T13:30:00Z"), true);
  assert.equal(allowed(s, "2026-11-02T13:30:00Z"), false);
  assert.equal(allowed(s, "2026-11-02T14:30:00Z"), true);
});
test("repeated local hour on autumn DST change is active on both occurrences", () => {
  const s = schedule(window({ timeZone: "Europe/Warsaw", days: [0], start: "02:00", end: "03:00" }));
  assert.equal(allowed(s, "2026-10-25T00:30:00Z"), true);
  assert.equal(allowed(s, "2026-10-25T01:30:00Z"), true);
  assert.equal(allowed(s, "2026-10-25T02:00:00Z"), false);
});
test("missing local hour on spring DST change never opens a phantom window", () => {
  const s = schedule(window({ timeZone: "Europe/Warsaw", days: [0], start: "02:00", end: "03:00" }));
  assert.equal(allowed(s, "2026-03-29T00:59:59Z"), false);
  assert.equal(allowed(s, "2026-03-29T01:00:00Z"), false);
});
test("invalid persisted schedules fail closed rather than crashing monitoring", () => {
  assert.equal(tradingScheduleState(null as unknown as TradingSchedule, MONDAY).allowed, false);
  assert.equal(tradingScheduleState(schedule(window({ timeZone: "not/a/zone" })), MONDAY).allowed, false);
  assert.equal(tradingScheduleState({ enabled: true, windows: [] }, MONDAY).allowed, false);
});
test("presets validate, copy their arrays, and keep named regional time zones", () => {
  for (const preset of TRADING_SESSION_PRESETS) {
    const result = validateTradingSchedule(schedule(preset));
    assert.equal(result.windows[0].timeZone, preset.timeZone);
    assert.notEqual(result.windows[0].days, preset.days);
  }
});

for (const [name, input] of [
  ["null", null], ["array", []], ["string switch", { enabled: "true", windows: [window()] }],
  ["empty active schedule", { enabled: true, windows: [] }],
  ["unknown schedule key", { enabled: true, windows: [window()], unsafe: true }],
  ["duplicate window id", schedule(window(), window())],
  ["too many windows", schedule(...Array.from({ length: 21 }, (_, i) => window({ id: `w-${i}` })))],
  ...[
    ["unknown zone", { timeZone: "fake/zone" }], ["invalid hour", { start: "24:00" }],
    ["invalid minute", { end: "08:60" }], ["short time", { start: "8:00" }],
    ["empty days", { days: [] }], ["invalid weekday", { days: [7] }],
    ["fractional weekday", { days: [1.5] }], ["empty name", { name: " " }],
    ["oversized name", { name: "a".repeat(81) }], ["unknown window key", { unexpected: true }],
  ].map(([name, patch]) => [name, schedule({ ...window(), ...(patch as object) })]),
] as [string, unknown][])
  test(`schedule validation rejects ${name}`, () => assert.throws(() => validateTradingSchedule(input)));

function fixture(t: TestContext, mode: Mode = "paper", exchange: Exchange = "binance") {
  let now = MONDAY, price = 100;
  t.mock.method(Date, "now", () => now);
  const directory = mkdtempSync(path.join(process.cwd(), ".test-schedule-"));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  store.set("settings", {
    ...DEFAULT_SETTINGS, mode, exchange, autoEntries: true, reverseEnabled: true,
    entryCooldownSeconds: 0, paperLatencyMs: 0, tradingSchedule: schedule(window()),
  });
  const signal: Signal = {
    id: "scheduled-entry", exchange, symbol: "BTCUSDT", timeframe: "1m", formation: "Double Bottom",
    direction: "LONG", entryPrice: 100, currentPrice: 100, stopLoss: 99.75, takeProfit: 100.45,
    confidence: 90, analysisVersion: FORMATION_ANALYSIS_VERSION, status: "confirmed", candleAt: now - 1000, detectedAt: now, description: "Fixture",
  };
  store.set("signals", [signal]);
  const vault = new Vault(store, randomBytes(32).toString("base64"));
  vault.save(exchange, "schedule-fixture", "schedule-fixture");
  vault.verify(exchange);
  const market: any = {
    getPrices: async () => ({ at: now, data: { BTCUSDT: price } }),
    getMarkets: async () => [{ symbol: "BTCUSDT", quantityStep: 0.001, minQuantity: 0.001, minNotional: 5, tickSize: 0.01 }],
  };
  const broker: any = {
    submitted: [], positions: [], reads: 0,
    account: async () => { broker.reads++; return { total: 1000, free: 1000, positions: structuredClone(broker.positions) }; },
    quantity: async () => 0.25,
    prepare: async () => {},
    submit: async (intent: any) => {
      broker.submitted.push(structuredClone(intent));
      assert.equal(intent.kind, "entry");
      broker.positions.push({ ...intent, entryPrice: price, currentPrice: price });
      return { id: `stub-${intent.id}`, filled: intent.quantity, average: price, fee: 0.015, status: "closed" };
    },
    protection: async (_intent: any, _quantity: number, saved: any) => { saved("stub-sl"); saved("stub-tp"); },
  };
  paperVenue(market, broker, () => price);
  const trading = new Trading(store, market, vault, broker, true);
  const setNow = (at: string, freshSignal = true) => {
    now = Date.parse(at);
    if (freshSignal) store.set("signals", [{ ...signal, candleAt: now - 1000, detectedAt: now }]);
  };
  return { store, trading, broker, market, vault, signal, setNow, setPrice: (p: number) => { price = p; } };
}

for (const exchange of ["binance", "bybit"] as const)
  for (const mode of ["paper", "live"] as const) {
    test(`${exchange}/${mode}: automatic reversed entries open within an active window`, async t => {
      const f = fixture(t, mode, exchange);
      await f.trading.monitor();
      assert.equal(f.trading.snapshot().positions[0]?.direction, "SHORT");
      assert.equal(f.broker.submitted.length, mode === "live" ? 1 : 0);
    });
    test(`${exchange}/${mode}: outside hours blocks automation but permits explicit manual entry`, async t => {
      const f = fixture(t, mode, exchange);
      f.setNow("2026-10-26T20:00:00Z");
      await f.trading.monitor();
      const snapshot = f.trading.snapshot();
      assert.equal(snapshot.positions.length, 0);
      assert.equal(snapshot.settings.autoEntries, true);
      assert.equal(snapshot.entrySchedule.allowed, false);
      assert.equal(f.broker.submitted.length, 0);
      await f.trading.enter(f.signal.id);
      assert.equal(f.trading.snapshot().positions[0]?.direction, "SHORT");
    });
  }

test("outside hours does not consume the entry interval; entry resumes automatically at opening", async t => {
  const f = fixture(t);
  await f.trading.updateSettings({ entryIntervalSeconds: 86400 });
  f.setNow("2026-10-26T07:59:59Z");
  await f.trading.monitor();
  assert.equal(f.store.get<any>("book:paper", null)?.lastEntryAt || 0, 0);
  f.setNow("2026-10-26T08:00:00Z");
  await f.trading.monitor();
  assert.equal(f.trading.snapshot().positions.length, 1);
});
for (const mode of ["paper", "live"] as const)
  test(`${mode}: a window closing during asynchronous preflight prevents the order and signal consumption`, async t => {
    const f = fixture(t, mode);
    f.setNow("2026-10-26T16:59:59Z");
    if (mode === "live") f.broker.prepare = async () => f.setNow("2026-10-26T17:00:00Z", false);
    else f.market.getMarkets = async () => {
      f.setNow("2026-10-26T17:00:00Z", false);
      return [{ symbol: "BTCUSDT", quantityStep: 0.001, minQuantity: 0.001, minNotional: 5 }];
    };
    await f.trading.monitor();
    assert.equal(f.trading.snapshot().positions.length, 0);
    assert.equal(f.broker.submitted.length, 0);
    const book = f.store.get<any>(`book:${mode}`, null);
    assert.equal(book.used[f.signal.id], undefined);
    assert.equal(book.lastEntries.BTCUSDT, undefined);
  });

for (const reason of ["TP", "SL", "TIME"] as const)
  test(`paper ${reason} remains active after the session closes`, async t => {
    const f = fixture(t);
    await f.trading.updateSettings({ maxHoldingSeconds: reason === "TIME" ? 300 : 0 });
    await f.trading.monitor();
    const p = f.trading.snapshot().positions[0];
    f.setNow("2026-10-26T18:00:00Z");
    if (reason !== "TIME") f.setPrice(reason === "TP" ? p.takeProfit : p.stopLoss);
    await f.trading.monitor();
    assert.equal(f.trading.snapshot().positions.length, 0);
    assert.equal(f.trading.snapshot().history[0].reason, reason);
  });

test("live reconciliation continues outside scheduled entry hours", async t => {
  const f = fixture(t, "live");
  await f.trading.updateSettings({ maxHoldingSeconds: 0 });
  await f.trading.monitor();
  f.setNow("2026-10-26T18:00:00Z");
  f.broker.positions[0].currentPrice = 101;
  const reads = f.broker.reads;
  await f.trading.monitor();
  assert.ok(f.broker.reads > reads);
  assert.equal(f.trading.snapshot().positions[0].currentPrice, 101);
  assert.equal(f.broker.submitted.length, 1);
});
test("saved schedule survives a new engine and existing settings migrate without enabling it", async t => {
  const f = fixture(t);
  await f.trading.updateSettings({ tradingSchedule: schedule(window({ start: "18:00", end: "23:00" })) });
  const restarted = new Trading(f.store, f.market, f.vault, f.broker, true);
  assert.equal(restarted.snapshot().entrySchedule.allowed, false);
  const { tradingSchedule: _schedule, ...legacy } = restarted.settings();
  f.store.set("settings", legacy);
  assert.deepEqual(restarted.settings().tradingSchedule, DEFAULT_TRADING_SCHEDULE);
  assert.equal(restarted.settings().autoEntries, true);
  assert.equal(validateSettings({ reverseEnabled: false }, legacy as Settings).tradingSchedule.enabled, false);
});
test("schedule editor renders regional presets and custom time/day/zone controls", () => {
  const html = renderToStaticMarkup(createElement(TradingScheduleSettings, { value: schedule(window()), onChange: () => {} }));
  for (const text of ["Токіо", "Лондон", "Нью-Йорк", "Власні години", "Europe/Warsaw", "Початок", "Завершення", "Дні початку вікна"])
    assert.ok(html.includes(text), text);
  assert.equal((html.match(/type="time"/g) || []).length, 2);
  assert.ok(html.includes("TP/SL"));
});
