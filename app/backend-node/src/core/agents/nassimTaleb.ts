import { HumanMessage } from "@langchain/core/messages";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import type { AgentState } from "../graph/state.js";
import { showAgentReasoning } from "../graph/state.js";
import { getApiKeyFromState } from "../utils/apiKey.js";
import { progress } from "../utils/progress.js";
import { callLlm } from "../utils/llm.js";
import { getFinancialMetrics, getMarketCap, searchLineItems, getInsiderTrades, getCompanyNews, getPrices } from "../tools/api.js";
import { z } from "zod";

const SignalSchema = z.object({
  signal: z.enum(["bullish", "bearish", "neutral"]),
  confidence: z.number().int().min(0).max(100),
  reasoning: z.string(),
});

function safeFloat(value: unknown, defaultVal = 0.0): number {
  if (value == null || typeof value !== "number" || isNaN(value) || !isFinite(value)) return defaultVal;
  return value;
}

function computeReturns(closes: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) returns.push((closes[i]! - closes[i - 1]!) / closes[i - 1]!);
  return returns;
}

function computeMean(arr: number[]): number { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function computeStd(arr: number[], mean?: number): number {
  if (!arr.length) return 0;
  const m = mean ?? computeMean(arr);
  return Math.sqrt(arr.reduce((acc, v) => acc + (v - m) ** 2, 0) / arr.length);
}
function computePercentile(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}
function computeKurtosis(arr: number[]): number {
  if (arr.length < 4) return 0;
  const m = computeMean(arr);
  const s = computeStd(arr, m);
  if (s === 0) return 0;
  return arr.reduce((acc, v) => acc + ((v - m) / s) ** 4, 0) / arr.length - 3;
}
function computeSkewness(arr: number[]): number {
  if (arr.length < 3) return 0;
  const m = computeMean(arr);
  const s = computeStd(arr, m);
  if (s === 0) return 0;
  return arr.reduce((acc, v) => acc + ((v - m) / s) ** 3, 0) / arr.length;
}

function analyzeTailRisk(prices: unknown[]): Record<string, unknown> {
  if (prices.length < 20) return { score: 0, max_score: 8, details: "Insufficient price data" };
  const closes = prices.map((p: any) => p.close as number);
  const returns = computeReturns(closes);
  if (returns.length < 10) return { score: 0, max_score: 8, details: "Insufficient returns" };

  let score = 0;
  const reasoning: string[] = [];

  const kurt = computeKurtosis(returns);
  if (kurt > 5) { score += 2; reasoning.push(`Extremely fat tails (kurtosis ${kurt.toFixed(1)})`); }
  else if (kurt > 2) { score += 1; reasoning.push(`Moderate fat tails (kurtosis ${kurt.toFixed(1)})`); }
  else { reasoning.push(`Near-Gaussian tails (kurtosis ${kurt.toFixed(1)})`); }

  const skew = computeSkewness(returns);
  if (skew > 0.5) { score += 2; reasoning.push(`Positive skew ${skew.toFixed(2)}`); }
  else if (skew > -0.5) { score += 1; reasoning.push(`Symmetric (skew ${skew.toFixed(2)})`); }
  else { reasoning.push(`Negative skew ${skew.toFixed(2)}`); }

  const positiveReturns = returns.filter(r => r > 0);
  const negativeReturns = returns.filter(r => r < 0);
  if (positiveReturns.length > 5 && negativeReturns.length > 5) {
    const rightTail = computePercentile(positiveReturns, 95);
    const leftTail = Math.abs(computePercentile(negativeReturns, 5));
    const tailRatio = leftTail > 0 ? rightTail / leftTail : 1;
    if (tailRatio > 1.2) { score += 2; reasoning.push(`Asymmetric upside (tail ratio ${tailRatio.toFixed(2)})`); }
    else if (tailRatio > 0.8) { score += 1; reasoning.push(`Balanced tails (tail ratio ${tailRatio.toFixed(2)})`); }
    else { reasoning.push(`Asymmetric downside (tail ratio ${tailRatio.toFixed(2)})`); }
  }

  // Max drawdown
  let peak = closes[0]!;
  let maxDd = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    const dd = (c - peak) / peak;
    if (dd < maxDd) maxDd = dd;
  }
  if (maxDd > -0.15) { score += 2; reasoning.push(`Resilient (max drawdown ${(maxDd * 100).toFixed(1)}%)`); }
  else if (maxDd > -0.30) { score += 1; reasoning.push(`Moderate drawdown ${(maxDd * 100).toFixed(1)}%`); }
  else { reasoning.push(`Severe drawdown ${(maxDd * 100).toFixed(1)}%`); }

  return { score, max_score: 8, details: reasoning.join("; ") };
}

