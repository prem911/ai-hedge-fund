import { HumanMessage } from "@langchain/core/messages";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import type { AgentState } from "../graph/state.js";
import { showAgentReasoning } from "../graph/state.js";
import { getApiKeyFromState } from "../utils/apiKey.js";
import { progress } from "../utils/progress.js";
import { callLlm } from "../utils/llm.js";
import { getFinancialMetrics, getMarketCap, searchLineItems } from "../tools/api.js";
import { z } from "zod";

const SignalSchema = z.object({
  signal: z.enum(["bullish", "bearish", "neutral"]),
  confidence: z.number().min(0).max(100),
  reasoning: z.string(),
});

function analyzeDownsideProtection(lineItems: unknown[]): Record<string, unknown> {
  if (!lineItems.length) return { score: 0, details: "Insufficient data" };
  const latest: any = lineItems[0];
  const details: string[] = [];
  let score = 0;

  const cash: number | null = latest.cash_and_equivalents ?? null;
  const debt: number | null = latest.total_debt ?? null;
  if (cash != null && debt != null) {
    const netCash = cash - debt;
    if (netCash > 0) { score += 3; details.push(`Net cash position: $${netCash.toLocaleString()}`); }
    else { details.push(`Net debt: $${netCash.toLocaleString()}`); }
  }

  const ca: number | null = latest.current_assets ?? null;
  const cl: number | null = latest.current_liabilities ?? null;
  if (ca != null && cl != null && cl > 0) {
    const cr = ca / cl;
    if (cr >= 2.0) { score += 2; details.push(`Strong liquidity (CR ${cr.toFixed(2)})`); }
    else if (cr >= 1.2) { score += 1; details.push(`Adequate liquidity (CR ${cr.toFixed(2)})`); }
    else { details.push(`Weak liquidity (CR ${cr.toFixed(2)})`); }
  }

  const equity: number | null = latest.shareholders_equity ?? null;
  if (equity != null && equity > 0 && debt != null) {
    const de = debt / equity;
    if (de < 0.3) { score += 2; details.push(`Very low leverage (D/E ${de.toFixed(2)})`); }
    else if (de < 0.7) { score += 1; details.push(`Moderate leverage (D/E ${de.toFixed(2)})`); }
    else { details.push(`High leverage (D/E ${de.toFixed(2)})`); }
  }

  const fcfs: number[] = lineItems.map((li: any) => li.free_cash_flow).filter((v: any): v is number => v != null);
  if (fcfs.length >= 3) {
    const recentAvg = fcfs.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
    const olderRef = fcfs.length >= 6 ? fcfs.slice(-3).reduce((a, b) => a + b, 0) / 3 : fcfs[fcfs.length - 1]!;
    if (recentAvg > 0 && recentAvg >= olderRef) { score += 2; details.push("Positive and improving FCF"); }
    else if (recentAvg > 0) { score += 1; details.push("Positive but declining FCF"); }
    else { details.push("Negative FCF"); }
  }

  return { score: Math.min(10, score), details: details.join("; ") };
}

function analyzePabraiValuation(lineItems: unknown[], marketCap: number | null): Record<string, unknown> {
  if (!lineItems.length || !marketCap || marketCap <= 0) return { score: 0, details: "Insufficient data", fcf_yield: null };

  const fcfs: number[] = lineItems.map((li: any) => li.free_cash_flow).filter((v: any): v is number => v != null);
  if (fcfs.length < 3) return { score: 0, details: "Insufficient FCF history", fcf_yield: null };

  const n = Math.min(5, fcfs.length);
  const normalizedFcf = fcfs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  if (normalizedFcf <= 0) return { score: 0, details: "Non-positive normalized FCF", fcf_yield: null };

  const fcfYield = normalizedFcf / marketCap;
  let score = 0;
  const details: string[] = [];
  if (fcfYield > 0.10) { score += 4; details.push(`Exceptional FCF yield ${(fcfYield * 100).toFixed(1)}%`); }
  else if (fcfYield > 0.07) { score += 3; details.push(`Attractive FCF yield ${(fcfYield * 100).toFixed(1)}%`); }
  else if (fcfYield > 0.05) { score += 2; details.push(`Reasonable FCF yield ${(fcfYield * 100).toFixed(1)}%`); }
  else if (fcfYield > 0.03) { score += 1; details.push(`Borderline FCF yield ${(fcfYield * 100).toFixed(1)}%`); }
  else { details.push(`Expensive: FCF yield ${(fcfYield * 100).toFixed(1)}%`); }

  const capexRatios: number[] = lineItems.map((li: any) => {
    const capex = Math.abs((li as any).capital_expenditure ?? 0);
    const rev = (li as any).revenue;
    return rev && rev > 0 ? capex / rev : null;
  }).filter((v): v is number => v != null);

  if (capexRatios.length) {
    const avg = capexRatios.reduce((a, b) => a + b, 0) / capexRatios.length;
    if (avg < 0.05) { score += 2; details.push(`Asset-light (capex ${(avg * 100).toFixed(1)}% of revenue)`); }
    else if (avg < 0.10) { score += 1; details.push(`Moderate capex ${(avg * 100).toFixed(1)}%`); }
    else { details.push(`Capex heavy ${(avg * 100).toFixed(1)}%`); }
  }

  return { score: Math.min(10, score), details: details.join("; "), fcf_yield: fcfYield };
}

