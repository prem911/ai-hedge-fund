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
  confidence: z.number().int().min(0).max(100),
  reasoning: z.string(),
});

function analyzeMoatStrength(metrics: unknown[], lineItems: unknown[]): Record<string, unknown> {
  let score = 0;
  const details: string[] = [];

  const roics: number[] = lineItems.map((li: any) => li.return_on_invested_capital).filter((v: any): v is number => v != null);
  if (roics.length) {
    const high = roics.filter(r => r > 0.15).length;
    const ratio = high / roics.length;
    if (ratio >= 0.8) { score += 3; details.push(`Excellent ROIC ${high}/${roics.length} >15%`); }
    else if (ratio >= 0.5) { score += 2; details.push(`Good ROIC ${high}/${roics.length} >15%`); }
    else if (high > 0) { score += 1; details.push(`Mixed ROIC ${high}/${roics.length}`); }
    else { details.push("Poor ROIC never >15%"); }
  } else { details.push("No ROIC data"); }

  const grossMargins: number[] = lineItems.map((li: any) => li.gross_margin).filter((v: any): v is number => v != null);
  if (grossMargins.length >= 3) {
    const avg = grossMargins.reduce((a, b) => a + b, 0) / grossMargins.length;
    if (avg > 0.30) { score += 2; details.push(`Good margins avg ${(avg * 100).toFixed(1)}%`); }
    else { details.push(`Low margins avg ${(avg * 100).toFixed(1)}%`); }
  }

  const capexRatios: number[] = lineItems.map((li: any) => {
    const capex = li.capital_expenditure;
    const rev = li.revenue;
    return capex != null && rev && rev > 0 ? Math.abs(capex) / rev : null;
  }).filter((v): v is number => v != null);
  if (capexRatios.length) {
    const avg = capexRatios.reduce((a, b) => a + b, 0) / capexRatios.length;
    if (avg < 0.05) { score += 2; details.push(`Low capex ${(avg * 100).toFixed(1)}%`); }
    else if (avg < 0.10) { score += 1; details.push(`Moderate capex ${(avg * 100).toFixed(1)}%`); }
    else { details.push(`High capex ${(avg * 100).toFixed(1)}%`); }
  }

  const rds: number[] = lineItems.map((li: any) => li.research_and_development).filter((v: any): v is number => v != null);
  if (rds.length && rds.reduce((a, b) => a + b, 0) > 0) { score += 1; details.push("Invests in R&D"); }

  const gwia: number[] = lineItems.map((li: any) => li.goodwill_and_intangible_assets).filter((v: any): v is number => v != null);
  if (gwia.length) { score += 1; details.push("Significant goodwill/intangibles"); }

  return { score: Math.min(10, score * 10 / 9), details: details.join("; ") };
}

function analyzeManagementQuality(lineItems: unknown[], insiderTrades: unknown[]): Record<string, unknown> {
  let score = 0;
  const details: string[] = [];

  const fcfs: number[] = lineItems.map((li: any) => li.free_cash_flow).filter((v: any): v is number => v != null);
  const nis: number[] = lineItems.map((li: any) => li.net_income).filter((v: any): v is number => v != null);
  if (fcfs.length && nis.length && fcfs.length === nis.length) {
    const ratios: number[] = [];
    for (let i = 0; i < fcfs.length; i++) if (nis[i]! > 0) ratios.push(fcfs[i]! / nis[i]!);
    if (ratios.length) {
      const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      if (avg > 1.1) { score += 3; details.push(`Excellent FCF/NI ${avg.toFixed(2)}`); }
      else if (avg > 0.9) { score += 2; details.push(`Good FCF/NI ${avg.toFixed(2)}`); }
      else if (avg > 0.7) { score += 1; details.push(`Moderate FCF/NI ${avg.toFixed(2)}`); }
      else { details.push(`Poor FCF/NI ${avg.toFixed(2)}`); }
    }
  }

  const li0: any = lineItems[0];
  const debt: number = li0?.total_debt ?? 0;
  const equity: number = li0?.shareholders_equity ?? 1;
  if (equity > 0) {
    const de = debt / equity;
    if (de < 0.3) { score += 3; details.push(`Conservative D/E ${de.toFixed(2)}`); }
    else if (de < 0.7) { score += 2; details.push(`Moderate D/E ${de.toFixed(2)}`); }
    else if (de < 1.5) { score += 1; details.push(`High D/E ${de.toFixed(2)}`); }
    else { details.push(`Very high D/E ${de.toFixed(2)}`); }
  }

  // Insider activity
  if (insiderTrades.length) {
    let buys = 0, sells = 0;
    for (const t of insiderTrades) {
      const tt = ((t as any).transaction_type ?? "").toLowerCase();
      if (tt === "buy" || tt === "purchase") buys++;
      else if (tt === "sell" || tt === "sale") sells++;
    }
    const total = buys + sells;
    if (total > 0) {
      const ratio = buys / total;
      if (ratio > 0.7) { score += 2; details.push(`Strong insider buying ${buys}/${total}`); }
      else if (ratio > 0.4) { score += 1; details.push(`Balanced insider ${buys}/${total}`); }
      else if (ratio < 0.1 && sells > 5) { score -= 1; details.push("Concerning insider selling"); }
    }
  }

  // Share count
  const shares: number[] = lineItems.map((li: any) => li.outstanding_shares).filter((v: any): v is number => v != null);
  if (shares.length >= 3) {
    if (shares[0]! < shares[shares.length - 1]! * 0.95) { score += 2; details.push("Share count decreasing"); }
    else if (shares[0]! < shares[shares.length - 1]! * 1.05) { score += 1; details.push("Share count stable"); }
    else if (shares[0]! > shares[shares.length - 1]! * 1.2) { score -= 1; details.push("Significant dilution"); }
  }

  return { score: Math.max(0, Math.min(10, score * 10 / 12)), details: details.join("; ") };
}