function analyzeAntifragility(metrics: unknown[], lineItems: unknown[], marketCap: number | null): Record<string, unknown> {
  let score = 0;
  const reasoning: string[] = [];
  const m0: any = metrics[0];
  const li0: any = lineItems[0];

  const cash: number | null = li0?.cash_and_equivalents ?? null;
  const totalDebt: number | null = li0?.total_debt ?? null;
  const totalAssets: number | null = li0?.total_assets ?? null;

  if (cash != null && totalDebt != null) {
    const netCash = cash - totalDebt;
    if (netCash > 0 && marketCap && cash > 0.20 * marketCap) { score += 3; reasoning.push(`War chest: net cash $${netCash.toLocaleString()}`); }
    else if (netCash > 0) { score += 2; reasoning.push(`Net cash positive $${netCash.toLocaleString()}`); }
    else if (totalAssets && totalDebt < 0.30 * totalAssets) { score += 1; reasoning.push("Manageable net debt"); }
    else { reasoning.push("Leveraged position"); }
  }

  const dte = m0?.debt_to_equity ?? null;
  if (dte != null) {
    if (dte < 0.3) { score += 2; reasoning.push(`Low leverage D/E ${dte.toFixed(2)}`); }
    else if (dte < 0.7) { score += 1; reasoning.push(`Moderate D/E ${dte.toFixed(2)}`); }
    else { reasoning.push(`High D/E ${dte.toFixed(2)}`); }
  }

  const opMargins: number[] = (metrics as any[]).map(m => m.operating_margin).filter((v: any): v is number => v != null);
  if (opMargins.length >= 3) {
    const mean = computeMean(opMargins);
    const cv = computeStd(opMargins) / Math.abs(mean || 1);
    if (cv < 0.15 && mean > 0.15) { score += 3; reasoning.push(`Stable high margins (avg ${(mean * 100).toFixed(1)}%, CV ${cv.toFixed(2)})`); }
    else if (cv < 0.30 && mean > 0.10) { score += 2; reasoning.push(`Reasonable margin stability`); }
    else if (cv < 0.30) { score += 1; reasoning.push(`Margins stable but low`); }
    else { reasoning.push(`Volatile margins CV ${cv.toFixed(2)}`); }
  }

  const fcfs: number[] = lineItems.map((li: any) => li.free_cash_flow).filter((v: any): v is number => v != null);
  if (fcfs.length) {
    const pos = fcfs.filter(v => v > 0).length;
    if (pos === fcfs.length) { score += 2; reasoning.push(`Consistent FCF (${pos}/${fcfs.length})`); }
    else if (pos > fcfs.length / 2) { score += 1; reasoning.push(`Majority positive FCF (${pos}/${fcfs.length})`); }
    else { reasoning.push(`Inconsistent FCF (${pos}/${fcfs.length})`); }
  }

  return { score, max_score: 10, details: reasoning.join("; ") };
}

