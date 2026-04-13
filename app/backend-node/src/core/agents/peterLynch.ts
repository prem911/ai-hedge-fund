import { HumanMessage } from "@langchain/core/messages";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import type { AgentState } from "../graph/state.js";
import { showAgentReasoning } from "../graph/state.js";
import { getApiKeyFromState } from "../utils/apiKey.js";
import { progress } from "../utils/progress.js";
import { callLlm } from "../utils/llm.js";
import { getMarketCap, searchLineItems, getInsiderTrades, getCompanyNews } from "../tools/api.js";
import { z } from "zod";

const SignalSchema = z.object({
  signal: z.enum(["bullish", "bearish", "neutral"]),
  confidence: z.number().min(0).max(100),
  reasoning: z.string(),
});

function analyzeLynchGrowth(lineItems: unknown[]): Record<string, unknown> {
  if (!lineItems.length || lineItems.length < 2) return { score: 0, details: "Insufficient data" };
  const details: string[] = [];
  let rawScore = 0;

  const revenues: number[] = lineItems.map((li: any) => li.revenue).filter((v: any): v is number => v != null);
  if (revenues.length >= 2) {
    const growth = (revenues[0]! - revenues[revenues.length - 1]!) / Math.abs(revenues[revenues.length - 1]!);
    if (growth > 0.25) { rawScore += 3; details.push(`Strong revenue growth ${(growth * 100).toFixed(1)}%`); }
    else if (growth > 0.10) { rawScore += 2; details.push(`Moderate revenue growth ${(growth * 100).toFixed(1)}%`); }
    else if (growth > 0.02) { rawScore += 1; details.push(`Slight revenue growth ${(growth * 100).toFixed(1)}%`); }
    else { details.push(`Flat/negative revenue ${(growth * 100).toFixed(1)}%`); }
  }

  const eps: number[] = lineItems.map((li: any) => li.earnings_per_share).filter((v: any): v is number => v != null);
  if (eps.length >= 2) {
    const older = eps[eps.length - 1]!;
    const latest = eps[0]!;
    if (Math.abs(older) > 1e-9) {
      const growth = (latest - older) / Math.abs(older);
      if (growth > 0.25) { rawScore += 3; details.push(`Strong EPS growth ${(growth * 100).toFixed(1)}%`); }
      else if (growth > 0.10) { rawScore += 2; details.push(`Moderate EPS growth ${(growth * 100).toFixed(1)}%`); }
      else if (growth > 0.02) { rawScore += 1; details.push(`Slight EPS growth ${(growth * 100).toFixed(1)}%`); }
      else { details.push(`Minimal EPS growth ${(growth * 100).toFixed(1)}%`); }
    }
  }

  return { score: Math.min(10, (rawScore / 6) * 10), details: details.join("; ") };
}

function analyzeLynchFundamentals(lineItems: unknown[]): Record<string, unknown> {
  if (!lineItems.length) return { score: 0, details: "Insufficient data" };
  const details: string[] = [];
  let rawScore = 0;

  const li0: any = lineItems[0];
  const debt = li0.total_debt ?? null;
  const equity = li0.shareholders_equity ?? null;
  if (debt != null && equity != null && equity > 0) {
    const de = debt / equity;
    if (de < 0.5) { rawScore += 2; details.push(`Low D/E ${de.toFixed(2)}`); }
    else if (de < 1.0) { rawScore += 1; details.push(`Moderate D/E ${de.toFixed(2)}`); }
    else { details.push(`High D/E ${de.toFixed(2)}`); }
  }

  const om = li0.operating_margin ?? null;
  if (om != null) {
    if (om > 0.20) { rawScore += 2; details.push(`Strong op margin ${(om * 100).toFixed(1)}%`); }
    else if (om > 0.10) { rawScore += 1; details.push(`Moderate op margin ${(om * 100).toFixed(1)}%`); }
    else { details.push(`Low op margin ${(om * 100).toFixed(1)}%`); }
  }

  const fcf = li0.free_cash_flow ?? null;
  if (fcf != null) {
    if (fcf > 0) { rawScore += 2; details.push(`Positive FCF ${fcf.toLocaleString()}`); }
    else { details.push(`Negative FCF ${fcf.toLocaleString()}`); }
  }

  return { score: Math.min(10, (rawScore / 6) * 10), details: details.join("; ") };
}

