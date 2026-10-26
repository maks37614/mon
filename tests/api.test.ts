import test from "node:test";
import assert from "node:assert/strict";
import { api, setCsrf } from "../src/api";

test("API returns JSON and keeps the server's actionable validation error", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: true }));
  assert.deepEqual(await api("/api/state"), { ok: true });
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Сигнал застарів" }, { status: 400 }));
  await assert.rejects(api("/api/signals/fixture/enter", {}), { message: "Сигнал застарів", status: 400 });
});

test("empty unauthorized responses preserve 401 so the page returns to login", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 401 }));
  await assert.rejects(api("/api/state"), { status: 401, message: "Сесію завершено. Увійдіть знову." });
});

test("HTML or truncated responses produce understandable errors and never fake empty signals", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response("<html>Bad Gateway</html>", { status: 502 }));
  await assert.rejects(api("/api/state"), { status: 502, message: "Сервер тимчасово недоступний (HTTP 502)." });
  t.mock.method(globalThis, "fetch", async () => new Response('{"formations":['));
  await assert.rejects(api("/api/state"), /неповну відповідь/);
  t.mock.method(globalThis, "fetch", async () => Response.json(null));
  await assert.rejects(api("/api/state"), /некоректні дані/);
});

test("a failed POST response never causes a second order request", async t => {
  let calls = 0;
  const spy = t.mock.method(globalThis, "fetch", async (_path: any, init: any) => {
    calls++;
    assert.equal(init.method, "POST");
    assert.equal(init.headers["X-CSRF-Token"], "test-csrf");
    return new Response("");
  });
  setCsrf("test-csrf");
  t.after(() => setCsrf(""));
  await assert.rejects(api("/api/signals/fixture/enter", {}), /неповну відповідь/);
  assert.equal(calls, 1);
  assert.equal(spy.mock.callCount(), 1);
});
