import { HumanMessage } from "@langchain/core/messages";
import type { AgentState } from "../graph/state.js";
import { showAgentReasoning } from "../graph/state.js";
import { getApiKeyFromState } from "../utils/apiKey.js";
import { progress } from "../utils/progress.js";
import { getFinancialMetrics } from "../tools/api.js";

export async function fundamentalsAnalystAgent(
  state: AgentState,
  agentId = "fundamentals_analyst_agent"
): Promise<Partial<AgentState>> {
  const data = state.data as Record<string, unknown>;
  const endDate = data["end_date"] as string;
  const tickers = data["tickers"] as string[];
  const apiKey = getApiKeyFromState(state, "FINANCIAL_DATASETS_API_KEY");

  const fundamentalAnalysis: Record<string, unknown> = {};

  for (const ticker of tickers) {
    progress.updateStatus(agentId, ticker, "Fetching financial metrics");

    const financialMetrics = await getFinancialMetrics(ticker, endDate, "ttm", 10, apiKey);
    if (!financialMetrics.length) {
      progress.updateStatus(agentId, ticker, "Failed: No financial metrics found");
      continue;
    }

    const metrics = financialMetrics[0]!;
    const signals: string[] = [];
    const reasoning: Record<string, unknown> = {};

    progress.updateStatus(agentId, ticker, "Analyzing profitability");
    const roe = metrics.return_on_equity;
    const netMargin = metrics.net_margin;
    const opMargin = metrics.operating_margin;
    const profitabilityScore = [
      roe != null && roe > 0.15,
      netMargin != null && netMargin > 0.20,
      opMargin != null && opMargin > 0.15,
    ].filter(Boolean).length;
    signals.push(profitabilityScore >= 2 ? "bullish" : profitabilityScore === 0 ? "bearish" : "neutral");
    reasoning["profitability_signal"] = {
      signal: signals[0],
      details: `ROE: ${roe != null ? (roe * 100).toFixed(2) + "%" : "N/A"}, Net Margin: ${netMargin != null ? (netMargin * 100).toFixed(2) + "%" : "N/A"}, Op Margin: ${opMargin != null ? (opMargin * 100).toFixed(2) + "%" : "N/A"}`,
    };

    progress.updateStatus(agentId, ticker, "Analyzing growth");
    const revGrowth = metrics.revenue_growth;
    const epsGrowth = metrics.earnings_growth;
    const bvGrowth = metrics.book_value_growth;
    const growthScore = [
      revGrowth != null && revGrowth > 0.10,
      epsGrowth != null && epsGrowth > 0.10,
      bvGrowth != null && bvGrowth > 0.10,
    ].filter(Boolean).length;
    signals.push(growthScore >= 2 ? "bullish" : growthScore === 0 ? "bearish" : "neutral");
    reasoning["growth_signal"] = {
      signal: signals[1],
      details: `Revenue Growth: ${revGrowth != null ? (revGrowth * 100).toFixed(2) + "%" : "N/A"}, Earnings Growth: ${epsGrowth != null ? (epsGrowth * 100).toFixed(2) + "%" : "N/A"}`,
    };

    progress.updateStatus(agentId, ticker, "Analyzing financial health");
    const currentRatio = metrics.current_ratio;
    const debtToEquity = metrics.debt_to_equity;
    const fcfPerShare = metrics.free_cash_flow_per_share;
    const eps = metrics.earnings_per_share;
    let healthScore = 0;
    if (currentRatio != null && currentRatio > 1.5) healthScore++;
    if (debtToEquity != null && debtToEquity < 0.5) healthScore++;
    if (fcfPerShare != null && eps != null && fcfPerShare > eps * 0.8) healthScore++;
    signals.push(healthScore >= 2 ? "bullish" : healthScore === 0 ? "bearish" : "neutral");
    reasoning["financial_health_signal"] = {
      signal: signals[2],
      details: `Current Ratio: ${currentRatio != null ? currentRatio.toFixed(2) : "N/A"}, D/E: ${debtToEquity != null ? debtToEquity.toFixed(2) : "N/A"}`,
    };

    progress.updateStatus(agentId, ticker, "Analyzing valuation ratios");
    const peRatio = metrics.price_to_earnings_ratio;
    const pbRatio = metrics.price_to_book_ratio;
    const psRatio = metrics.price_to_sales_ratio;
    const priceRatioScore = [
      peRatio != null && peRatio > 25,
      pbRatio != null && pbRatio > 3,
      psRatio != null && psRatio > 5,
    ].filter(Boolean).length;
    signals.push(priceRatioScore >= 2 ? "bearish" : priceRatioScore === 0 ? "bullish" : "neutral");
    reasoning["price_ratios_signal"] = {
      signal: signals[3],
      details: `P/E: ${peRatio != null ? peRatio.toFixed(2) : "N/A"}, P/B: ${pbRatio != null ? pbRatio.toFixed(2) : "N/A"}, P/S: ${psRatio != null ? psRatio.toFixed(2) : "N/A"}`,
    };

    progress.updateStatus(agentId, ticker, "Calculating final signal");
    const bullishCount = signals.filter(s => s === "bullish").length;
    const bearishCount = signals.filter(s => s === "bearish").length;
    const overallSignal = bullishCount > bearishCount ? "bullish" : bearishCount > bullishCount ? "bearish" : "neutral";
    const confidence = Math.round(Math.max(bullishCount, bearishCount) / signals.length * 100);

    fundamentalAnalysis[ticker] = { signal: overallSignal, confidence, reasoning };
    progress.updateStatus(agentId, ticker, "Done", JSON.stringify(reasoning, null, 4));
  }

  const message = new HumanMessage({ content: JSON.stringify(fundamentalAnalysis), name: agentId });

  if ((state.metadata as Record<string, unknown>)["show_reasoning"]) {
    showAgentReasoning(fundamentalAnalysis, "Fundamental Analysis Agent");
  }

  const existingSignals = (data["analyst_signals"] as Record<string, unknown>) ?? {};
  data["analyst_signals"] = { ...existingSignals, [agentId]: fundamentalAnalysis };

  progress.updateStatus(agentId, null, "Done");

  return { messages: [message], data };
}
