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

function analyzeBusinessQuality(metrics: unknown[], lineItems: unknown[]): Record<string, unknown> {
  let score = 0;
  const details: string[] = [];
  if (!metrics.length || !lineItems.length) return { score, details: "Insufficient data" };

  const revenues: number[] = lineItems.map((li: any) => li.revenue).filter((v: any): v is number => v != null);
  if (revenues.length >= 2) {
    const growth = (revenues[0]! - revenues[revenues.length - 1]!) / Math.abs(revenues[revenues.length - 1]!);
    if (growth > 0.5) { score += 2; details.push(`Revenue grew ${(growth * 100).toFixed(1)}%`); }
    else if (growth > 0) { score += 1; details.push(`Revenue growth ${(growth * 100).toFixed(1)}%`); }
    else { details.push("Revenue did not grow"); }
  }

  const opMargins: number[] = lineItems.map((li: any) => li.operating_margin).filter((v: any): v is number => v != null);
  if (opMargins.length) {
    const above15 = opMargins.filter(m => m > 0.15).length;
    if (above15 >= Math.floor(opMargins.length / 2) + 1) { score += 2; details.push("Operating margin often >15%"); }
    else { details.push("Operating margin not consistently >15%"); }
  }

  const fcfs: number[] = lineItems.map((li: any) => li.free_cash_flow).filter((v: any): v is number => v != null);
  if (fcfs.length) {
    if (fcfs.filter(f => f > 0).length >= Math.floor(fcfs.length / 2) + 1) { score += 1; details.push("Majority positive FCF"); }
  }

  const m0: any = metrics[0];
  if (m0?.return_on_equity && m0.return_on_equity > 0.15) { score += 2; details.push(`High ROE ${(m0.return_on_equity * 100).toFixed(1)}%`); }
  else if (m0?.return_on_equity) { details.push(`Moderate ROE ${(m0.return_on_equity * 100).toFixed(1)}%`); }

  return { score, details: details.join("; ") };
}

function analyzeFinancialDiscipline(lineItems: unknown[]): Record<string, unknown> {
  let score = 0;
  const details: string[] = [];

  const des: number[] = lineItems.map((li: any) => li.debt_to_equity).filter((v: any): v is number => v != null);
  if (des.length) {
    if (des.filter(d => d < 1.0).length >= Math.floor(des.length / 2) + 1) { score += 2; details.push("D/E < 1.0 majority of periods"); }
    else { details.push("High leverage in many periods"); }
  } else {
    const li0: any = lineItems[0];
    if (li0 && li0.total_liabilities && li0.total_assets && li0.total_assets > 0) {
      const r = li0.total_liabilities / li0.total_assets;
      if (r < 0.5) { score += 2; details.push(`Liabilities/assets ${(r * 100).toFixed(0)}% (low)`); }
    }
  }

  const divs: number[] = lineItems.map((li: any) => li.dividends_and_other_cash_distributions).filter((v: any): v is number => v != null);
  if (divs.length && divs.filter(d => d < 0).length >= Math.floor(divs.length / 2) + 1) { score += 1; details.push("History of returning capital"); }

  const shares: number[] = lineItems.map((li: any) => li.outstanding_shares).filter((v: any): v is number => v != null);
  if (shares.length >= 2 && shares[0]! < shares[shares.length - 1]!) { score += 1; details.push("Share count decreased (buybacks)"); }

  return { score, details: details.join("; ") };
}

function analyzeActivismPotential(lineItems: unknown[]): Record<string, unknown> {
  if (!lineItems.length) return { score: 0, details: "Insufficient data" };
  const revenues: number[] = lineItems.map((li: any) => li.revenue).filter((v: any): v is number => v != null);
  const opMargins: number[] = lineItems.map((li: any) => li.operating_margin).filter((v: any): v is number => v != null);
  if (revenues.length < 2 || !opMargins.length) return { score: 0, details: "Not enough data" };

  const revGrowth = (revenues[0]! - revenues[revenues.length - 1]!) / Math.abs(revenues[revenues.length - 1]!);
  const avgMargin = opMargins.reduce((a, b) => a + b, 0) / opMargins.length;

  if (revGrowth > 0.15 && avgMargin < 0.10) {
    return { score: 2, details: `Revenue growth ${(revGrowth * 100).toFixed(1)}% but margins low (avg ${(avgMargin * 100).toFixed(1)}%) - activism opportunity` };
  }
  return { score: 0, details: "No clear activism opportunity" };
}

