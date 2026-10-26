// Shared venue responses for entry/schedule tests. No network or real orders.
export function paperVenue(market: any, broker: any, price: () => number) {
  const tiers = [{ cap: 1e8, rate: 0.005, deduction: 0, maxLeverage: 20 }];
  market.getExecutionBook = async () => ({ at: Date.now(), bids: [[price() - 1e-10, 1e6]], asks: [[price(), 1e6]] });
  market.getContractState = async () => ({ at: Date.now(), last: price(), mark: price(), nextFundingAt: (Math.floor(Date.now() / 28800_000) + 1) * 28800_000 });
  market.getPublicRiskTiers = async () => tiers;
  market.getFundingEvents = async (_exchange: string, _symbol: string, from: number, to: number) => {
    const events = [];
    for (let at = Math.ceil(from / 28800_000) * 28800_000; at <= to; at += 28800_000)
      events.push({ at, rate: 0, price: price(), priceSource: "settlement-mark" });
    return events;
  };
  broker.takerRate = async () => ({ rate: 0.0006, source: "account-api", at: Date.now() });
  broker.riskTiers = async () => tiers;
}
