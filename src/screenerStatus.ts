import type { Settings } from "../backend/config";

type ScanStatus = {
  running?: boolean;
  lastStartedAt?: number;
  finishedAt?: number;
  processed?: number;
  successful?: number;
  failed?: number;
  error?: string;
};

export function scanIsOverdue(scan: ScanStatus, settings: Settings, now = Date.now()) {
  const last = Math.max(scan.lastStartedAt || 0, scan.finishedAt || 0);
  return !scan.running && last > 0 &&
    now - last > Math.max(180, settings.scanIntervalSeconds * 2) * 1000;
}

export function screenerEmptyState(scan: ScanStatus, settings: Settings,
  schedulerMode: string, hasSearch: boolean, formationCount: number, now = Date.now()) {
  if (hasSearch && formationCount > 0) return {
    title: "За цим пошуком формацій немає",
    detail: "Очистіть пошук монети або назви формації, щоб побачити знайдені результати.",
  };
  if (scan.running) return {
    title: "Сканування триває",
    detail: `Оброблено ${scan.processed || 0} завдань. Результати з’являються під час обробки пакета.`,
  };
  if (scan.error) return {
    title: "Останній пакет сканування завершився з помилкою",
    detail: scan.error,
  };
  if (!scan.lastStartedAt) return {
    title: "Сканування ще не запускалося",
    detail: schedulerMode === "external"
      ? "Запустіть пакет кнопкою «Сканувати пакет». Для регулярного оновлення потрібен увімкнений cron-job.org із правильним секретним заголовком."
      : "Дочекайтеся внутрішнього розкладу або натисніть «Сканувати пакет».",
  };
  if (scanIsOverdue(scan, settings, now)) return {
    title: "Сканування давно не оновлювалося",
    detail: schedulerMode === "external"
      ? "Перевірте, що cron-job.org викликає /api/cron/scan щохвилини. Зараз можна запустити пакет вручну."
      : "Перевірте роботу внутрішнього розкладу або запустіть пакет вручну.",
  };
  return {
    title: "За поточними фільтрами формацій не знайдено",
    detail: `Таймфрейми: ${settings.timeframes.join(" / ")}; мінімальна оцінка: ${settings.minScore}/100; ${settings.confirmedOnly ? "лише підтверджені" : "включно з тими, що формуються"}. Дані останнього пакета оброблено; перевірка наступних монет продовжиться за розкладом.`,
  };
}
