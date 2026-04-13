import { HumanMessage } from "@langchain/core/messages";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import type { AgentState } from "../graph/state.js";
import { showAgentReasoning } from "../graph/state.js";
import { getApiKeyFromState } from "../utils/apiKey.js";
import { progress } from "../utils/progress.js";
import { callLlm } from "../utils/llm.js";
import { getFinancialMetrics, getMarketCap, searchLineItems, getInsiderTrades, getCompanyNews } from "../tools/api.js";
import { z } from "zod";

const SignalSchema = z.object({
  signal: z.enum(["bullish", "bearish", "neutral"]),
  confidence: z.number().min(0).max(100),
  reasoning: z.string(),
});

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function analyzeGrowthMomentum(lineItems: unknown[], prices: unknown[]): Record<string, unknown> {
  if (!lineItems.length || lineItems.length < 2) return { score: 0, details: "Insufficient data" };
  const details: string[] = [];
  let rawScore = 0;

  const revenues: number[] = lineItems.map((li: any) => li.revenue).filter((v: any): v is number => v != null);
  if (revenues.length >= 2) {
    const numYears = revenues.length - 1;
    const older = revenues[revenues.length - 1]!;
    const latest = revenues[0]!;
    if (older > 0 && latest > 0) {
      const cagr = (latest / older) ** (1 / numYears) - 1;
      if (cagr > 0.08) { rawScore += 3; details.push(`Strong revenue CAGR ${(cagr * 100).toFixed(1)}%`); }
      else if (cagr > 0.04) { rawScore += 2; details.push(`Moderate revenue CAGR ${(cagr * 100).toFixed(1)}%`); }
      else if (cagr > 0.01) { rawScore += 1; details.push(`Slight revenue CAGR ${(cagr * 100).toFixed(1)}%`); }
      else { details.push(`Minimal revenue growth ${(cagr * 100).toFixed(1)}%`); }
    }
  }

  const eps: number[] = lineItems.map((li: any) => li.earnings_per_share).filter((v: any): v is number => v != null);
  if (eps.length >= 2) {
    const numYears = eps.length - 1;
    const older = eps[eps.length - 1]!;
    const latest = eps[0]!;
    if (older > 0 && latest > 0) {
      const cagr = (latest / older) ** (1 / numYears) - 1;
      if (cagr > 0.10) { rawScore += 3; details.push(`Strong EPS CAGR ${(cagr * 100).toFixed(1)}%`); }
      else if (cagr > 0.05) { rawScore += 2; details.push(`Moderate EPS CAGR ${(cagr * 100).toFixed(1)}%`); }
      else if (cagr > 0.01) { rawScore += 1; details.push(`Slight EPS CAGR ${(cagr * 100).toFixed(1)}%`); }
      else { details.push(`Minimal EPS growth ${(cagr * 100).toFixed(1)}%`); }
    }
  }

  // Price momentum
  if (prices.length >= 3) {
    const closes: number[] = prices.map((p: any) => p.close as number).filter((v): v is number => v != null);
    if (closes.length >= 3) {
      const priceMomentum = (closes[0]! - closes[closes.length - 1]!) / closes[closes.length - 1]!;
      if (priceMomentum > 0.15) { rawScore += 3; details.push(`Strong price momentum ${(priceMomentum * 100).toFixed(1)}%`); }
      else if (priceMomentum > 0.05) { rawScore += 2; details.push(`Moderate price momentum ${(priceMomentum * 100).toFixed(1)}%`); }
      else if (priceMomentum > 0) { rawScore += 1; details.push(`Slight positive momentum ${(priceMomentum * 100).toFixed(1)}%`); }
      else { details.push(`Negative momentum ${(priceMomentum * 100).toFixed(1)}%`); }
    }
  }

  return { score: Math.min(10, (rawScore / 9) * 10), details: details.join("; ") };
}

function analyzeSentimentDruck(news: unknown[]): Record<string, unknown> {
  if (!news.length) return { score: 5, details: "No news" };
  const pos = news.filter((n: any) => n.sentiment === "positive" || n.sentiment === "bullish").length;
  const neg = news.filter((n: any) => n.sentiment === "negative" || n.sentiment === "bearish").length;
  const total = news.length;
  const posRatio = pos / total;
  if (posRatio > 0.6) return { score: 8, details: `Positive sentiment ${pos}/${total}` };
  if (posRatio > 0.4) return { score: 6, details: `Mixed sentiment ${pos}/${total}` };
  return { score: 3, details: `Negative sentiment, pos ${pos}/${total}` };
}