function analyzePredictability(lineItems: unknown[]): Record<string, unknown> {
  if (lineItems.length < 5) return { score: 0, details: "Insufficient data (need 5+ years)" };
  let score = 0;
  const details: string[] = [];

  const revenues: number[] = lineItems.map((li: any) => li.revenue).filter((v: any): v is number => v != null);
  if (revenues.length >= 5) {
    const growthRates: number[] = [];
    for (let i = 0; i < revenues.length - 1; i++) {
      if (revenues[i + 1]! !== 0) growthRates.push(revenues[i]! / revenues[i + 1]! - 1);
    }
    if (growthRates.length) {
      const avg = growthRates.reduce((a, b) => a + b, 0) / growthRates.length;
      const vol = growthRates.reduce((acc, r) => acc + Math.abs(r - avg), 0) / growthRates.length;
      const positive = growthRates.filter(r => r > 0).length;
      if (positive >= growthRates.length * 0.8) { score += 3; details.push(`Consistent revenue growth ${positive}/${growthRates.length} positive`); }
      else if (positive >= growthRates.length * 0.6) { score += 2; details.push(`Mostly positive revenue`); }
      else { details.push(`Inconsistent revenue ${positive}/${growthRates.length}`); }
      if (vol < 0.05) { score += 2; details.push(`Low revenue volatility ${(vol * 100).toFixed(1)}%`); }
      else if (vol < 0.15) { score += 1; details.push(`Moderate revenue volatility`); }
    }
  }

  const nis: number[] = lineItems.map((li: any) => li.net_income).filter((v: any): v is number => v != null);
  if (nis.length >= 5) {
    const allPositive = nis.filter(n => n > 0).length;
    if (allPositive === nis.length) { score += 2; details.push("Consistent positive earnings"); }
    else if (allPositive >= nis.length * 0.8) { score += 1; details.push(`Mostly positive earnings ${allPositive}/${nis.length}`); }
    else { details.push(`Earnings inconsistent ${allPositive}/${nis.length}`); }
  }

  return { score: Math.min(10, score * 10 / 7), details: details.join("; ") };
}

function calculateMungerValuation(lineItems: unknown[], marketCap: number | null): Record<string, unknown> {
  if (!lineItems.length || !marketCap) return { score: 0, details: "Insufficient data" };
  const details: string[] = [];
  let score = 0;

  const fcfs: number[] = lineItems.map((li: any) => li.free_cash_flow).filter((v: any): v is number => v != null && v > 0);
  if (fcfs.length) {
    const normalizedFcf = fcfs.slice(0, Math.min(5, fcfs.length)).reduce((a, b) => a + b, 0) / Math.min(5, fcfs.length);
    const fcfYield = normalizedFcf / marketCap;
    if (fcfYield > 0.07) { score += 3; details.push(`Attractive FCF yield ${(fcfYield * 100).toFixed(1)}%`); }
    else if (fcfYield > 0.05) { score += 2; details.push(`Fair FCF yield ${(fcfYield * 100).toFixed(1)}%`); }
    else if (fcfYield > 0.03) { score += 1; details.push(`Low FCF yield ${(fcfYield * 100).toFixed(1)}%`); }
    else { details.push(`Very low FCF yield ${(fcfYield * 100).toFixed(1)}%`); }
  }

  return { score: Math.min(10, score * 10 / 3), details: details.join("; ") };
}

function analyzeNewsSentiment(news: unknown[]): string {
  if (!news.length) return "No news available";
  const neg = news.filter((n: any) => n.sentiment && ["negative", "bearish"].includes(n.sentiment.toLowerCase())).length;
  const pos = news.filter((n: any) => n.sentiment && ["positive", "bullish"].includes(n.sentiment.toLowerCase())).length;
  if (neg > pos) return `${neg} negative vs ${pos} positive articles`;
  if (pos > neg) return `${pos} positive vs ${neg} negative articles`;
  return "Mixed news sentiment";
}