function analyzeConvexity(metrics: unknown[], lineItems: unknown[], prices: unknown[], marketCap: number | null): Record<string, unknown> {
  let score = 0;
  const reasoning: string[] = [];
  const li0: any = lineItems[0];

  const rd: number | null = li0?.research_and_development ?? null;
  const revenue: number | null = li0?.revenue ?? null;
  if (rd != null && revenue && revenue > 0) {
    const rdRatio = Math.abs(rd) / revenue;
    if (rdRatio > 0.15) { score += 3; reasoning.push(`High R&D ${(rdRatio * 100).toFixed(1)}%`); }
    else if (rdRatio > 0.08) { score += 2; reasoning.push(`Meaningful R&D ${(rdRatio * 100).toFixed(1)}%`); }
    else if (rdRatio > 0.03) { score += 1; reasoning.push(`Modest R&D ${(rdRatio * 100).toFixed(1)}%`); }
    else { reasoning.push(`Minimal R&D ${(rdRatio * 100).toFixed(1)}%`); }
  } else { reasoning.push("R&D data N/A"); }

  if (prices.length >= 20) {
    const closes = prices.map((p: any) => p.close as number);
    const returns = computeReturns(closes);
    const upside = returns.filter(r => r > 0);
    const downside = returns.filter(r => r < 0);
    if (upside.length > 10 && downside.length > 10) {
      const avgUp = computeMean(upside);
      const avgDown = Math.abs(computeMean(downside));
      const ratio = avgDown > 0 ? avgUp / avgDown : 1;
      if (ratio > 1.3) { score += 2; reasoning.push(`Convex returns (up/down ${ratio.toFixed(2)})`); }
      else if (ratio > 1.0) { score += 1; reasoning.push(`Slight positive asymmetry ${ratio.toFixed(2)}`); }
      else { reasoning.push(`Concave returns ${ratio.toFixed(2)}`); }
    }
  }

  const cash: number | null = li0?.cash_and_equivalents ?? null;
  if (cash != null && marketCap && marketCap > 0) {
    const cashRatio = cash / marketCap;
    if (cashRatio > 0.30) { score += 3; reasoning.push(`Cash optionality ${(cashRatio * 100).toFixed(0)}%`); }
    else if (cashRatio > 0.15) { score += 2; reasoning.push(`Strong cash ${(cashRatio * 100).toFixed(0)}%`); }
    else if (cashRatio > 0.05) { score += 1; reasoning.push(`Moderate cash ${(cashRatio * 100).toFixed(0)}%`); }
  }

  if (li0?.free_cash_flow != null && marketCap && marketCap > 0) {
    const fcfYield = (li0.free_cash_flow as number) / marketCap;
    if (fcfYield > 0.10) { score += 2; reasoning.push(`High FCF yield ${(fcfYield * 100).toFixed(1)}%`); }
    else if (fcfYield > 0.05) { score += 1; reasoning.push(`Decent FCF yield ${(fcfYield * 100).toFixed(1)}%`); }
  }

  return { score, max_score: 10, details: reasoning.join("; ") };
}

