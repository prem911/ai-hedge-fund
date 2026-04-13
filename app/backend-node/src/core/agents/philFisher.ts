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

function analyzeFisherGrowthQuality(lineItems: unknown[]): Record<string, unknown> {
  if (!lineItems.length || lineItems.length < 2) return { score: 0, details: "Insufficient data" };
  const details: string[] = [];
  let rawScore = 0;

  const revenues: number[] = lineItems.map((li: any) => li.revenue).filter((v: any): v is number => v != null);
  if (revenues.length >= 2 && revenues[revenues.length - 1]! > 0 && revenues[0]! > 0) {
    const numYears = revenues.length - 1;
    const cagr = (revenues[0]! / revenues[revenues.length - 1]!) ** (1 / numYears) - 1;
    if (cagr > 0.20) { rawScore += 3; details.push(`Very strong revenue CAGR ${(cagr * 100).toFixed(1)}%`); }
    else if (cagr > 0.10) { rawScore += 2; details.push(`Moderate revenue CAGR ${(cagr * 100).toFixed(1)}%`); }
    else if (cagr > 0.03) { rawScore += 1; details.push(`Slight revenue CAGR ${(cagr * 100).toFixed(1)}%`); }
    else { details.push(`Minimal revenue growth ${(cagr * 100).toFixed(1)}%`); }
  } else { details.push("Insufficient revenue data"); }

  const eps: number[] = lineItems.map((li: any) => li.earnings_per_share).filter((v: any): v is number => v != null);
  if (eps.length >= 2 && eps[eps.length - 1]! > 0 && eps[0]! > 0) {
    const numYears = eps.length - 1;
    const cagr = (eps[0]! / eps[eps.length - 1]!) ** (1 / numYears) - 1;
    if (cagr > 0.20) { rawScore += 3; details.push(`Very strong EPS CAGR ${(cagr * 100).toFixed(1)}%`); }
    else if (cagr > 0.10) { rawScore += 2; details.push(`Moderate EPS CAGR ${(cagr * 100).toFixed(1)}%`); }
    else if (cagr > 0.03) { rawScore += 1; details.push(`Slight EPS CAGR ${(cagr * 100).toFixed(1)}%`); }
    else { details.push(`Minimal EPS growth ${(cagr * 100).toFixed(1)}%`); }
  } else { details.push("Insufficient EPS data"); }

  const rds: number[] = lineItems.map((li: any) => li.research_and_development).filter((v: any): v is number => v != null);
  if (rds.length && revenues.length) {
    const rndRatio = rds[0]! / revenues[0]!;
    if (rndRatio >= 0.03 && rndRatio <= 0.15) { rawScore += 3; details.push(`Healthy R&D ratio ${(rndRatio * 100).toFixed(1)}%`); }
    else if (rndRatio > 0.15) { rawScore += 2; details.push(`High R&D ratio ${(rndRatio * 100).toFixed(1)}%`); }
    else if (rndRatio > 0) { rawScore += 1; details.push(`Low R&D ratio ${(rndRatio * 100).toFixed(1)}%`); }
    else { details.push("No R&D expense"); }
  } else { details.push("Insufficient R&D data"); }

  return { score: Math.min(10, (rawScore / 9) * 10), details: details.join("; ") };
}

function analyzeMarginsStability(lineItems: unknown[]): Record<string, unknown> {
  if (!lineItems.length || lineItems.length < 2) return { score: 0, details: "Insufficient data" };
  const details: string[] = [];
  let rawScore = 0;

  const opMargins: number[] = lineItems.map((li: any) => li.operating_margin).filter((v: any): v is number => v != null);
  if (opMargins.length >= 2) {
    const oldest = opMargins[opMargins.length - 1]!;
    const newest = opMargins[0]!;
    if (newest >= oldest && oldest > 0) { rawScore += 2; details.push(`Op margin stable/improving ${(oldest * 100).toFixed(1)}% → ${(newest * 100).toFixed(1)}%`); }
    else if (newest > 0) { rawScore += 1; details.push(`Op margin positive but declining`); }
    else { details.push("Op margin negative/uncertain"); }
  }

  const grossMargins: number[] = lineItems.map((li: any) => li.gross_margin).filter((v: any): v is number => v != null);
  if (grossMargins.length) {
    const recent = grossMargins[0]!;
    if (recent > 0.5) { rawScore += 2; details.push(`Strong gross margin ${(recent * 100).toFixed(1)}%`); }
    else if (recent > 0.3) { rawScore += 1; details.push(`Decent gross margin ${(recent * 100).toFixed(1)}%`); }
    else { details.push(`Low gross margin ${(recent * 100).toFixed(1)}%`); }
  }

  const nis: number[] = lineItems.map((li: any) => li.net_income).filter((v: any): v is number => v != null);
  if (nis.length >= 2) {
    const allPositive = nis.filter(v => v > 0).length;
    if (allPositive === nis.length) { rawScore += 2; details.push("Consistent positive earnings"); }
    else if (allPositive >= nis.length * 0.8) { rawScore += 1; details.push(`Mostly positive earnings ${allPositive}/${nis.length}`); }
    else { details.push(`Inconsistent earnings ${allPositive}/${nis.length}`); }
  }

  return { score: Math.min(10, (rawScore / 6) * 10), details: details.join("; ") };
}