function analyzeDoublePotential(lineItems: unknown[], marketCap: number | null): Record<string, unknown> {
  if (!lineItems.length || !marketCap || marketCap <= 0) return { score: 0, details: "Insufficient data" };

  const details: string[] = [];
  let score = 0;

  const revenues: number[] = lineItems.map((li: any) => li.revenue).filter((v: any): v is number => v != null);
  if (revenues.length >= 3) {
    const recent = revenues.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
    const older = revenues.length >= 6 ? revenues.slice(-3).reduce((a, b) => a + b, 0) / 3 : revenues[revenues.length - 1]!;
    if (older > 0) {
      const growth = recent / older - 1;
      if (growth > 0.15) { score += 2; details.push(`Strong revenue trajectory ${(growth * 100).toFixed(1)}%`); }
      else if (growth > 0.05) { score += 1; details.push(`Modest revenue growth ${(growth * 100).toFixed(1)}%`); }
    }
  }

  const fcfs: number[] = lineItems.map((li: any) => li.free_cash_flow).filter((v: any): v is number => v != null);
  if (fcfs.length >= 3) {
    const recent = fcfs.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
    const older = fcfs.length >= 6 ? fcfs.slice(-3).reduce((a, b) => a + b, 0) / 3 : fcfs[fcfs.length - 1]!;
    if (older !== 0) {
      const growth = recent / older - 1;
      if (growth > 0.20) { score += 3; details.push(`Strong FCF growth ${(growth * 100).toFixed(1)}%`); }
      else if (growth > 0.08) { score += 2; details.push(`Healthy FCF growth ${(growth * 100).toFixed(1)}%`); }
      else if (growth > 0) { score += 1; details.push(`Positive FCF growth ${(growth * 100).toFixed(1)}%`); }
    }
  }

  const valTmp = analyzePabraiValuation(lineItems, marketCap);
  const fcfYield = valTmp["fcf_yield"] as number | null;
  if (fcfYield != null) {
    if (fcfYield > 0.08) { score += 3; details.push("High FCF yield can drive doubling"); }
    else if (fcfYield > 0.05) { score += 1; details.push("Reasonable FCF yield supports compounding"); }
  }

  return { score: Math.min(10, score), details: details.join("; ") };
}

export async function mohnishPabraiAgent(
  state: AgentState,
  agentId = "mohnish_pabrai_agent"
): Promise<Partial<AgentState>> {
  const data = state.data as Record<string, unknown>;
  const endDate = data["end_date"] as string;
  const tickers = data["tickers"] as string[];
  const apiKey = getApiKeyFromState(state, "FINANCIAL_DATASETS_API_KEY");

  const pabraiAnalysis: Record<string, unknown> = {};

  for (const ticker of tickers) {
    progress.updateStatus(agentId, ticker, "Fetching financial metrics");
    const metrics = await getFinancialMetrics(ticker, endDate, "annual", 8, apiKey);

    progress.updateStatus(agentId, ticker, "Gathering financial line items");
    const lineItems = await searchLineItems(ticker,
      ["revenue", "gross_profit", "gross_margin", "operating_income", "operating_margin", "net_income",
       "free_cash_flow", "total_debt", "cash_and_equivalents", "current_assets", "current_liabilities",
       "shareholders_equity", "capital_expenditure", "depreciation_and_amortization", "outstanding_shares"],
      endDate, "annual", 8, apiKey);

    progress.updateStatus(agentId, ticker, "Getting market cap");
    const marketCap = await getMarketCap(ticker, endDate, apiKey);

    const downside = analyzeDownsideProtection(lineItems);
    const valuation = analyzePabraiValuation(lineItems, marketCap);
    const doublePotential = analyzeDoublePotential(lineItems, marketCap);

    const totalScore = (downside["score"] as number) * 0.45 + (valuation["score"] as number) * 0.35 + (doublePotential["score"] as number) * 0.20;
    const signal = totalScore >= 7.5 ? "bullish" : totalScore <= 4.0 ? "bearish" : "neutral";

    const analysisData = { signal, score: totalScore, max_score: 10, downside_protection: downside, valuation, double_potential: doublePotential, market_cap: marketCap };

    progress.updateStatus(agentId, ticker, "Generating Pabrai analysis");
    const template = ChatPromptTemplate.fromMessages([
      ["system", `You are Mohnish Pabrai. Principles: heads I win tails I don't lose much, downside protection first, simple business models, high FCF yields, low leverage, asset-light, potential to double in 2-3 years. Checklist-driven. Return JSON only.`],
      ["human", `Analyze {ticker}.\n\nDATA:\n{analysis_data}\n\nReturn EXACTLY this JSON:\n{{\n  "signal": "bullish" | "bearish" | "neutral",\n  "confidence": float (0-100),\n  "reasoning": "string"\n}}`],
    ]);
    const prompt = await template.invoke({ analysis_data: JSON.stringify(analysisData, null, 2), ticker });
    const result = await callLlm(prompt, SignalSchema, {
      agentName: agentId, state,
      defaultFactory: () => ({ signal: "neutral" as const, confidence: 0, reasoning: "Error in analysis" }),
    });

    pabraiAnalysis[ticker] = { signal: result?.signal ?? "neutral", confidence: result?.confidence ?? 0, reasoning: result?.reasoning ?? "" };
    progress.updateStatus(agentId, ticker, "Done", result?.reasoning);
  }

  const message = new HumanMessage({ content: JSON.stringify(pabraiAnalysis), name: agentId });
  if ((state.metadata as Record<string, unknown>)["show_reasoning"]) showAgentReasoning(pabraiAnalysis, "Mohnish Pabrai Agent");

  const existingSignals = (data["analyst_signals"] as Record<string, unknown>) ?? {};
  data["analyst_signals"] = { ...existingSignals, [agentId]: pabraiAnalysis };
  progress.updateStatus(agentId, null, "Done");
  return { messages: [message], data };
}
