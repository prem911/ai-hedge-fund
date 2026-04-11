import { HumanMessage } from "@langchain/core/messages";
import type { AgentState } from "../graph/state.js";
import { showAgentReasoning } from "../graph/state.js";
import { getApiKeyFromState } from "../utils/apiKey.js";
import { progress } from "../utils/progress.js";
import { getPrices } from "../tools/api.js";

function computeReturns(closes: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i]! - closes[i - 1]!) / closes[i - 1]!);
  }
  return returns;
}

function mean(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function std(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((acc, v) => acc + (v - m) ** 2, 0) / arr.length);
}

function calculateVolatilityMetrics(closes: number[], lookbackDays = 60): {
  daily_volatility: number;
  annualized_volatility: number;
  volatility_percentile: number;
  data_points: number;
} {
  if (closes.length < 2) {
    return { daily_volatility: 0.05, annualized_volatility: 0.05 * Math.sqrt(252), volatility_percentile: 100, data_points: closes.length };
  }

  const allReturns = computeReturns(closes);
  if (allReturns.length < 2) {
    return { daily_volatility: 0.05, annualized_volatility: 0.05 * Math.sqrt(252), volatility_percentile: 100, data_points: allReturns.length };
  }

  const recent = allReturns.slice(-Math.min(lookbackDays, allReturns.length));
  const dailyVol = std(recent);
  const annualizedVol = dailyVol * Math.sqrt(252);

  let volPercentile = 50;
  if (allReturns.length >= 30) {
    const rollingVols: number[] = [];
    for (let i = 30; i <= allReturns.length; i++) {
      rollingVols.push(std(allReturns.slice(i - 30, i)));
    }
    const belowCount = rollingVols.filter(v => v <= dailyVol).length;
    volPercentile = (belowCount / rollingVols.length) * 100;
  }

  return {
    daily_volatility: isFinite(dailyVol) ? dailyVol : 0.025,
    annualized_volatility: isFinite(annualizedVol) ? annualizedVol : 0.25,
    volatility_percentile: isFinite(volPercentile) ? volPercentile : 50,
    data_points: recent.length,
  };
}

function calculateVolatilityAdjustedLimit(annualizedVolatility: number): number {
  const base = 0.20;
  let mul: number;
  if (annualizedVolatility < 0.15) {
    mul = 1.25;
  } else if (annualizedVolatility < 0.30) {
    mul = 1.0 - (annualizedVolatility - 0.15) * 0.5;
  } else if (annualizedVolatility < 0.50) {
    mul = 0.75 - (annualizedVolatility - 0.30) * 0.5;
  } else {
    mul = 0.50;
  }
  return base * Math.max(0.25, Math.min(1.25, mul));
}

function calculateCorrelationMultiplier(avgCorrelation: number): number {
  if (avgCorrelation >= 0.80) return 0.70;
  if (avgCorrelation >= 0.60) return 0.85;
  if (avgCorrelation >= 0.40) return 1.00;
  if (avgCorrelation >= 0.20) return 1.05;
  return 1.10;
}

function computeCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;
  const xs = x.slice(0, n);
  const ys = y.slice(0, n);
  const mx = mean(xs);
  const my = mean(ys);
  const cov = xs.reduce((acc, v, i) => acc + (v - mx) * (ys[i]! - my), 0) / n;
  const sx = std(xs);
  const sy = std(ys);
  return sx > 0 && sy > 0 ? cov / (sx * sy) : 0;
}