function analyzeLynchValuation(lineItems: unknown[], marketCap: number | null): Record<string, unknown> {
  if (!lineItems.length || !marketCap) return { score: 0, details: "Insufficient data" };
  const details: string[] = [];
  let rawScore = 0;

  const netIncomes: number[] = lineItems.map((li: any) => li.net_income).filter((v: any): v is number => v != null);
  let peRatio: number | null = null;
  if (netIncomes.length && netIncomes[0]! > 0) {
    peRatio = marketCap / netIncomes[0]!;
    details.push(`P/E: ${peRatio.toFixed(2)}`);
    if (peRatio < 15) rawScore += 2;
    else if (peRatio < 25) rawScore += 1;
  }

  const eps: number[] = lineItems.map((li: any) => li.earnings_per_share).filter((v: any): v is number => v != null);
  let epsGrowthRate: number | null = null;
  if (eps.length >= 2 && eps[eps.length - 1]! > 0) {
    const numYears = eps.length - 1;
    if (eps[0]! > 0) {
      epsGrowthRate = (eps[0]! / eps[eps.length - 1]!) ** (1 / numYears) - 1;
      details.push(`EPS CAGR: ${(epsGrowthRate * 100).toFixed(1)}%`);
    }
  }

  let pegRatio: number | null = null;
  if (peRatio && epsGrowthRate && epsGrowthRate > 0) {
    pegRatio = peRatio / (epsGrowthRate * 100);
    details.push(`PEG: ${pegRatio.toFixed(2)}`);
    if (pegRatio < 1) rawScore += 3;
    else if (pegRatio < 2) rawScore += 2;
    else if (pegRatio < 3) rawScore += 1;
  }

  return { score: Math.min(10, (rawScore / 5) * 10), details: details.join("; ") };
}

function analyzeSentiment(news: unknown[]): Record<string, unknown> {
  if (!news.length) return { score: 5, details: "No news data" };
  const negKeywords = ["lawsuit", "fraud", "negative", "downturn", "decline", "investigation", "recall"];
  let negCount = 0;
  for (const n of news) {
    const title = ((n as any).title ?? "").toLowerCase();
    if (negKeywords.some(k => title.includes(k))) negCount++;
  }
  if (negCount > news.length * 0.3) return { score: 3, details: `High negative headlines ${negCount}/${news.length}` };
  if (negCount > 0) return { score: 6, details: `Some negative headlines ${negCount}/${news.length}` };
  return { score: 8, details: "Mostly positive/neutral headlines" };
}

function analyzeInsiderActivity(trades: unknown[]): Record<string, unknown> {
  if (!trades.length) return { score: 5, details: "No insider data" };
  let buys = 0, sells = 0;
  for (const t of trades) {
    const shares = (t as any).transaction_shares ?? 0;
    if (shares > 0) buys++;
    else if (shares < 0) sells++;
  }
  const total = buys + sells;
  if (!total) return { score: 5, details: "No transactions" };
  const ratio = buys / total;
  if (ratio > 0.7) return { score: 8, details: `Heavy insider buying ${buys}/${total}` };
  if (ratio > 0.4) return { score: 6, details: `Moderate insider buying ${buys}/${total}` };
  return { score: 4, details: `Mostly selling ${buys}/${total}` };
}