function analyzeFragility(metrics: unknown[], lineItems: unknown[]): Record<string, unknown> {
  if (!metrics.length) return { score: 0, max_score: 8, details: "Insufficient data" };
  const m0: any = metrics[0];
  let score = 0;
  const reasoning: string[] = [];

  const dte = m0.debt_to_equity ?? null;
  if (dte != null) {
    if (dte > 2.0) { reasoning.push(`Extremely fragile D/E ${dte.toFixed(2)}`); }
    else if (dte > 1.0) { score += 1; reasoning.push(`Elevated leverage D/E ${dte.toFixed(2)}`); }
    else if (dte > 0.5) { score += 2; reasoning.push(`Moderate D/E ${dte.toFixed(2)}`); }
    else { score += 3; reasoning.push(`Low D/E ${dte.toFixed(2)}`); }
  }

  const ic = m0.interest_coverage ?? null;
  if (ic != null) {
    if (ic > 10) { score += 2; reasoning.push(`Interest coverage ${ic.toFixed(1)}x`); }
    else if (ic > 5) { score += 1; reasoning.push(`Comfortable coverage ${ic.toFixed(1)}x`); }
    else { reasoning.push(`Low coverage ${ic.toFixed(1)}x`); }
  }

  const egs: number[] = (metrics as any[]).map(m => m.earnings_growth).filter((v: any): v is number => v != null);
  if (egs.length >= 3) {
    const mean = computeMean(egs);
    const std = computeStd(egs);
    if (std < 0.20) { score += 2; reasoning.push(`Stable earnings std ${std.toFixed(2)}`); }
    else if (std < 0.50) { score += 1; reasoning.push(`Moderate earnings volatility std ${std.toFixed(2)}`); }
    else { reasoning.push(`Volatile earnings std ${std.toFixed(2)}`); }
  }

  const nm = m0.net_margin ?? null;
  if (nm != null) {
    if (nm > 0.15) { score += 1; reasoning.push(`Fat margins ${(nm * 100).toFixed(1)}%`); }
    else if (nm >= 0.05) { reasoning.push(`Moderate margins ${(nm * 100).toFixed(1)}%`); }
    else { reasoning.push(`Thin margins ${(nm * 100).toFixed(1)}%`); }
  }

  return { score: Math.max(0, score), max_score: 8, details: reasoning.join("; ") };
}

function analyzeSkinInGame(trades: unknown[]): Record<string, unknown> {
  if (!trades.length) return { score: 1, max_score: 4, details: "No insider trade data" };
  let bought = 0, sold = 0;
  for (const t of trades) {
    const shares = (t as any).transaction_shares ?? 0;
    if (shares > 0) bought += shares;
    else if (shares < 0) sold += Math.abs(shares);
  }
  const net = bought - sold;
  if (net > 0) {
    const ratio = net / Math.max(sold, 1);
    if (ratio > 2.0) return { score: 4, max_score: 4, details: `Strong insider buying net ${net.toLocaleString()} shares (ratio ${ratio.toFixed(1)}x)` };
    if (ratio > 0.5) return { score: 3, max_score: 4, details: `Moderate insider conviction net ${net.toLocaleString()}` };
    return { score: 2, max_score: 4, details: `Net insider buying ${net.toLocaleString()}` };
  }
  return { score: 0, max_score: 4, details: `Insiders selling net ${net.toLocaleString()}` };
}

function analyzeVolatilityRegime(prices: unknown[]): Record<string, unknown> {
  if (prices.length < 30) return { score: 0, max_score: 6, details: "Insufficient price data" };
  const closes = prices.map((p: any) => p.close as number);
  const returns = computeReturns(closes);
  const sqrt252 = Math.sqrt(252);

  const histVols: number[] = [];
  for (let i = 20; i < returns.length; i++) {
    const window = returns.slice(i - 20, i);
    histVols.push(computeStd(window) * sqrt252);
  }
  if (!histVols.length) return { score: 0, max_score: 6, details: "Insufficient vol data" };

  const currentVol = histVols[histVols.length - 1]!;
  const avgVol = computeMean(histVols);
  const volRegime = avgVol > 0 ? currentVol / avgVol : 1;

  let score = 0;
  const reasoning: string[] = [];
  if (volRegime < 0.7) { reasoning.push(`Dangerously low vol ${volRegime.toFixed(2)}`); }
  else if (volRegime < 0.9) { score += 1; reasoning.push(`Below-average vol ${volRegime.toFixed(2)}`); }
  else if (volRegime <= 1.3) { score += 3; reasoning.push(`Normal vol regime ${volRegime.toFixed(2)}`); }
  else if (volRegime <= 2.0) { score += 4; reasoning.push(`Elevated vol ${volRegime.toFixed(2)}`); }
  else { score += 2; reasoning.push(`Extreme vol ${volRegime.toFixed(2)}`); }

  return { score, max_score: 6, details: reasoning.join("; ") };
}