function analyzeValuationAckman(lineItems: unknown[], marketCap: number | null): Record<string, unknown> {
  if (!lineItems.length || !marketCap) return { score: 0, details: "Insufficient data" };
  const li0: any = lineItems[0];
  const fcf: number = li0.free_cash_flow ?? 0;
  if (fcf <= 0) return { score: 0, details: `No positive FCF: ${fcf}` };

  let pv = 0;
  const growthRate = 0.06, discountRate = 0.10, terminalMultiple = 15, years = 5;
  for (let yr = 1; yr <= years; yr++) pv += fcf * (1 + growthRate) ** yr / (1 + discountRate) ** yr;
  const tv = fcf * (1 + growthRate) ** years * terminalMultiple / (1 + discountRate) ** years;
  const intrinsicValue = pv + tv;
  const mos = (intrinsicValue - marketCap) / marketCap;

  let score = 0;
  if (mos > 0.3) score += 3;
  else if (mos > 0.1) score += 1;

  return { score, details: `Intrinsic: $${intrinsicValue.toLocaleString()}, MoS: ${(mos * 100).toFixed(1)}%`, intrinsic_value: intrinsicValue, margin_of_safety: mos };
}

export async function billAckmanAgent(
  state: AgentState,
  agentId = "bill_ackman_agent"
): Promise<Partial<AgentState>> {
  const data = state.data as Record<string, unknown>;
  const endDate = data["end_date"] as string;
  const tickers = data["tickers"] as string[];
  const apiKey = getApiKeyFromState(state, "FINANCIAL_DATASETS_API_KEY");

  const ackmanAnalysis: Record<string, unknown> = {};

  for (const ticker of tickers) {
    progress.updateStatus(agentId, ticker, "Fetching financial metrics");
    const metrics = await getFinancialMetrics(ticker, endDate, "annual", 5, apiKey);

    progress.updateStatus(agentId, ticker, "Gathering financial line items");
    const lineItems = await searchLineItems(ticker,
      ["revenue", "operating_margin", "debt_to_equity", "free_cash_flow", "total_assets",
       "total_liabilities", "dividends_and_other_cash_distributions", "outstanding_shares"],
      endDate, "annual", 5, apiKey);

    progress.updateStatus(agentId, ticker, "Getting market cap");
    const marketCap = await getMarketCap(ticker, endDate, apiKey);

    const qualityAnalysis = analyzeBusinessQuality(metrics, lineItems);
    const balanceSheetAnalysis = analyzeFinancialDiscipline(lineItems);
    const activismAnalysis = analyzeActivismPotential(lineItems);
    const valuationAnalysis = analyzeValuationAckman(lineItems, marketCap);

    const totalScore = (qualityAnalysis["score"] as number) + (balanceSheetAnalysis["score"] as number) + (activismAnalysis["score"] as number) + (valuationAnalysis["score"] as number);
    const maxScore = 20;
    const signal = totalScore >= 0.7 * maxScore ? "bullish" : totalScore <= 0.3 * maxScore ? "bearish" : "neutral";
    const analysisData = { signal, score: totalScore, max_score: maxScore, quality_analysis: qualityAnalysis, balance_sheet_analysis: balanceSheetAnalysis, activism_analysis: activismAnalysis, valuation_analysis: valuationAnalysis };

    progress.updateStatus(agentId, ticker, "Generating Bill Ackman analysis");
    const template = ChatPromptTemplate.fromMessages([
      ["system", `You are a Bill Ackman AI agent. Principles: high-quality moat businesses, durable competitive advantages, FCF growth, financial discipline, margin of safety, activism potential. Be thorough with numbers. Return JSON only.`],
      ["human", `Analysis Data for {ticker}:\n{analysis_data}\n\nReturn JSON:\n{{\n  "signal": "bullish" | "bearish" | "neutral",\n  "confidence": float (0-100),\n  "reasoning": "string"\n}}`],
    ]);
    const prompt = await template.invoke({ analysis_data: JSON.stringify(analysisData, null, 2), ticker });
    const result = await callLlm(prompt, SignalSchema, {
      agentName: agentId, state,
      defaultFactory: () => ({ signal: "neutral" as const, confidence: 0, reasoning: "Error in analysis" }),
    });

    ackmanAnalysis[ticker] = { signal: result?.signal ?? "neutral", confidence: result?.confidence ?? 0, reasoning: result?.reasoning ?? "" };
    progress.updateStatus(agentId, ticker, "Done", result?.reasoning);
  }

  const message = new HumanMessage({ content: JSON.stringify(ackmanAnalysis), name: agentId });
  if ((state.metadata as Record<string, unknown>)["show_reasoning"]) showAgentReasoning(ackmanAnalysis, "Bill Ackman Agent");

  const existingSignals = (data["analyst_signals"] as Record<string, unknown>) ?? {};
  data["analyst_signals"] = { ...existingSignals, [agentId]: ackmanAnalysis };
  progress.updateStatus(agentId, null, "Done");
  return { messages: [message], data };
}