function computeConfidence(analysisData: Record<string, unknown>, signal: string): number {
  const score = analysisData["score"] as number;
  const maxScore = analysisData["max_score"] as number ?? 10;
  const normalizedScore = score / maxScore;
  if (signal === "bullish") return Math.round(60 + normalizedScore * 35);
  if (signal === "bearish") return Math.round(60 + (1 - normalizedScore) * 35);
  return Math.round(40 + Math.abs(normalizedScore - 0.5) * 40);
}

export async function charlieMungerAgent(
  state: AgentState,
  agentId = "charlie_munger_agent"
): Promise<Partial<AgentState>> {
  const data = state.data as Record<string, unknown>;
  const endDate = data["end_date"] as string;
  const tickers = data["tickers"] as string[];
  const apiKey = getApiKeyFromState(state, "FINANCIAL_DATASETS_API_KEY");

  const mungerAnalysis: Record<string, unknown> = {};

  for (const ticker of tickers) {
    progress.updateStatus(agentId, ticker, "Fetching financial metrics");
    const metrics = await getFinancialMetrics(ticker, endDate, "annual", 10, apiKey);

    progress.updateStatus(agentId, ticker, "Gathering financial line items");
    const lineItems = await searchLineItems(ticker,
      ["revenue", "net_income", "operating_income", "return_on_invested_capital", "gross_margin",
       "operating_margin", "free_cash_flow", "capital_expenditure", "cash_and_equivalents",
       "total_debt", "shareholders_equity", "outstanding_shares",
       "research_and_development", "goodwill_and_intangible_assets"],
      endDate, "annual", 10, apiKey);

    progress.updateStatus(agentId, ticker, "Getting market cap");
    const marketCap = await getMarketCap(ticker, endDate, apiKey);

    progress.updateStatus(agentId, ticker, "Fetching insider trades");
    const insiderTrades = await getInsiderTrades(ticker, endDate, undefined, 100, apiKey);

    progress.updateStatus(agentId, ticker, "Fetching company news");
    const companyNews = await getCompanyNews(ticker, endDate, undefined, 10, apiKey);

    const moatAnalysis = analyzeMoatStrength(metrics, lineItems);
    const managementAnalysis = analyzeManagementQuality(lineItems, insiderTrades);
    const predictabilityAnalysis = analyzePredictability(lineItems);
    const valuationAnalysis = calculateMungerValuation(lineItems, marketCap);

    const totalScore = (moatAnalysis["score"] as number) * 0.35 + (managementAnalysis["score"] as number) * 0.25 + (predictabilityAnalysis["score"] as number) * 0.25 + (valuationAnalysis["score"] as number) * 0.15;
    const signal = totalScore >= 7.5 ? "bullish" : totalScore <= 5.5 ? "bearish" : "neutral";

    const analysisData = { signal, score: totalScore, max_score: 10, moat_analysis: moatAnalysis, management_analysis: managementAnalysis, predictability_analysis: predictabilityAnalysis, valuation_analysis: valuationAnalysis, news_sentiment: analyzeNewsSentiment(companyNews) };

    progress.updateStatus(agentId, ticker, "Generating Charlie Munger analysis");
    const template = ChatPromptTemplate.fromMessages([
      ["system", `You are Charlie Munger. Use mental models and latticework of knowledge. Focus on: moat strength (ROIC), management quality, business predictability, fair valuation. Be direct and skeptical. Look for wonderful companies at fair prices. Return JSON only.`],
      ["human", `Analyze {ticker}:\n{analysis_data}\n\nReturn EXACTLY:\n{{\n  "signal": "bullish" | "bearish" | "neutral",\n  "confidence": int (0-100),\n  "reasoning": "string"\n}}`],
    ]);
    const prompt = await template.invoke({ analysis_data: JSON.stringify(analysisData, null, 2), ticker });
    const result = await callLlm(prompt, SignalSchema, {
      agentName: agentId, state,
      defaultFactory: () => ({ signal: "neutral" as const, confidence: computeConfidence(analysisData, signal), reasoning: "Insufficient data" }),
    });

    mungerAnalysis[ticker] = { signal: result?.signal ?? "neutral", confidence: result?.confidence ?? 50, reasoning: result?.reasoning ?? "" };
    progress.updateStatus(agentId, ticker, "Done", result?.reasoning);
  }

  const message = new HumanMessage({ content: JSON.stringify(mungerAnalysis), name: agentId });
  if ((state.metadata as Record<string, unknown>)["show_reasoning"]) showAgentReasoning(mungerAnalysis, "Charlie Munger Agent");

  const existingSignals = (data["analyst_signals"] as Record<string, unknown>) ?? {};
  data["analyst_signals"] = { ...existingSignals, [agentId]: mungerAnalysis };
  progress.updateStatus(agentId, null, "Done");
  return { messages: [message], data };
}