function analyzeBlackSwanSentinel(news: unknown[], prices: unknown[]): Record<string, unknown> {
  let score = 2;
  const reasoning: string[] = [];

  let negRatio = 0;
  if (news.length) {
    const total = news.length;
    const negCount = news.filter((n: any) => n.sentiment && ["negative", "bearish"].includes(n.sentiment.toLowerCase())).length;
    negRatio = total > 0 ? negCount / total : 0;
  } else { reasoning.push("No recent news"); }

  let volumeSpike = 1.0;
  let recentReturn = 0.0;
  if (prices.length >= 10) {
    const volumes: number[] = prices.map((p: any) => p.volume as number).filter((v): v is number => v != null);
    if (volumes.length >= 10) {
      const recentVol = computeMean(volumes.slice(-5));
      const avgVol = computeMean(volumes);
      volumeSpike = avgVol > 0 ? recentVol / avgVol : 1;
    }
    if (prices.length >= 5) {
      const closes = prices.map((p: any) => p.close as number);
      recentReturn = (closes[closes.length - 1]! - closes[closes.length - 6]!) / closes[closes.length - 6]!;
    }
  }

  if (negRatio > 0.7 && volumeSpike > 2.0) { score = 0; reasoning.push(`Black swan warning ${(negRatio * 100).toFixed(0)}% neg news, ${volumeSpike.toFixed(1)}x volume`); }
  else if (negRatio > 0.5 || volumeSpike > 2.5) { score = 1; reasoning.push(`Elevated stress signals`); }
  else if (negRatio > 0.3 && Math.abs(recentReturn) > 0.10) { score = 1; reasoning.push(`Moderate stress with price dislocation`); }
  else if (negRatio < 0.3 && volumeSpike < 1.5) { score = 3; reasoning.push("No black swan signals"); }
  else { reasoning.push(`Normal conditions neg ${(negRatio * 100).toFixed(0)}%, vol ${volumeSpike.toFixed(1)}x`); }

  if (negRatio > 0.4 && volumeSpike < 1.5 && score < 4) { score = Math.min(score + 1, 4); reasoning.push("Contrarian opportunity"); }

  return { score, max_score: 4, details: reasoning.join("; ") };
}

