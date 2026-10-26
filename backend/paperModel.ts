export type RiskTier = { cap: number; rate: number; deduction: number; maxLeverage: number };
export type ExecutionBook = { at: number; bids: number[][]; asks: number[][] };
export type ContractState = { at: number; last: number; mark: number; nextFundingAt: number };
export type FundingEvent = { at: number; rate: number; price: number; priceSource: string };
export type PaperState = {
  version: 1; marginMode: "isolated"; leverage: number; initialMargin: number;
  marginBalance?: number;
  closeFeeReserve?: number;
  takerRate: number; feeSource: string; feeAt: number; latencyMs: number;
  tiers: RiskTier[]; riskAt: number; entryReference: number; entrySlippage: number;
  markPrice: number; liquidationPrice: number; nextFundingAt: number;
  fundingCost: number; fundingEvents: (FundingEvent & { cost: number })[];
  fundingCheckedAt: number; lastObservedAt: number; warnings: string[];
  lastMarkAt?: number; lastTradeAt?: number;
  closeTrigger?: { reason: string; at: number; reference: number };
  closeFill?: { price: number; at: number; reference: number; slippage: number; reason: string; takerRate?: number; feeSource?: string; feeAt?: number };
};
export function validTiers(tiers: RiskTier[]) {
  const sorted = [...tiers].sort((a, b) => a.cap - b.cap);
  if (!sorted.length || sorted.some((t, i) => !Number.isFinite(t.cap) || t.cap <= (sorted[i - 1]?.cap || 0) ||
    !Number.isFinite(t.rate) || t.rate <= 0 || t.rate >= 1 || !Number.isFinite(t.deduction) || t.deduction < 0 ||
    !Number.isFinite(t.maxLeverage) || t.maxLeverage < 1)) throw new Error("Немає коректних біржових рівнів маржі");
  return sorted;
}
export function depthFill(book: ExecutionBook, side: "buy" | "sell", quantity: number, now = Date.now()) {
  if (!Number.isFinite(book.at) || now - book.at > 2000 || book.at > now + 1000)
    throw new Error("Стакан застарів; виконання симуляції відкладено");
  const bids = book.bids, asks = book.asks;
  for (const [levels, ascending] of [[bids, false], [asks, true]] as const) {
    if (!levels.length || levels.some(([p, q], i) => !Number.isFinite(p) || !Number.isFinite(q) || p <= 0 || q <= 0 ||
      (i > 0 && (ascending ? p <= levels[i - 1][0] : p >= levels[i - 1][0]))))
      throw new Error("Некоректна глибина стакана");
  }
  if (bids[0][0] >= asks[0][0] || !(quantity > 0)) throw new Error("Некоректний стакан або обсяг");
  let remaining = quantity, notional = 0;
  for (const [price, available] of side === "buy" ? asks : bids) {
    const filled = Math.min(remaining, available);
    notional += filled * price; remaining -= filled;
    if (remaining <= quantity * 1e-10) break;
  }
  if (remaining > quantity * 1e-10) throw new Error("Недостатня видима ліквідність для повного виконання");
  return notional / quantity;
}
export function maintenance(tiers: RiskTier[], notional: number) {
  const tier = tiers.find(t => notional <= t.cap);
  if (!tier) throw new Error("Обсяг перевищує відомі рівні ризику");
  return Math.max(0, notional * tier.rate - tier.deduction);
}
export function liquidationPrice(p: { direction: "LONG" | "SHORT"; entryPrice: number; quantity: number }, state: PaperState) {
  const sign = p.direction === "LONG" ? 1 : -1;
  const margin = state.marginBalance ?? state.initialMargin - state.fundingCost;
  for (const tier of state.tiers) {
    const denominator = p.quantity * (sign - tier.rate);
    const price = (sign * p.entryPrice * p.quantity - margin - tier.deduction + (state.closeFeeReserve || 0)) / denominator;
    if (price > 0 && price * p.quantity <= tier.cap &&
      maintenance(state.tiers, price * p.quantity) === Math.max(0, price * p.quantity * tier.rate - tier.deduction)) return price;
  }
  // A fully funded 1x long may have no positive liquidation threshold.
  if (p.direction === "LONG" && margin >= p.entryPrice * p.quantity) return 0;
  throw new Error("Немає рівня ризику для розрахунку ліквідації");
}
export function liquidatable(p: { direction: "LONG" | "SHORT"; entryPrice: number; quantity: number }, state: PaperState, mark: number) {
  const equity = (state.marginBalance ?? state.initialMargin - state.fundingCost) + (mark - p.entryPrice) * p.quantity * (p.direction === "LONG" ? 1 : -1);
  return equity <= maintenance(state.tiers, mark * p.quantity) + (state.closeFeeReserve || 0);
}