function analyzeManagementEfficiencyLeverage(lineItems: unknown[]): Record<string, unknown> {
  if (!lineItems.length) return { score: 0, details: "Insufficient data" };
  const details: string[] = [];
  let rawScore = 0;

  const li0: any = lineItems[0];
  const fcfs: number[] = lineItems.map((li: any) => li.free_cash_flow).filter((v: any): v is number => v != null);
  const nis: number[] = lineItems.map((li: any) => li.net_income).filter((v: any): v is number => v != null);
  if (fcfs.length && nis.length) {
    const positiveFcf = fcfs.filter(v => v > 0).length;
    if (positiveFcf >= Math.ceil(fcfs.length * 0.8)) { rawScore += 2; details.push(`Strong FCF ${positiveFcf}/${fcfs.length} positive`); }
    else if (positiveFcf >= Math.ceil(fcfs.length * 0.6)) { rawScore += 1; details.push(`Moderate FCF generation`); }
    else { details.push("Weak/inconsistent FCF"); }
  }

  const debt: number | null = li0.total_debt ?? null;
  const equity: number | null = li0.shareholders_equity ?? null;
  if (debt != null && equity != null && equity > 0) {
    const de = debt / equity;
    if (de < 0.5) { rawScore += 2; details.push(`Low leverage D/E ${de.toFixed(2)}`); }
    else if (de < 1.0) { rawScore += 1; details.push(`Moderate D/E ${de.toFixed(2)}`); }
    else { details.push(`High D/E ${de.toFixed(2)}`); }
  }

  const cash: number | null = li0.cash_and_equivalents ?? null;
  const rev: number | null = li0.revenue ?? null;
  if (cash != null && rev != null && rev > 0) {
    const ratio = cash / rev;
    if (ratio >= 0.10 && ratio <= 0.25) { rawScore += 2; details.push(`Prudent cash/revenue ${ratio.toFixed(2)}`); }
    else if (ratio >= 0.05 && ratio < 0.10) { rawScore += 1; details.push(`Acceptable cash position`); }
    else { details.push(`Cash/revenue ${ratio.toFixed(2)}`); }
  }

  return { score: Math.min(10, (rawScore / 6) * 10), details: details.join("; ") };
}

function analyzeFisherValuation(lineItems: unknown[], marketCap: number | null): Record<string, unknown> {
  if (!lineItems.length || !marketCap) return { score: 0, details: "Insufficient data" };
  const details: string[] = [];
  let rawScore = 0;

  const nis: number[] = lineItems.map((li: any) => li.net_income).filter((v: any): v is number => v != null && v > 0);
  if (nis.length) {
    const pe = marketCap / nis[0]!;
    if (pe < 20) { rawScore += 2; details.push(`Attractive P/E ${pe.toFixed(2)}`); }
    else if (pe < 30) { rawScore += 1; details.push(`Somewhat high P/E ${pe.toFixed(2)}`); }
    else { details.push(`Very high P/E ${pe.toFixed(2)}`); }
  }

  const fcfs: number[] = lineItems.map((li: any) => li.free_cash_flow).filter((v: any): v is number => v != null && v > 0);
  if (fcfs.length) {
    const pfcf = marketCap / fcfs[0]!;
    if (pfcf < 20) { rawScore += 2; details.push(`Reasonable P/FCF ${pfcf.toFixed(2)}`); }
    else if (pfcf < 30) { rawScore += 1; details.push(`Somewhat high P/FCF ${pfcf.toFixed(2)}`); }
    else { details.push(`High P/FCF ${pfcf.toFixed(2)}`); }
  }

  return { score: Math.min(10, (rawScore / 4) * 10), details: details.join("; ") };
}

function analyzeInsiderActivity(trades: unknown[]): Record<string, unknown> {
  if (!trades.length) return { score: 5, details: "No insider trades data" };
  let buys = 0, sells = 0;
  for (const t of trades) {
    const shares = (t as any).transaction_shares ?? 0;
    if (shares > 0) buys++;
    else if (shares < 0) sells++;
  }
  const total = buys + sells;
  if (!total) return { score: 5, details: "No buy/sell transactions" };
  const ratio = buys / total;
  if (ratio > 0.7) return { score: 8, details: `Heavy insider buying ${buys}/${total}` };
  if (ratio > 0.4) return { score: 6, details: `Moderate insider buying ${buys}/${total}` };
  return { score: 4, details: `Mostly insider selling ${buys}/${total}` };
}