export async function peterLynchAgent(
  state: AgentState,
  agentId = "peter_lynch_agent"
): Promise<Partial<AgentState>> {
  const data = state.data as Record<string, unknown>;
  const endDate = data["end_date"] as string;
  const tickers = data["tickers"] as string[];
  const apiKey = getApiKeyFromState(state, "FINANCIAL_DATASETS_API_KEY");

  const lynchAnalysis: Record<string, unknown> = {};

  for (const ticker of tickers) {
    progress.updateStatus(agentId, ticker, "Gathering financial line items");
    const lineItems = await searchLineItems(ticker,
      ["revenue", "earnings_per_share", "net_income", "operating_income", "gross_margin",
       "operating_margin", "free_cash_flow", "capital_expenditure", "cash_and_equivalents",
       "total_debt", "shareholders_equity", "outstanding_shares"],
      endDate, "annual", 5, apiKey);

    progress.updateStatus(agentId, ticker, "Getting market cap");
    const marketCap = await getMarketCap(ticker, endDate, apiKey);

    progress.updateStatus(agentId, ticker, "Fetching insider trades");
    const insiderTrades = await getInsiderTrades(ticker, endDate, undefined, 50, apiKey);

    progress.updateStatus(agentId, ticker, "Fetching company news");
    const companyNews = await getCompanyNews(ticker, endDate, undefined, 50, apiKey);

    const growthAnalysis = analyzeLynchGrowth(lineItems);
    const fundamentalsAnalysis = analyzeLynchFundamentals(lineItems);
    const valuationAnalysis = analyzeLynchValuation(lineItems, marketCap);
    const sentimentAnalysis = analyzeSentiment(companyNews);
    const insiderActivity = analyzeInsiderActivity(insiderTrades);

    const totalScore = (growthAnalysis["score"] as number) * 0.30 + (valuationAnalysis["score"] as number) * 0.25 + (fundamentalsAnalysis["score"] as number) * 0.20 + (sentimentAnalysis["score"] as number) * 0.15 + (insiderActivity["score"] as number) * 0.10;
    const signal = totalScore >= 7.5 ? "bullish" : totalScore <= 4.5 ? "bearish" : "neutral";

    const analysisData = { signal, score: totalScore, max_score: 10, growth_analysis: growthAnalysis, valuation_analysis: valuationAnalysis, fundamentals_analysis: fundamentalsAnalysis, sentiment_analysis: sentimentAnalysis, insider_activity: insiderActivity };

    progress.updateStatus(agentId, ticker, "Generating Peter Lynch analysis");
    const template = ChatPromptTemplate.fromMessages([
      ["system", `You are a Peter Lynch AI agent. Principles: GARP (PEG ratio), invest in what you know, ten-baggers, steady growth, avoid high debt. Use folksy practical language. Cite PEG ratio. Return JSON only.`],
      ["human", `Analysis Data for {ticker}:\n{analysis_data}\n\nReturn JSON:\n{{\n  "signal": "bullish" | "bearish" | "neutral",\n  "confidence": float (0-100),\n  "reasoning": "string"\n}}`],
    ]);
    const prompt = await template.invoke({ analysis_data: JSON.stringify(analysisData, null, 2), ticker });
    const result = await callLlm(prompt, SignalSchema, {
      agentName: agentId, state,
      defaultFactory: () => ({ signal: "neutral" as const, confidence: 0, reasoning: "Error in analysis" }),
    });

    lynchAnalysis[ticker] = { signal: result?.signal ?? "neutral", confidence: result?.confidence ?? 0, reasoning: result?.reasoning ?? "" };
    progress.updateStatus(agentId, ticker, "Done", result?.reasoning);
  }

  const message = new HumanMessage({ content: JSON.stringify(lynchAnalysis), name: agentId });
  if ((state.metadata as Record<string, unknown>)["show_reasoning"]) showAgentReasoning(lynchAnalysis, "Peter Lynch Agent");

  const existingSignals = (data["analyst_signals"] as Record<string, unknown>) ?? {};
  data["analyst_signals"] = { ...existingSignals, [agentId]: lynchAnalysis };
  progress.updateStatus(agentId, null, "Done");
  return { messages: [message], data };
}
