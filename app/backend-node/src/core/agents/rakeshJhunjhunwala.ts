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

function analyzeProfitability(lineItems: unknown[]): Record<string, unknown> {
  if (!lineItems.length) return { score: 0, details: "No profitability data" };
  const latest: any = lineItems[0];
  let score = 0;
  const reasoning: string[] = [];

  const ni: number | null = latest.net_income ?? null;
  const ta: number | null = latest.total_assets ?? null;
  const tl: number | null = latest.total_liabilities ?? null;
  if (ni != null && ni > 0 && ta != null && tl != null) {
    const equity = ta - tl;
    if (equity > 0) {
      const roe = ni / equity * 100;
      if (roe > 20) { score += 3; reasoning.push(`Excellent ROE ${roe.toFixed(1)}%`); }
      else if (roe > 15) { score += 2; reasoning.push(`Good ROE ${roe.toFixed(1)}%`); }
      else if (roe > 10) { score += 1; reasoning.push(`Decent ROE ${roe.toFixed(1)}%`); }
      else { reasoning.push(`Low ROE ${roe.toFixed(1)}%`); }
    }
  } else { reasoning.push("Unable to calculate ROE"); }

  const oi: number | null = latest.operating_income ?? null;
  const rev: number | null = latest.revenue ?? null;
  if (oi != null && oi > 0 && rev != null && rev > 0) {
    const om = oi / rev * 100;
    if (om > 20) { score += 2; reasoning.push(`Excellent op margin ${om.toFixed(1)}%`); }
    else if (om > 15) { score += 1; reasoning.push(`Good op margin ${om.toFixed(1)}%`); }
    else if (om > 0) { reasoning.push(`Positive op margin ${om.toFixed(1)}%`); }
    else { reasoning.push("Negative op margin"); }
  }

  const eps: number[] = lineItems.map((li: any) => li.earnings_per_share).filter((v: any): v is number => v != null && v > 0);
  if (eps.length >= 3) {
    const older = eps[eps.length - 1]!;
    const latest2 = eps[0]!;
    const years = eps.length - 1;
    if (older > 0) {
      const cagr = ((latest2 / older) ** (1 / years) - 1) * 100;
      if (cagr > 20) { score += 3; reasoning.push(`High EPS CAGR ${cagr.toFixed(1)}%`); }
      else if (cagr > 15) { score += 2; reasoning.push(`Good EPS CAGR ${cagr.toFixed(1)}%`); }
      else if (cagr > 10) { score += 1; reasoning.push(`Moderate EPS CAGR ${cagr.toFixed(1)}%`); }
      else { reasoning.push(`Low EPS CAGR ${cagr.toFixed(1)}%`); }
    }
  }

  return { score, details: reasoning.join("; ") };
}

function analyzeGrowth(lineItems: unknown[]): Record<string, unknown> {
  if (lineItems.length < 3) return { score: 0, details: "Insufficient data" };
  let score = 0;
  const reasoning: string[] = [];

  const revenues: number[] = lineItems.map((li: any) => li.revenue).filter((v: any): v is number => v != null && v > 0);
  if (revenues.length >= 3) {
    const older = revenues[revenues.length - 1]!;
    const latest = revenues[0]!;
    const years = revenues.length - 1;
    if (older > 0) {
      const cagr = ((latest / older) ** (1 / years) - 1) * 100;
      if (cagr > 20) { score += 3; reasoning.push(`Excellent revenue CAGR ${cagr.toFixed(1)}%`); }
      else if (cagr > 15) { score += 2; reasoning.push(`Good revenue CAGR ${cagr.toFixed(1)}%`); }
      else if (cagr > 10) { score += 1; reasoning.push(`Moderate revenue CAGR ${cagr.toFixed(1)}%`); }
      else { reasoning.push(`Low revenue CAGR ${cagr.toFixed(1)}%`); }
    }
  }

  const nis: number[] = lineItems.map((li: any) => li.net_income).filter((v: any): v is number => v != null && v > 0);
  if (nis.length >= 3) {
    const older = nis[nis.length - 1]!;
    const latest = nis[0]!;
    const years = nis.length - 1;
    if (older > 0) {
      const cagr = ((latest / older) ** (1 / years) - 1) * 100;
      if (cagr > 25) { score += 3; reasoning.push(`High NI CAGR ${cagr.toFixed(1)}%`); }
      else if (cagr > 20) { score += 2; reasoning.push(`Good NI CAGR ${cagr.toFixed(1)}%`); }
      else if (cagr > 15) { score += 1; reasoning.push(`Moderate NI CAGR ${cagr.toFixed(1)}%`); }
      else { reasoning.push(`Low NI CAGR ${cagr.toFixed(1)}%`); }
    }
  }

  return { score, details: reasoning.join("; ") };
}

