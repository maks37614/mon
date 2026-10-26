export type TradingWindow = {
  id: string;
  name: string;
  timeZone: string;
  days: number[]; // Sunday = 0; overnight windows belong to the day they start.
  start: string;
  end: string;
};
export type TradingSchedule = { enabled: boolean; windows: TradingWindow[] };
export type TradingScheduleState = {
  enabled: boolean;
  allowed: boolean;
  activeWindows: string[];
  checkedAt: number;
};

export const DEFAULT_TRADING_SCHEDULE: TradingSchedule = { enabled: false, windows: [] };
export const TRADING_SESSION_PRESETS: TradingWindow[] = [
  { id: "tokyo", name: "Азія · Токіо", timeZone: "Asia/Tokyo", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" },
  { id: "london", name: "Європа · Лондон", timeZone: "Europe/London", days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00" },
  { id: "new-york", name: "Америка · Нью-Йорк", timeZone: "America/New_York", days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00" },
];
export const TRADING_TIME_ZONES = [
  "Europe/Warsaw", "Europe/Kyiv", "UTC", "Europe/London", "America/New_York",
  "Asia/Tokyo", "Asia/Hong_Kong", "Asia/Singapore", "Australia/Sydney",
];
export const TRADING_DAYS = [
  { day: 1, label: "Пн" }, { day: 2, label: "Вт" }, { day: 3, label: "Ср" },
  { day: 4, label: "Чт" }, { day: 5, label: "Пт" }, { day: 6, label: "Сб" }, { day: 0, label: "Нд" },
];
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-GB", {
      timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    if (formatters.size >= 64) formatters.clear();
    formatters.set(timeZone, value);
  }
  return value;
}
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

export function validateTradingSchedule(input: unknown): TradingSchedule {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Некоректний розклад торгівлі");
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some(key => !["enabled", "windows"].includes(key)) ||
      typeof raw.enabled !== "boolean" || !Array.isArray(raw.windows) || raw.windows.length > 20)
    throw new Error("Розклад: потрібні перемикач і до 20 часових вікон");
  if (raw.enabled && !raw.windows.length)
    throw new Error("Додайте хоча б одне часове вікно або вимкніть розклад");
  const ids = new Set<string>();
  const windows = raw.windows.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Некоректне часове вікно");
    const w = item as Record<string, unknown>;
    if (Object.keys(w).some(key => !["id", "name", "timeZone", "days", "start", "end"].includes(key)) ||
        typeof w.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(w.id) || ids.has(w.id))
      throw new Error("Кожне часове вікно повинно мати унікальний ідентифікатор");
    ids.add(w.id);
    if (typeof w.name !== "string" || !w.name.trim() || w.name.trim().length > 80)
      throw new Error("Назва торгового вікна: від 1 до 80 символів");
    if (typeof w.timeZone !== "string" || w.timeZone.length > 80)
      throw new Error("Оберіть часовий пояс торгового вікна");
    try { formatter(w.timeZone); } catch { throw new Error("Невідомий часовий пояс торгового вікна"); }
    if (typeof w.start !== "string" || typeof w.end !== "string" || !TIME.test(w.start) || !TIME.test(w.end))
      throw new Error("Час торгового вікна має бути у форматі ГГ:ХХ, від 00:00 до 23:59");
    if (!Array.isArray(w.days) || !w.days.length || w.days.length > 7 ||
        w.days.some(day => !Number.isInteger(day) || day < 0 || day > 6))
      throw new Error("Оберіть дні тижня для кожного торгового вікна");
    return {
      id: w.id, name: w.name.trim(), timeZone: w.timeZone, start: w.start, end: w.end,
      days: [...new Set(w.days as number[])].sort((a, b) => (a || 7) - (b || 7)),
    };
  });
  return { enabled: raw.enabled, windows };
}

function windowIsActive(window: TradingWindow, now: number): boolean {
  try {
    if (!window || !Array.isArray(window.days) || !TIME.test(window.start) || !TIME.test(window.end)) return false;
    const parts = formatter(window.timeZone).formatToParts(now);
    const part = (name: string) => parts.find(p => p.type === name)?.value || "";
    const day = WEEKDAYS[part("weekday")];
    const current = Number(part("hour")) * 60 + Number(part("minute"));
    const start = minutes(window.start), end = minutes(window.end);
    if (start === end) return window.days.includes(day);
    if (start < end) return window.days.includes(day) && current >= start && current < end;
    return (window.days.includes(day) && current >= start) ||
      (window.days.includes((day + 6) % 7) && current < end);
  } catch {
    return false;
  }
}

export function tradingScheduleState(
  schedule: TradingSchedule = DEFAULT_TRADING_SCHEDULE,
  now = Date.now(),
): TradingScheduleState {
  if (schedule?.enabled === false)
    return { enabled: false, allowed: true, activeWindows: [], checkedAt: now };
  const activeWindows = schedule?.enabled === true && Array.isArray(schedule.windows)
    ? schedule.windows.filter(window => windowIsActive(window, now)).map(window => window.name)
    : [];
  return { enabled: true, allowed: activeWindows.length > 0, activeWindows, checkedAt: now };
}
