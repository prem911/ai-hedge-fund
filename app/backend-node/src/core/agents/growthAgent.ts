import { HumanMessage } from "@langchain/core/messages";
import type { AgentState } from "../graph/state.js";
import { showAgentReasoning } from "../graph/state.js";
import { getApiKeyFromState } from "../utils/apiKey.js";
import { progress } from "../utils/progress.js";
import { getFinancialMetrics, getInsiderTrades } from "../tools/api.js";
import type { FinancialMetrics, InsiderTrade } from "../data/models.js";

export function calculateTrend(data: (number | null)[]): number {
  const clean = data.filter((d): d is number => d !== null);
  if (clean.length < 2) return 0;
  const n = clean.length;
  const x = Array.from({ length: n }, (_, i) => i);
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = clean.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((acc, xi, i) => acc + xi * clean[i]!, 0);
  const sumX2 = x.reduce((acc, xi) => acc + xi * xi, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

export function analyzeGrowthTrends(metrics: FinancialMetrics[]): { score: number; [key: string]: unknown } {
  const revGrowth = metrics.map(m => m.revenue_growth ?? null);
  const epsGrowth = metrics.map(m => m.earnings_per_share_growth ?? null);
  const fcfGrowth = metrics.map(m => m.free_cash_flow_growth ?? null);

  const revTrend = calculateTrend(revGrowth);
  const epsTrend = calculateTrend(epsGrowth);
  const fcfTrend = calculateTrend(fcfGrowth);

  let score = 0;

  if (revGrowth[0] != null) {
    if (revGrowth[0] > 0.20) score += 0.4;
    else if (revGrowth[0] > 0.10) score += 0.2;
    if (revTrend > 0) score += 0.1;
  }
  if (epsGrowth[0] != null) {
    if (epsGrowth[0] > 0.20) score += 0.25;
    else if (epsGrowth[0] > 0.10) score += 0.1;
    if (epsTrend > 0) score += 0.05;
  }
  if (fcfGrowth[0] != null && fcfGrowth[0] > 0.15) score += 0.1;

  score = Math.min(score, 1.0);

  return {
    score,
    revenue_growth: revGrowth[0],
    revenue_trend: revTrend,
    eps_growth: epsGrowth[0],
    eps_trend: epsTrend,
    fcf_growth: fcfGrowth[0],
    fcf_trend: fcfTrend,
  };
}

export function analyzeValuation(metrics: FinancialMetrics): { score: number; [key: string]: unknown } {
  const pegRatio = metrics.peg_ratio;
  const psRatio = metrics.price_to_sales_ratio;
  let score = 0;

  if (pegRatio != null) {
    if (pegRatio < 1.0) score += 0.5;
    else if (pegRatio < 2.0) score += 0.25;
  }
  if (psRatio != null) {
    if (psRatio < 2.0) score += 0.5;
    else if (psRatio < 5.0) score += 0.25;
  }

  score = Math.min(score, 1.0);
  return { score, peg_ratio: pegRatio, price_to_sales_ratio: psRatio };
}

export function analyzeMarginTrends(metrics: FinancialMetrics[]): { score: number; [key: string]: unknown } {
  const grossMargins = metrics.map(m => m.gross_margin ?? null);
  const opMargins = metrics.map(m => m.operating_margin ?? null);
  const netMargins = metrics.map(m => m.net_margin ?? null);

  const gmTrend = calculateTrend(grossMargins);
  const omTrend = calculateTrend(opMargins);
  const nmTrend = calculateTrend(netMargins);

  let score = 0;
  if (grossMargins[0] != null) {
    if (grossMargins[0] > 0.5) score += 0.2;
    if (gmTrend > 0) score += 0.2;
  }
  if (opMargins[0] != null) {
    if (opMargins[0] > 0.15) score += 0.2;
    if (omTrend > 0) score += 0.2;
  }
  if (nmTrend > 0) score += 0.2;

  score = Math.min(score, 1.0);
  return {
    score,
    gross_margin: grossMargins[0],
    gross_margin_trend: gmTrend,
    operating_margin: opMargins[0],
    operating_margin_trend: omTrend,
    net_margin: netMargins[0],
    net_margin_trend: nmTrend,
  };
}

export function analyzeInsiderConviction(trades: InsiderTrade[]): { score: number; [key: string]: unknown } {
  const buys = trades
    .filter(t => t.transaction_value && t.transaction_shares != null && t.transaction_shares > 0)
    .reduce((acc, t) => acc + (t.transaction_value ?? 0), 0);
  const sells = trades
    .filter(t => t.transaction_value && t.transaction_shares != null && t.transaction_shares < 0)
    .reduce((acc, t) => acc + Math.abs(t.transaction_value ?? 0), 0);

  const netFlowRatio = buys + sells === 0 ? 0 : (buys - sells) / (buys + sells);

  let score: number;
  if (netFlowRatio > 0.5) score = 1.0;
  else if (netFlowRatio > 0.1) score = 0.7;
  else if (netFlowRatio > -0.1) score = 0.5;
  else score = 0.2;

  return { score, net_flow_ratio: netFlowRatio, buys, sells };
}

export function checkFinancialHealth(metrics: FinancialMetrics): { score: number; [key: string]: unknown } {
  const debtToEquity = metrics.debt_to_equity;
  const currentRatio = metrics.current_ratio;
  let score = 1.0;

  if (debtToEquity != null) {
    if (debtToEquity > 1.5) score -= 0.5;
    else if (debtToEquity > 0.8) score -= 0.2;
  }
  if (currentRatio != null) {
    if (currentRatio < 1.0) score -= 0.5;
    else if (currentRatio < 1.5) score -= 0.2;
  }

  score = Math.max(score, 0.0);
  return { score, debt_to_equity: debtToEquity, current_ratio: currentRatio };
}

export async function growthAnalystAgent(
  state: AgentState,
  agentId = "growth_analyst_agent"
): Promise<Partial<AgentState>> {
  const data = state.data as Record<string, unknown>;
  const endDate = data["end_date"] as string;
  const tickers = data["tickers"] as string[];
  const apiKey = getApiKeyFromState(state, "FINANCIAL_DATASETS_API_KEY");

  const growthAnalysis: Record<string, unknown> = {};

  for (const ticker of tickers) {
    progress.updateStatus(agentId, ticker, "Fetching financial data");

    const financialMetrics = await getFinancialMetrics(ticker, endDate, "ttm", 12, apiKey);
    if (!financialMetrics.length || financialMetrics.length < 4) {
      progress.updateStatus(agentId, ticker, "Failed: Not enough financial metrics");
      continue;
    }

    const mostRecentMetrics = financialMetrics[0]!;

    const insiderTrades = await getInsiderTrades(ticker, endDate, undefined, 1000, apiKey);

    const growthTrends = analyzeGrowthTrends(financialMetrics);
    const valuationMetrics = analyzeValuation(mostRecentMetrics);
    const marginTrends = analyzeMarginTrends(financialMetrics);
    const insiderConviction = analyzeInsiderConviction(insiderTrades);
    const financialHealth = checkFinancialHealth(mostRecentMetrics);

    const scores = {
      growth: growthTrends.score,
      valuation: valuationMetrics.score,
      margins: marginTrends.score,
      insider: insiderConviction.score,
      health: financialHealth.score,
    };

    const weights = { growth: 0.40, valuation: 0.25, margins: 0.15, insider: 0.10, health: 0.10 };
    const weightedScore = Object.keys(scores).reduce(
      (acc, key) => acc + (scores as Record<string, number>)[key]! * (weights as Record<string, number>)[key]!, 0
    );

    const signal = weightedScore > 0.6 ? "bullish" : weightedScore < 0.4 ? "bearish" : "neutral";
    const confidence = Math.round(Math.abs(weightedScore - 0.5) * 2 * 100);

    const reasoning = {
      historical_growth: growthTrends,
      growth_valuation: valuationMetrics,
      margin_expansion: marginTrends,
      insider_conviction: insiderConviction,
      financial_health: financialHealth,
      final_analysis: { signal, confidence, weighted_score: Math.round(weightedScore * 100) / 100 },
    };

    growthAnalysis[ticker] = { signal, confidence, reasoning };
    progress.updateStatus(agentId, ticker, "Done", JSON.stringify(reasoning, null, 4));
  }

  const message = new HumanMessage({ content: JSON.stringify(growthAnalysis), name: agentId });

  if ((state.metadata as Record<string, unknown>)["show_reasoning"]) {
    showAgentReasoning(growthAnalysis, "Growth Analysis Agent");
  }

  const existingSignals = (data["analyst_signals"] as Record<string, unknown>) ?? {};
  data["analyst_signals"] = { ...existingSignals, [agentId]: growthAnalysis };

  progress.updateStatus(agentId, null, "Done");

  return { messages: [message], data };
}
