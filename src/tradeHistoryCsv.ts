import type { Signal, TradeHistoryEntry } from "../backend/config";
import { FORMATION_LABELS_UK } from "./formationLabels";

export function signalConfirmationLabel(status?: Signal["status"]): string {
  if (status === "confirmed") return "Підтверджена";
  if (status === "watching") return "Без підтвердження";
  return "";
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
    ]),
  ];
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(";")).join("\r\n");
}