function analyzeInsiderActivityDruck(trades: unknown[]): Record<string, unknown> {
  if (!trades.length) return { score: 5, details: "No insider data" };
  let buys = 0, sells = 0;
  for (const t of trades) {
    const shares = (t as any).transaction_shares ?? 0;
    if (shares > 0) buys++;
    else if (shares < 0) sells++;
  }
  const total = buys + sells;
  if (!total) return { score: 5, details: "No significant transactions" };
  const ratio = buys / total;
  if (ratio > 0.7) return { score: 8, details: `Heavy buying ${buys}/${total}` };
  if (ratio > 0.4) return { score: 6, details: `Moderate buying ${buys}/${total}` };
  return { score: 4, details: `Mostly selling ${buys}/${total}` };
}

function analyzeRiskReward(lineItems: unknown[], prices: unknown[]): Record<string, unknown> {
  const details: string[] = [];
  let rawScore = 0;

  const li0: any = lineItems[0];
  const debt: number = li0?.total_debt ?? 0;
  const equity: number = li0?.shareholders_equity ?? 1;
  if (equity > 0) {
    const de = debt / equity;
    if (de < 0.5) { rawScore += 3; details.push(`Low leverage D/E ${de.toFixed(2)}`); }
    else if (de < 1.0) { rawScore += 2; details.push(`Moderate D/E ${de.toFixed(2)}`); }
    else if (de < 1.5) { rawScore += 1; details.push(`High D/E ${de.toFixed(2)}`); }
    else { details.push(`Very high D/E ${de.toFixed(2)}`); }
  }

  if (prices.length >= 10) {
    const closes: number[] = prices.map((p: any) => p.close as number).filter((v): v is number => v != null);
    if (closes.length >= 2) {
      const returns: number[] = [];
      for (let i = 1; i < closes.length; i++) returns.push((closes[i]! - closes[i - 1]!) / closes[i - 1]!);
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / returns.length;
      const stdev = Math.sqrt(variance);
      if (stdev < 0.01) { rawScore += 3; details.push(`Low volatility stdev ${(stdev * 100).toFixed(2)}%`); }
      else if (stdev < 0.02) { rawScore += 2; details.push(`Moderate volatility stdev ${(stdev * 100).toFixed(2)}%`); }
      else if (stdev < 0.04) { rawScore += 1; details.push(`High volatility stdev ${(stdev * 100).toFixed(2)}%`); }
      else { details.push(`Very high volatility stdev ${(stdev * 100).toFixed(2)}%`); }
    }
  }

  return { score: Math.min(10, (rawScore / 6) * 10), details: details.join("; ") };
}

function analyzeDruckenmillerValuation(lineItems: unknown[], marketCap: number | null): Record<string, unknown> {
  if (!lineItems.length || !marketCap) return { score: 0, details: "Insufficient data" };
  const details: string[] = [];
  let rawScore = 0;

  const li0: any = lineItems[0];
  const netIncome: number | null = li0.net_income ?? null;
  const fcf: number | null = li0.free_cash_flow ?? null;
  const ebit: number | null = li0.ebit ?? null;
  const ebitda: number | null = li0.ebitda ?? null;
  const debt: number = li0.total_debt ?? 0;
  const cash: number = li0.cash_and_equivalents ?? 0;
  const ev = marketCap + debt - cash;

  if (netIncome && netIncome > 0) {
    const pe = marketCap / netIncome;
    if (pe < 15) { rawScore += 2; details.push(`P/E ${pe.toFixed(2)} attractive`); }
    else if (pe < 25) { rawScore += 1; details.push(`P/E ${pe.toFixed(2)} fair`); }
    else { details.push(`High P/E ${pe.toFixed(2)}`); }
  }

  if (fcf && fcf > 0) {
    const pfcf = marketCap / fcf;
    if (pfcf < 15) { rawScore += 2; details.push(`P/FCF ${pfcf.toFixed(2)} attractive`); }
    else if (pfcf < 25) { rawScore += 1; details.push(`P/FCF ${pfcf.toFixed(2)} fair`); }
    else { details.push(`High P/FCF ${pfcf.toFixed(2)}`); }
  }

  if (ev > 0 && ebit && ebit > 0) {
    const evEbit = ev / ebit;
    if (evEbit < 15) { rawScore += 2; details.push(`EV/EBIT ${evEbit.toFixed(2)} attractive`); }
    else if (evEbit < 25) { rawScore += 1; details.push(`EV/EBIT ${evEbit.toFixed(2)} fair`); }
    else { details.push(`High EV/EBIT ${evEbit.toFixed(2)}`); }
  }

  if (ev > 0 && ebitda && ebitda > 0) {
    const evEbitda = ev / ebitda;
    if (evEbitda < 10) { rawScore += 2; details.push(`EV/EBITDA ${evEbitda.toFixed(2)} attractive`); }
    else if (evEbitda < 18) { rawScore += 1; details.push(`EV/EBITDA ${evEbitda.toFixed(2)} fair`); }
    else { details.push(`High EV/EBITDA ${evEbitda.toFixed(2)}`); }
  }

  return { score: Math.min(10, (rawScore / 8) * 10), details: details.join("; ") };
}