function analyzeSentimentFisher(news: unknown[]): Record<string, unknown> {
  if (!news.length) return { score: 5, details: "No news data" };
  const negKeywords = ["lawsuit", "fraud", "negative", "downturn", "decline", "investigation", "recall"];
  let negCount = 0;
  for (const n of news) {
    const title = ((n as any).title ?? "").toLowerCase();
    if (negKeywords.some(k => title.includes(k))) negCount++;
  }
  if (negCount > news.length * 0.3) return { score: 3, details: `High proportion negative ${negCount}/${news.length}` };
  if (negCount > 0) return { score: 6, details: `Some negative ${negCount}/${news.length}` };
  return { score: 8, details: "Mostly positive/neutral headlines" };
}

export async function philFisherAgent(
  state: AgentState,
  agentId = "phil_fisher_agent"
): Promise<Partial<AgentState>> {
  const data = state.data as Record<string, unknown>;
  const endDate = data["end_date"] as string;
  const tickers = data["tickers"] as string[];
  const apiKey = getApiKeyFromState(state, "FINANCIAL_DATASETS_API_KEY");

  const fisherAnalysis: Record<string, unknown> = {};

  for (const ticker of tickers) {
    progress.updateStatus(agentId, ticker, "Gathering financial line items");
    const lineItems = await searchLineItems(ticker,
      ["revenue", "net_income", "earnings_per_share", "free_cash_flow", "research_and_development",
       "operating_income", "operating_margin", "gross_margin", "total_debt", "shareholders_equity",
       "cash_and_equivalents", "ebit", "ebitda"],
      endDate, "annual", 5, apiKey);

    progress.updateStatus(agentId, ticker, "Getting market cap");
    const marketCap = await getMarketCap(ticker, endDate, apiKey);

    progress.updateStatus(agentId, ticker, "Fetching insider trades");
    const insiderTrades = await getInsiderTrades(ticker, endDate, undefined, 50, apiKey);

    progress.updateStatus(agentId, ticker, "Fetching company news");
    const companyNews = await getCompanyNews(ticker, endDate, undefined, 50, apiKey);

    const growthQuality = analyzeFisherGrowthQuality(lineItems);
    const marginsStability = analyzeMarginsStability(lineItems);
    const mgmtEfficiency = analyzeManagementEfficiencyLeverage(lineItems);
    const fisherValuation = analyzeFisherValuation(lineItems, marketCap);
    const insiderActivity = analyzeInsiderActivity(insiderTrades);
    const sentimentAnalysis = analyzeSentimentFisher(companyNews);

    const totalScore = (growthQuality["score"] as number) * 0.30 + (marginsStability["score"] as number) * 0.25 + (mgmtEfficiency["score"] as number) * 0.20 + (fisherValuation["score"] as number) * 0.15 + (insiderActivity["score"] as number) * 0.05 + (sentimentAnalysis["score"] as number) * 0.05;
    const signal = totalScore >= 7.5 ? "bullish" : totalScore <= 4.5 ? "bearish" : "neutral";

    const analysisData = { signal, score: totalScore, max_score: 10, growth_quality: growthQuality, margins_stability: marginsStability, management_efficiency: mgmtEfficiency, valuation_analysis: fisherValuation, insider_activity: insiderActivity, sentiment_analysis: sentimentAnalysis };

    progress.updateStatus(agentId, ticker, "Generating Phil Fisher-style analysis");
    const template = ChatPromptTemplate.fromMessages([
      ["system", `You are Phil Fisher. Principles: long-term growth, quality management, R&D investment, strong consistent margins, scuttlebutt research, willing to pay for quality. Be methodical and growth-focused. Return JSON only.`],
      ["human", `Analysis Data for {ticker}:\n{analysis_data}\n\nReturn JSON:\n{{\n  "signal": "bullish/bearish/neutral",\n  "confidence": float (0-100),\n  "reasoning": "string"\n}}`],
    ]);
    const prompt = await template.invoke({ analysis_data: JSON.stringify(analysisData, null, 2), ticker });
    const result = await callLlm(prompt, SignalSchema, {
      agentName: agentId, state,
      defaultFactory: () => ({ signal: "neutral" as const, confidence: 0, reasoning: "Error in analysis" }),
    });

    fisherAnalysis[ticker] = { signal: result?.signal ?? "neutral", confidence: result?.confidence ?? 0, reasoning: result?.reasoning ?? "" };
    progress.updateStatus(agentId, ticker, "Done", result?.reasoning);
  }

  const message = new HumanMessage({ content: JSON.stringify(fisherAnalysis), name: agentId });
  if ((state.metadata as Record<string, unknown>)["show_reasoning"]) showAgentReasoning(fisherAnalysis, "Phil Fisher Agent");

  const existingSignals = (data["analyst_signals"] as Record<string, unknown>) ?? {};
  data["analyst_signals"] = { ...existingSignals, [agentId]: fisherAnalysis };
  progress.updateStatus(agentId, null, "Done");
  return { messages: [message], data };
}