export async function nassimTalebAgent(
  state: AgentState,
  agentId = "nassim_taleb_agent"
): Promise<Partial<AgentState>> {
  const data = state.data as Record<string, unknown>;
  const endDate = data["end_date"] as string;
  const tickers = data["tickers"] as string[];
  const apiKey = getApiKeyFromState(state, "FINANCIAL_DATASETS_API_KEY");
  const startDate = new Date(new Date(endDate).getTime() - 365 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]!;

  const talebAnalysis: Record<string, unknown> = {};

  for (const ticker of tickers) {
    progress.updateStatus(agentId, ticker, "Fetching price data");
    const prices = await getPrices(ticker, startDate, endDate, apiKey);

    progress.updateStatus(agentId, ticker, "Fetching financial metrics");
    const metrics = await getFinancialMetrics(ticker, endDate, "ttm", 10, apiKey);

    progress.updateStatus(agentId, ticker, "Gathering financial line items");
    const lineItems = await searchLineItems(ticker,
      ["free_cash_flow", "net_income", "total_debt", "cash_and_equivalents", "total_assets",
       "total_liabilities", "revenue", "operating_income", "research_and_development",
       "capital_expenditure", "outstanding_shares"],
      endDate, "ttm", 5, apiKey);

    progress.updateStatus(agentId, ticker, "Fetching insider trades");
    const insiderTrades = await getInsiderTrades(ticker, endDate, startDate, 1000, apiKey);

    progress.updateStatus(agentId, ticker, "Fetching company news");
    const news = await getCompanyNews(ticker, endDate, startDate, 100, apiKey);

    progress.updateStatus(agentId, ticker, "Getting market cap");
    const marketCap = await getMarketCap(ticker, endDate, apiKey);

    const tailRiskAnalysis = analyzeTailRisk(prices);
    const antifragilityAnalysis = analyzeAntifragility(metrics, lineItems, marketCap);
    const convexityAnalysis = analyzeConvexity(metrics, lineItems, prices, marketCap);
    const fragilityAnalysis = analyzeFragility(metrics, lineItems);
    const skinInGameAnalysis = analyzeSkinInGame(insiderTrades);
    const volatilityRegimeAnalysis = analyzeVolatilityRegime(prices);
    const blackSwanAnalysis = analyzeBlackSwanSentinel(news, prices);

    const totalScore = [tailRiskAnalysis, antifragilityAnalysis, convexityAnalysis, fragilityAnalysis, skinInGameAnalysis, volatilityRegimeAnalysis, blackSwanAnalysis].reduce((acc, a) => acc + (a["score"] as number), 0);
    const maxScore = [tailRiskAnalysis, antifragilityAnalysis, convexityAnalysis, fragilityAnalysis, skinInGameAnalysis, volatilityRegimeAnalysis, blackSwanAnalysis].reduce((acc, a) => acc + (a["max_score"] as number), 0);

    const analysisData = { ticker, score: totalScore, max_score: maxScore, tail_risk_analysis: tailRiskAnalysis, antifragility_analysis: antifragilityAnalysis, convexity_analysis: convexityAnalysis, fragility_analysis: fragilityAnalysis, skin_in_game_analysis: skinInGameAnalysis, volatility_regime_analysis: volatilityRegimeAnalysis, black_swan_analysis: blackSwanAnalysis, market_cap: marketCap };

    progress.updateStatus(agentId, ticker, "Generating Nassim Taleb analysis");
    const facts = { score: totalScore, max_score: maxScore, tail_risk: tailRiskAnalysis["details"], antifragility: antifragilityAnalysis["details"], convexity: convexityAnalysis["details"], fragility: fragilityAnalysis["details"], skin_in_game: skinInGameAnalysis["details"], volatility_regime: volatilityRegimeAnalysis["details"], black_swan: blackSwanAnalysis["details"], market_cap: marketCap };

    const template = ChatPromptTemplate.fromMessages([
      ["system", "You are Nassim Taleb. Decide bullish, bearish, or neutral using only the provided facts.\n\nChecklist:\n- Antifragility (benefits from disorder)\n- Tail risk profile (fat tails, skewness)\n- Convexity (asymmetric payoff potential)\n- Fragility via negativa (avoid the fragile)\n- Skin in the game (insider alignment)\n- Volatility regime (low vol = danger)\n\nUse Taleb's vocabulary: antifragile, convexity, skin in the game, via negativa, barbell, turkey problem. Keep reasoning under 150 chars. Return JSON only."],
      ["human", "Ticker: {ticker}\nFacts:\n{facts}\n\nReturn exactly:\n{{\n  \"signal\": \"bullish\" | \"bearish\" | \"neutral\",\n  \"confidence\": int,\n  \"reasoning\": \"short justification\"\n}}"],
    ]);
    const prompt = await template.invoke({ facts: JSON.stringify(facts, null, 2), ticker });
    const result = await callLlm(prompt, SignalSchema, {
      agentName: agentId, state,
      defaultFactory: () => ({ signal: "neutral" as const, confidence: 50, reasoning: "Insufficient data" }),
    });

    talebAnalysis[ticker] = { signal: result?.signal ?? "neutral", confidence: result?.confidence ?? 50, reasoning: result?.reasoning ?? "" };
    progress.updateStatus(agentId, ticker, "Done", result?.reasoning);
  }

  const message = new HumanMessage({ content: JSON.stringify(talebAnalysis), name: agentId });
  if ((state.metadata as Record<string, unknown>)["show_reasoning"]) showAgentReasoning(talebAnalysis, agentId);

  const existingSignals = (data["analyst_signals"] as Record<string, unknown>) ?? {};
  data["analyst_signals"] = { ...existingSignals, [agentId]: talebAnalysis };
  progress.updateStatus(agentId, null, "Done");
  return { messages: [message], data };
}
