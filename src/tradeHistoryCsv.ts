import type { Signal, TradeHistoryEntry } from "../backend/config";
import { FORMATION_LABELS_UK } from "./formationLabels";

export function signalConfirmationLabel(status?: Signal["status"]): string {
  if (status === "confirmed") return "Підтверджена";
  if (status === "watching") return "Без підтвердження";
  return "";
}
export function paperWarningsText(warnings: string[] = []): string {
  const labels: Record<string, string> = {
    "stream-gap": "Розрив потоку цін", "monitoring-gap": "Пропуск спостереження",
    "funding-mark-estimate": "Funding за mark-свічкою", "legacy-entry-not-reconstructed": "Вхід зі старої моделі",
    "data-unavailable": "Були недоступні ринкові дані", "risk-snapshot-stale": "Застарілі рівні маржі",
    "funding-boundary-estimate": "Вхід/вихід поблизу моменту funding",
  };
  return warnings.map(w => labels[w] || w).join("; ");
}

function utcTimestamp(at?: number): string {
  if (typeof at !== "number" || !Number.isFinite(at)) return "";
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  // Text cells must stay text in spreadsheets; numeric losses stay numbers.
  if (typeof value === "string" && /^[=+\-@\t\r\n]/.test(text)) text = "'" + text;
  return `"${text.replaceAll('"', '""')}"`;
}

export function tradeHistoryCsv(history: readonly TradeHistoryEntry[]): string {
  const rows: unknown[][] = [
    [
      "Монета", "Напрям", "Вхід", "Вихід", "Кількість", "PnL", "Комісія",
      "Відкрито (UTC)", "Закрито (UTC)", "Таймфрейм", "Формація",
      "Оцінка формації (0–100)", "Підтвердження на вході", "Напрям сигналу",
      "Причина закриття", "Біржа", "Тип результату", "Повнота комісій",
      "Валовий PnL", "Комісія входу USDT", "Комісія виходу USDT", "Funding USDT (+сплачено/-отримано)",
      "Funding звірено", "Прослизання входу USDT (включено в ціну)", "Прослизання виходу USDT (включено в ціну)",
      "Модель виконання", "Режим маржі", "Плече", "Початкова маржа USDT", "Тариф входу %", "Джерело тарифу входу",
      "Тариф виходу %", "Затримка моделі мс", "Зауваження до точності", "Нарахування funding JSON",
    ],
    ...history.map((trade) => [
      trade.symbol, trade.direction, trade.entryPrice, trade.exitPrice,
      trade.quantity, trade.netPnl, trade.fee,
      utcTimestamp(trade.openedAt), utcTimestamp(trade.closedAt), trade.timeframe,
      FORMATION_LABELS_UK[trade.formation] || trade.formation,
      typeof trade.signalConfidence === "number" && Number.isFinite(trade.signalConfidence)
        && trade.signalConfidence >= 0 && trade.signalConfidence <= 100
        ? trade.signalConfidence : undefined,
      signalConfirmationLabel(trade.signalStatus), trade.signalDirection,
      trade.reason, trade.exchange,
      trade.estimated ? "Симуляція" : "Біржові виконання",
      trade.estimated ? "Розрахункові"
        : trade.feesComplete === true ? "Повні"
        : trade.feesComplete === false ? "Неповні" : "",
      trade.grossPnl, trade.entryFee, trade.exitFee, trade.fundingCost,
      trade.fundingComplete === true ? "Так" : trade.fundingComplete === false ? "Ні" : "",
      trade.entrySlippage, trade.exitSlippage, trade.executionSource,
      trade.paper?.marginMode, trade.paper?.leverage, trade.paper?.initialMargin,
      trade.paper ? trade.paper.takerRate * 100 : undefined, trade.paper?.feeSource,
      trade.paper?.closeFill?.takerRate == null ? undefined : trade.paper.closeFill.takerRate * 100,
      trade.paper?.latencyMs, paperWarningsText(trade.paper?.warnings),
      trade.paper ? JSON.stringify(trade.paper.fundingEvents) : "",
    ]),
  ];
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(";")).join("\r\n");
}