function analyzeBalanceSheet(lineItems: unknown[]): Record<string, unknown> {
  if (!lineItems.length) return { score: 0, details: "No data" };
  const li0: any = lineItems[0];
  let score = 0;
  const reasoning: string[] = [];

  const ca: number | null = li0.current_assets ?? null;
  const cl: number | null = li0.current_liabilities ?? null;
  if (ca != null && cl != null && cl > 0) {
    const cr = ca / cl;
    if (cr > 1.5) { score += 2; reasoning.push(`Good liquidity CR ${cr.toFixed(2)}`); }
    else if (cr > 1.0) { score += 1; reasoning.push(`Adequate liquidity CR ${cr.toFixed(2)}`); }
    else { reasoning.push(`Weak liquidity CR ${cr.toFixed(2)}`); }
  }

  const ta: number | null = li0.total_assets ?? null;
  const tl: number | null = li0.total_liabilities ?? null;
  if (ta != null && tl != null && ta > 0) {
    const dr = tl / ta;
    if (dr < 0.4) { score += 2; reasoning.push(`Low leverage ${(dr * 100).toFixed(0)}%`); }
    else if (dr < 0.6) { score += 1; reasoning.push(`Moderate leverage ${(dr * 100).toFixed(0)}%`); }
    else { reasoning.push(`High leverage ${(dr * 100).toFixed(0)}%`); }
  }

  return { score, details: reasoning.join("; ") };
}

function analyzeCashFlow(lineItems: unknown[]): Record<string, unknown> {
  if (!lineItems.length) return { score: 0, details: "No data" };
  let score = 0;
  const reasoning: string[] = [];

  const fcfs: number[] = lineItems.map((li: any) => li.free_cash_flow).filter((v: any): v is number => v != null);
  if (fcfs.length) {
    const pos = fcfs.filter(v => v > 0).length;
    if (pos === fcfs.length) { score += 2; reasoning.push(`All periods positive FCF`); }
    else if (pos >= fcfs.length * 0.7) { score += 1; reasoning.push(`Mostly positive FCF ${pos}/${fcfs.length}`); }
    else { reasoning.push(`Inconsistent FCF ${pos}/${fcfs.length}`); }
  }

  const li0: any = lineItems[0];
  if (li0.free_cash_flow != null && li0.net_income != null && li0.net_income > 0) {
    const fcfNi = (li0.free_cash_flow as number) / (li0.net_income as number);
    if (fcfNi >= 0.8) { score += 1; reasoning.push(`FCF/NI ${fcfNi.toFixed(2)}`); }
  }

  return { score, details: reasoning.join("; ") };
}

function analyzeManagementActions(lineItems: unknown[]): Record<string, unknown> {
  let score = 0;
  const reasoning: string[] = [];

  const divs: number[] = lineItems.map((li: any) => li.dividends_and_other_cash_distributions).filter((v: any): v is number => v != null);
  if (divs.length && divs.filter(d => d < 0).length >= Math.floor(divs.length / 2) + 1) { score += 1; reasoning.push("Consistent dividends"); }

  const shares: number[] = lineItems.map((li: any) => li.outstanding_shares).filter((v: any): v is number => v != null);
  if (shares.length >= 2 && shares[0]! < shares[shares.length - 1]!) { score += 1; reasoning.push("Share buybacks"); }

  return { score, details: reasoning.join("; ") };
}

