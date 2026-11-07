import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, validateSettings } from "../backend/config";

test("fast and confirmed impulse modes can be configured independently", () => {
  for (const fast of [false, true]) {
    for (const confirmed of [false, true]) {
      const settings = validateSettings(
        { impulseFastEnabled: fast, impulseConfirmedEnabled: confirmed },
        DEFAULT_SETTINGS,
      );
      assert.equal(settings.impulseFastEnabled, fast);
      assert.equal(settings.impulseConfirmedEnabled, confirmed);
    }
  }
});

test("impulse mode toggles reject non-boolean values", () => {
  assert.throws(
    () => validateSettings({ impulseFastEnabled: "true" }, DEFAULT_SETTINGS),
    /impulseFastEnabled/,
  );
  assert.throws(
    () => validateSettings({ impulseConfirmedEnabled: 1 }, DEFAULT_SETTINGS),
    /impulseConfirmedEnabled/,
  );
});

test("older settings remain compatible with the new defaults", () => {
  const previous = { ...DEFAULT_SETTINGS };
  delete (previous as Partial<typeof DEFAULT_SETTINGS>).impulseFastEnabled;
  delete (previous as Partial<typeof DEFAULT_SETTINGS>).impulseConfirmedEnabled;
  const validated = validateSettings({}, previous);
  assert.equal(validated.impulseFastEnabled, false);
  assert.equal(validated.impulseConfirmedEnabled, false);
});