export async function riskManagementAgent(
  state: AgentState,
  agentId = "risk_management_agent"
): Promise<Partial<AgentState>> {
  const data = state.data as Record<string, unknown>;
  const portfolio = (data["portfolio"] as Record<string, unknown>) ?? {};
  const tickers = (data["tickers"] as string[]) ?? [];
  const apiKey = getApiKeyFromState(state, "FINANCIAL_DATASETS_API_KEY");
  const startDate = data["start_date"] as string;
  const endDate = data["end_date"] as string;

  const riskAnalysis: Record<string, unknown> = {};
  const currentPrices: Record<string, number> = {};
  const volatilityData: Record<string, ReturnType<typeof calculateVolatilityMetrics>> = {};
  const returnsByTicker: Record<string, number[]> = {};

  const positions = (portfolio["positions"] as Record<string, unknown>) ?? {};
  const allTickers = new Set([...tickers, ...Object.keys(positions)]);

  for (const ticker of allTickers) {
    progress.updateStatus(agentId, ticker, "Fetching price data and calculating volatility");
    const prices = await getPrices(ticker, startDate, endDate, apiKey);

    if (!prices.length) {
      progress.updateStatus(agentId, ticker, "Warning: No price data found");
      volatilityData[ticker] = { daily_volatility: 0.05, annualized_volatility: 0.05 * Math.sqrt(252), volatility_percentile: 100, data_points: 0 };
      continue;
    }

    const closes = prices.map(p => p.close);
    const currentPrice = closes[closes.length - 1]!;
    currentPrices[ticker] = currentPrice;

    const vm = calculateVolatilityMetrics(closes);
    volatilityData[ticker] = vm;
    returnsByTicker[ticker] = computeReturns(closes);

    progress.updateStatus(agentId, ticker, `Price: ${currentPrice.toFixed(2)}, Ann. Vol: ${(vm.annualized_volatility * 100).toFixed(1)}%`);
  }

  // Build correlation matrix (simplified)
  const corrMatrix: Record<string, Record<string, number>> = {};
  const rtKeys = Object.keys(returnsByTicker);
  if (rtKeys.length >= 2) {
    for (const t1 of rtKeys) {
      corrMatrix[t1] = {};
      for (const t2 of rtKeys) {
        if (t1 === t2) { corrMatrix[t1]![t2] = 1.0; continue; }
        const r1 = returnsByTicker[t1]!;
        const r2 = returnsByTicker[t2]!;
        corrMatrix[t1]![t2] = computeCorrelation(r1, r2);
      }
    }
  }

  const activePositions = new Set(
    Object.entries(positions)
      .filter(([, pos]) => {
        const p = pos as Record<string, unknown>;
        return Math.abs((p["long"] as number ?? 0) - (p["short"] as number ?? 0)) > 0;
      })
      .map(([t]) => t)
  );

  let totalPortfolioValue = parseFloat(String(portfolio["cash"] ?? 0));
  for (const [ticker, position] of Object.entries(positions)) {
    if (currentPrices[ticker] != null) {
      const pos = position as Record<string, unknown>;
      totalPortfolioValue += (pos["long"] as number ?? 0) * currentPrices[ticker]!;
      totalPortfolioValue -= (pos["short"] as number ?? 0) * currentPrices[ticker]!;
    }
  }

  progress.updateStatus(agentId, null, `Total portfolio value: ${totalPortfolioValue.toFixed(2)}`);

  for (const ticker of tickers) {
    progress.updateStatus(agentId, ticker, "Calculating volatility- and correlation-adjusted limits");

    if (!currentPrices[ticker] || currentPrices[ticker]! <= 0) {
      progress.updateStatus(agentId, ticker, "Failed: No valid price data");
      riskAnalysis[ticker] = { remaining_position_limit: 0.0, current_price: 0.0, reasoning: { error: "Missing price data" } };
      continue;
    }

    const currentPrice = currentPrices[ticker]!;
    const volData = volatilityData[ticker] ?? { daily_volatility: 0.05, annualized_volatility: 0.25, volatility_percentile: 100, data_points: 0 };
    const position = (positions[ticker] as Record<string, unknown>) ?? { long: 0, short: 0 };
    const longValue = (position["long"] as number ?? 0) * currentPrice;
    const shortValue = (position["short"] as number ?? 0) * currentPrice;
    const currentPositionValue = Math.abs(longValue - shortValue);

    const volAdjustedLimitPct = calculateVolatilityAdjustedLimit(volData.annualized_volatility);

    // Correlation adjustment
    let corrMultiplier = 1.0;
    const corrMetrics: Record<string, unknown> = { avg_correlation_with_active: null, max_correlation_with_active: null, top_correlated_tickers: [] };
    if (corrMatrix[ticker] && rtKeys.length >= 2) {
      const comparable = [...activePositions].filter(t => t in corrMatrix && t !== ticker);
      const useTickers = comparable.length > 0 ? comparable : rtKeys.filter(t => t !== ticker);
      if (useTickers.length > 0) {
        const corrs = useTickers.map(t => corrMatrix[ticker]?.[t] ?? 0).filter(v => isFinite(v));
        if (corrs.length > 0) {
          const avgCorr = mean(corrs);
          const maxCorr = Math.max(...corrs);
          corrMetrics["avg_correlation_with_active"] = avgCorr;
          corrMetrics["max_correlation_with_active"] = maxCorr;
          corrMultiplier = calculateCorrelationMultiplier(avgCorr);
          corrMetrics["top_correlated_tickers"] = useTickers
            .map(t => ({ ticker: t, correlation: corrMatrix[ticker]?.[t] ?? 0 }))
            .sort((a, b) => b.correlation - a.correlation)
            .slice(0, 3);
        }
      }
    }

    const combinedLimitPct = volAdjustedLimitPct * corrMultiplier;
    const positionLimit = totalPortfolioValue * combinedLimitPct;
    const remainingPositionLimit = positionLimit - currentPositionValue;
    const maxPositionSize = Math.min(remainingPositionLimit, parseFloat(String(portfolio["cash"] ?? 0)));

    riskAnalysis[ticker] = {
      remaining_position_limit: Math.max(0, maxPositionSize),
      current_price: currentPrice,
      volatility_metrics: {
        daily_volatility: volData.daily_volatility,
        annualized_volatility: volData.annualized_volatility,
        volatility_percentile: volData.volatility_percentile,
        data_points: volData.data_points,
      },
      correlation_metrics: corrMetrics,
      reasoning: {
        portfolio_value: totalPortfolioValue,
        current_position_value: currentPositionValue,
        base_position_limit_pct: volAdjustedLimitPct,
        correlation_multiplier: corrMultiplier,
        combined_position_limit_pct: combinedLimitPct,
        position_limit: positionLimit,
        remaining_limit: remainingPositionLimit,
        available_cash: parseFloat(String(portfolio["cash"] ?? 0)),
        risk_adjustment: `Volatility x Correlation adjusted: ${(combinedLimitPct * 100).toFixed(1)}% (base ${(volAdjustedLimitPct * 100).toFixed(1)}%)`,
      },
    };

    progress.updateStatus(agentId, ticker, `Adj. limit: ${(combinedLimitPct * 100).toFixed(1)}%, Available: $${maxPositionSize.toFixed(0)}`);
  }

  progress.updateStatus(agentId, null, "Done");

  const message = new HumanMessage({ content: JSON.stringify(riskAnalysis), name: agentId });

  if ((state.metadata as Record<string, unknown>)["show_reasoning"]) {
    showAgentReasoning(riskAnalysis, "Volatility-Adjusted Risk Management Agent");
  }

  const existingSignals = (data["analyst_signals"] as Record<string, unknown>) ?? {};
  data["analyst_signals"] = { ...existingSignals, [agentId]: riskAnalysis };

  const messages = [...(state.messages ?? []), message];
  return { messages, data };
}