function calculateJhunjhunwalaIntrinsicValue(lineItems: unknown[]): number | null {
  const li0: any = lineItems[0];
  if (!li0) return null;

  const eps: number[] = lineItems.map((li: any) => li.earnings_per_share).filter((v: any): v is number => v != null && v > 0);
  if (eps.length < 3) return null;

  const older = eps[eps.length - 1]!;
  const latest = eps[0]!;
  const years = eps.length - 1;
  const cagr = older > 0 ? (latest / older) ** (1 / years) - 1 : 0;
  const growthRate = Math.min(cagr, 0.20) * 0.7;
  const peMultiple = 20;

  let pv = 0;
  for (let yr = 1; yr <= 5; yr++) pv += latest * (1 + growthRate) ** yr / (1.10) ** yr;
  const tv = latest * (1 + growthRate) ** 5 * peMultiple / (1.10) ** 5;

  const shares = li0.outstanding_shares as number | null;
  if (!shares) return null;
  return (pv + tv) * shares;
}

function assessQualityMetrics(lineItems: unknown[]): number {
  let qs = 0;
  const fcfs: number[] = lineItems.map((li: any) => li.free_cash_flow).filter((v: any): v is number => v != null);
  if (fcfs.length && fcfs.filter(v => v > 0).length === fcfs.length) qs += 0.4;

  const li0: any = lineItems[0];
  if (li0?.operating_margin != null && (li0.operating_margin as number) > 0.15) qs += 0.3;

  const shares: number[] = lineItems.map((li: any) => li.outstanding_shares).filter((v: any): v is number => v != null);
  if (shares.length >= 2 && shares[0]! <= shares[shares.length - 1]!) qs += 0.3;

  return qs;
}

function analyzeRakeshJhunjhunwalaStyle(lineItems: unknown[], intrinsicValue: number | null, currentPrice: number | null): Record<string, unknown> {
  const details: string[] = [];
  if (intrinsicValue != null && currentPrice != null && currentPrice > 0) {
    const mos = (intrinsicValue - currentPrice) / currentPrice;
    details.push(`Intrinsic: $${intrinsicValue.toLocaleString()}, MoS: ${(mos * 100).toFixed(1)}%`);
  }
  return { intrinsic_value: intrinsicValue, current_price: currentPrice, details: details.join("; ") };
}