export async function stanleyDruckenmillerAgent(
  state: AgentState,
  agentId = "stanley_druckenmiller_agent"
): Promise<Partial<AgentState>> {
  const data = state.data as Record<string, unknown>;
  const startDate = data["start_date"] as string;
  const endDate = data["end_date"] as string;
  const tickers = data["tickers"] as string[];
  const apiKey = getApiKeyFromState(state, "FINANCIAL_DATASETS_API_KEY");

  const druckAnalysis: Record<string, unknown> = {};

  for (const ticker of tickers) {
    progress.updateStatus(agentId, ticker, "Fetching financial metrics");
    const metrics = await getFinancialMetrics(ticker, endDate, "annual", 5, apiKey);

    progress.updateStatus(agentId, ticker, "Gathering financial line items");
    const lineItems = await searchLineItems(ticker,
      ["revenue", "earnings_per_share", "net_income", "operating_income", "gross_margin",
       "operating_margin", "free_cash_flow", "capital_expenditure", "cash_and_equivalents",
       "total_debt", "shareholders_equity", "outstanding_shares", "ebit", "ebitda"],
      endDate, "annual", 5, apiKey);

    progress.updateStatus(agentId, ticker, "Getting market cap");
    const marketCap = await getMarketCap(ticker, endDate, apiKey);

    progress.updateStatus(agentId, ticker, "Fetching insider trades");
    const insiderTrades = await getInsiderTrades(ticker, endDate, undefined, 50, apiKey);

    progress.updateStatus(agentId, ticker, "Fetching company news");
    const companyNews = await getCompanyNews(ticker, endDate, undefined, 50, apiKey);

    // Use an empty array for prices since we don't have getPrices in scope here
    const growthMomentumAnalysis = analyzeGrowthMomentum(lineItems, []);
    const sentimentAnalysis = analyzeSentimentDruck(companyNews);
    const insiderActivity = analyzeInsiderActivityDruck(insiderTrades);
    const riskRewardAnalysis = analyzeRiskReward(lineItems, []);
    const valuationAnalysis = analyzeDruckenmillerValuation(lineItems, marketCap);

    const totalScore = (growthMomentumAnalysis["score"] as number) * 0.35 + (riskRewardAnalysis["score"] as number) * 0.20 + (valuationAnalysis["score"] as number) * 0.20 + (sentimentAnalysis["score"] as number) * 0.15 + (insiderActivity["score"] as number) * 0.10;
    const signal = totalScore >= 7.5 ? "bullish" : totalScore <= 4.5 ? "bearish" : "neutral";

    const analysisData = { signal, score: totalScore, max_score: 10, growth_momentum_analysis: growthMomentumAnalysis, sentiment_analysis: sentimentAnalysis, insider_activity: insiderActivity, risk_reward_analysis: riskRewardAnalysis, valuation_analysis: valuationAnalysis };

    progress.updateStatus(agentId, ticker, "Generating Stanley Druckenmiller analysis");
    const template = ChatPromptTemplate.fromMessages([
      ["system", `You are a Stanley Druckenmiller AI agent. Principles: asymmetric risk-reward, growth and momentum, preserve capital, aggressive when conviction is high, cut losses quickly. Be decisive and conviction-driven. Return JSON only.`],
      ["human", `Analysis Data for {ticker}:\n{analysis_data}\n\nReturn JSON:\n{{\n  "signal": "bullish" | "bearish" | "neutral",\n  "confidence": float (0-100),\n  "reasoning": "string"\n}}`],
    ]);
    const prompt = await template.invoke({ analysis_data: JSON.stringify(analysisData, null, 2), ticker });
    const result = await callLlm(prompt, SignalSchema, {
      agentName: agentId, state,
      defaultFactory: () => ({ signal: "neutral" as const, confidence: 0, reasoning: "Error in analysis" }),
    });

    druckAnalysis[ticker] = { signal: result?.signal ?? "neutral", confidence: result?.confidence ?? 0, reasoning: result?.reasoning ?? "" };
    progress.updateStatus(agentId, ticker, "Done", result?.reasoning);
  }

  const message = new HumanMessage({ content: JSON.stringify(druckAnalysis), name: agentId });
  if ((state.metadata as Record<string, unknown>)["show_reasoning"]) showAgentReasoning(druckAnalysis, "Stanley Druckenmiller Agent");

  const existingSignals = (data["analyst_signals"] as Record<string, unknown>) ?? {};
  data["analyst_signals"] = { ...existingSignals, [agentId]: druckAnalysis };
  progress.updateStatus(agentId, null, "Done");
  return { messages: [message], data };
}
