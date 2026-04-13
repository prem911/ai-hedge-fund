import type { PortfolioPosition } from "../models/schemas.js";

export function createPortfolio(
  initialCash: number,
  marginRequirement: number,
  tickers: string[],
  portfolioPositions?: PortfolioPosition[] | null
): Record<string, unknown> {
  const portfolio: Record<string, unknown> = {
    cash: initialCash,
    margin_requirement: marginRequirement,
    margin_used: 0.0,
    positions: Object.fromEntries(
      tickers.map((ticker) => [
        ticker,
        {
          long: 0,
          short: 0,
          long_cost_basis: 0.0,
          short_cost_basis: 0.0,
          short_margin_used: 0.0,
        },
      ])
    ),
    realized_gains: Object.fromEntries(
      tickers.map((ticker) => [ticker, { long: 0.0, short: 0.0 }])
    ),
  };

  if (portfolioPositions && portfolioPositions.length > 0) {
    const positions = portfolio["positions"] as Record<string, Record<string, number>>;
    let marginUsed = 0.0;

    for (const pos of portfolioPositions) {
      const { ticker, quantity, trade_price } = pos;
      if (!(ticker in positions)) continue;

      if (quantity > 0) {
        positions[ticker]!["long"] = quantity;
        positions[ticker]!["long_cost_basis"] = trade_price;
      } else if (quantity < 0) {
        const absQty = Math.abs(quantity);
        positions[ticker]!["short"] = absQty;
        positions[ticker]!["short_cost_basis"] = trade_price;
        const marginForTicker = absQty * trade_price * marginRequirement;
        positions[ticker]!["short_margin_used"] = marginForTicker;
        marginUsed += marginForTicker;
      }
    }

    portfolio["margin_used"] = marginUsed;
  }

  return portfolio;
}