export async function rakeshJhunjhunwalaAgent(
  state: AgentState,
  agentId = "rakesh_jhunjhunwala_agent"
): Promise<Partial<AgentState>> {
  const data = state.data as Record<string, unknown>;
  const endDate = data["end_date"] as string;
  const tickers = data["tickers"] as string[];
  const apiKey = getApiKeyFromState(state, "FINANCIAL_DATASETS_API_KEY");

  const jhunjhunwalaAnalysis: Record<string, unknown> = {};

  for (const ticker of tickers) {
    progress.updateStatus(agentId, ticker, "Fetching financial metrics");
    const metrics = await getFinancialMetrics(ticker, endDate, "ttm", 5, apiKey);

    progress.updateStatus(agentId, ticker, "Fetching financial line items");
    const lineItems = await searchLineItems(ticker,
      ["net_income", "earnings_per_share", "ebit", "operating_income", "revenue", "operating_margin",
       "total_assets", "total_liabilities", "current_assets", "current_liabilities",
       "free_cash_flow", "dividends_and_other_cash_distributions", "outstanding_shares",
       "issuance_or_purchase_of_equity_shares"],
      endDate, "ttm", 5, apiKey);

    progress.updateStatus(agentId, ticker, "Getting market cap");
    const marketCap = await getMarketCap(ticker, endDate, apiKey);

    const growthAnalysis = analyzeGrowth(lineItems);
    const profitabilityAnalysis = analyzeProfitability(lineItems);
    const balanceSheetAnalysis = analyzeBalanceSheet(lineItems);
    const cashFlowAnalysis = analyzeCashFlow(lineItems);
    const managementAnalysis = analyzeManagementActions(lineItems);
    const intrinsicValue = calculateJhunjhunwalaIntrinsicValue(lineItems);

    const totalScore = (growthAnalysis["score"] as number) + (profitabilityAnalysis["score"] as number) + (balanceSheetAnalysis["score"] as number) + (cashFlowAnalysis["score"] as number) + (managementAnalysis["score"] as number);
    const maxScore = 24;

    const marginOfSafety = intrinsicValue && marketCap ? (intrinsicValue - marketCap) / marketCap : null;
    const qualityScore = assessQualityMetrics(lineItems);

    let signal: "bullish" | "bearish" | "neutral";
    if (marginOfSafety != null && marginOfSafety >= 0.30) signal = "bullish";
    else if (marginOfSafety != null && marginOfSafety <= -0.30) signal = "bearish";
    else if (qualityScore >= 0.7 && totalScore >= maxScore * 0.6) signal = "bullish";
    else if (qualityScore <= 0.4 || totalScore <= maxScore * 0.3) signal = "bearish";
    else signal = "neutral";

    const confidence = marginOfSafety != null ? Math.min(Math.max(Math.abs(marginOfSafety) * 150, 20), 95) : Math.min(Math.max((totalScore / maxScore) * 100, 10), 80);

    const intrinsicValueAnalysis = analyzeRakeshJhunjhunwalaStyle(lineItems, intrinsicValue, marketCap);
    const analysisData = { signal, score: totalScore, max_score: maxScore, margin_of_safety: marginOfSafety, growth_analysis: growthAnalysis, profitability_analysis: profitabilityAnalysis, balancesheet_analysis: balanceSheetAnalysis, cashflow_analysis: cashFlowAnalysis, management_analysis: managementAnalysis, intrinsic_value_analysis: intrinsicValueAnalysis, intrinsic_value: intrinsicValue, market_cap: marketCap };

    progress.updateStatus(agentId, ticker, "Generating Jhunjhunwala analysis");
    const template = ChatPromptTemplate.fromMessages([
      ["system", `You are Rakesh Jhunjhunwala - India's Big Bull. Principles: buy growth at reasonable price, identify multi-baggers early, high ROE businesses, long-term compounders. Focus on India-style growth metrics. Return JSON only.`],
      ["human", `Ticker: {ticker}\n\nAnalysis:\n{analysis_data}\n\nReturn JSON:\n{{\n  "signal": "bullish" | "bearish" | "neutral",\n  "confidence": float (0-100),\n  "reasoning": "string"\n}}`],
    ]);
    const prompt = await template.invoke({ analysis_data: JSON.stringify(analysisData, null, 2), ticker });
    const result = await callLlm(prompt, SignalSchema, {
      agentName: agentId, state,
      defaultFactory: () => ({ signal: signal, confidence: Math.round(confidence), reasoning: "Insufficient LLM data" }),
    });

    jhunjhunwalaAnalysis[ticker] = { signal: result?.signal ?? signal, confidence: result?.confidence ?? Math.round(confidence), reasoning: result?.reasoning ?? "" };
    progress.updateStatus(agentId, ticker, "Done", result?.reasoning);
  }

  const message = new HumanMessage({ content: JSON.stringify(jhunjhunwalaAnalysis), name: agentId });
  if ((state.metadata as Record<string, unknown>)["show_reasoning"]) showAgentReasoning(jhunjhunwalaAnalysis, "Rakesh Jhunjhunwala Agent");

  const existingSignals = (data["analyst_signals"] as Record<string, unknown>) ?? {};
  data["analyst_signals"] = { ...existingSignals, [agentId]: jhunjhunwalaAnalysis };
  progress.updateStatus(agentId, null, "Done");
  return { messages: [message], data };
}
