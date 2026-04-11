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

function analyzeGrowthReinvestment(metrics: unknown[], lineItems: unknown[]): Record<string, unknown> {
  const maxScore = 4;
  if (metrics.length < 2) return { score: 0, max_score: maxScore, details: "Insufficient history" };

  const revs: number[] = (metrics as any[])
    .filter((m: any) => m.revenue != null && m.revenue > 0)
    .reverse()
    .map((m: any) => m.revenue as number);

  let score = 0;
  const details: string[] = [];
  let cagr: number | null = null;

  if (revs.length >= 2) {
    cagr = (revs[revs.length - 1]! / revs[0]!) ** (1 / (revs.length - 1)) - 1;
    if (cagr > 0.08) { score += 2; details.push(`Revenue CAGR ${(cagr * 100).toFixed(1)}% (>8%)`); }
    else if (cagr > 0.03) { score += 1; details.push(`Revenue CAGR ${(cagr * 100).toFixed(1)}% (>3%)`); }
    else { details.push(`Sluggish CAGR ${(cagr * 100).toFixed(1)}%`); }
  }

  const fcfs: number[] = lineItems.map((li: any) => li.free_cash_flow).filter((v: any): v is number => v != null).reverse();
  if (fcfs.length >= 2 && fcfs[fcfs.length - 1]! > fcfs[0]!) { score += 1; details.push("Positive FCFF growth"); }
  else { details.push("Flat/declining FCFF"); }

  const m0: any = metrics[0];
  if (m0?.return_on_invested_capital && m0.return_on_invested_capital > 0.10) { score += 1; details.push(`ROIC ${(m0.return_on_invested_capital * 100).toFixed(1)}% (>10%)`); }

  return { score, max_score: maxScore, details: details.join("; "), metrics: m0 };
}

function analyzeRiskProfile(metrics: unknown[], lineItems: unknown[]): Record<string, unknown> {
  const maxScore = 3;
  if (!metrics.length) return { score: 0, max_score: maxScore, details: "No metrics" };
  const m0: any = metrics[0];
  let score = 0;
  const details: string[] = [];

  const beta = m0.beta ?? null;
  if (beta != null) {
    if (beta < 1.3) { score += 1; details.push(`Beta ${beta.toFixed(2)}`); }
    else { details.push(`High beta ${beta.toFixed(2)}`); }
  } else { details.push("Beta N/A"); }

  const dte = m0.debt_to_equity ?? null;
  if (dte != null) {
    if (dte < 1) { score += 1; details.push(`D/E ${dte.toFixed(1)}`); }
    else { details.push(`High D/E ${dte.toFixed(1)}`); }
  }

  const ebit = m0.ebit ?? null;
  const interest = m0.interest_expense ?? null;
  if (ebit && interest && interest !== 0) {
    const coverage = ebit / Math.abs(interest);
    if (coverage > 3) { score += 1; details.push(`Interest coverage ×${coverage.toFixed(1)}`); }
    else { details.push(`Weak coverage ×${coverage.toFixed(1)}`); }
  }

  const costOfEquity = estimateCostOfEquity(beta);
  return { score, max_score: maxScore, details: details.join("; "), beta, cost_of_equity: costOfEquity };
}

function analyzeRelativeValuation(metrics: unknown[]): Record<string, unknown> {
  const maxScore = 1;
  if (!metrics.length || metrics.length < 5) return { score: 0, max_score: maxScore, details: "Insufficient P/E history" };
  const pes: number[] = (metrics as any[]).map(m => m.price_to_earnings_ratio).filter((v: any): v is number => v != null);
  if (pes.length < 5) return { score: 0, max_score: maxScore, details: "P/E data sparse" };

  const ttmPe = pes[0]!;
  const sorted = [...pes].sort((a, b) => a - b);
  const medianPe = sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)]! : (sorted[Math.floor(sorted.length / 2) - 1]! + sorted[Math.floor(sorted.length / 2)]!) / 2;

  if (ttmPe < 0.7 * medianPe) return { score: 1, max_score: maxScore, details: `P/E ${ttmPe.toFixed(1)} vs median ${medianPe.toFixed(1)} (cheap)` };
  if (ttmPe > 1.3 * medianPe) return { score: -1, max_score: maxScore, details: `P/E ${ttmPe.toFixed(1)} vs median ${medianPe.toFixed(1)} (expensive)` };
  return { score: 0, max_score: maxScore, details: "P/E inline with history" };
}

function calculateIntrinsicValueDcf(metrics: unknown[], lineItems: unknown[], riskAnalysis: Record<string, unknown>): Record<string, unknown> {
  if (!metrics.length || metrics.length < 2 || !lineItems.length) return { intrinsic_value: null, details: ["Insufficient data"] };

  const m0: any = metrics[0];
  const fcff0: number | null = m0.free_cash_flow ?? null;
  const li0: any = lineItems[0];
  const shares: number | null = li0.outstanding_shares ?? null;
  if (!fcff0 || !shares) return { intrinsic_value: null, details: ["Missing FCFF or shares"] };

  const revs: number[] = (metrics as any[]).filter(m => (m as any).revenue).reverse().map(m => (m as any).revenue as number);
  let baseGrowth = 0.04;
  if (revs.length >= 2 && revs[0]! > 0) {
    baseGrowth = Math.min((revs[revs.length - 1]! / revs[0]!) ** (1 / (revs.length - 1)) - 1, 0.12);
  }

  const terminalGrowth = 0.025;
  const years = 10;
  const discount = (riskAnalysis["cost_of_equity"] as number) || 0.09;

  let pvSum = 0;
  let g = baseGrowth;
  const gStep = (terminalGrowth - baseGrowth) / (years - 1);
  for (let yr = 1; yr <= years; yr++) {
    pvSum += fcff0 * (1 + g) / (1 + discount) ** yr;
    g += gStep;
  }

  const tv = fcff0 * (1 + terminalGrowth) / (discount - terminalGrowth) / (1 + discount) ** years;
  const equityValue = pvSum + tv;
  const intrinsicPerShare = equityValue / shares;

  return { intrinsic_value: equityValue, intrinsic_per_share: intrinsicPerShare, assumptions: { base_fcff: fcff0, base_growth: baseGrowth, terminal_growth: terminalGrowth, discount_rate: discount, projection_years: years }, details: ["FCFF DCF completed"] };
}

function estimateCostOfEquity(beta: number | null): number {
  const riskFree = 0.04;
  const erp = 0.05;
  return riskFree + (beta ?? 1.0) * erp;
}

export async function aswathDamodaranAgent(
  state: AgentState,
  agentId = "aswath_damodaran_agent"
): Promise<Partial<AgentState>> {
  const data = state.data as Record<string, unknown>;
  const endDate = data["end_date"] as string;
  const tickers = data["tickers"] as string[];
  const apiKey = getApiKeyFromState(state, "FINANCIAL_DATASETS_API_KEY");

  const damodaranSignals: Record<string, unknown> = {};

  for (const ticker of tickers) {
    progress.updateStatus(agentId, ticker, "Fetching financial metrics");
    const metrics = await getFinancialMetrics(ticker, endDate, "ttm", 5, apiKey);

    progress.updateStatus(agentId, ticker, "Fetching financial line items");
    const lineItems = await searchLineItems(ticker,
      ["free_cash_flow", "ebit", "interest_expense", "capital_expenditure",
       "depreciation_and_amortization", "outstanding_shares", "net_income", "total_debt"],
      endDate, "ttm", 5, apiKey);

    progress.updateStatus(agentId, ticker, "Getting market cap");
    const marketCap = await getMarketCap(ticker, endDate, apiKey);

    progress.updateStatus(agentId, ticker, "Analyzing growth and reinvestment");
    const growthAnalysis = analyzeGrowthReinvestment(metrics, lineItems);

    progress.updateStatus(agentId, ticker, "Analyzing risk profile");
    const riskAnalysis = analyzeRiskProfile(metrics, lineItems);

    progress.updateStatus(agentId, ticker, "Calculating intrinsic value (DCF)");
    const intrinsicValAnalysis = calculateIntrinsicValueDcf(metrics, lineItems, riskAnalysis);

    progress.updateStatus(agentId, ticker, "Assessing relative valuation");
    const relativeValAnalysis = analyzeRelativeValuation(metrics);

    const totalScore = (growthAnalysis["score"] as number) + (riskAnalysis["score"] as number) + (relativeValAnalysis["score"] as number);
    const maxScore = (growthAnalysis["max_score"] as number) + (riskAnalysis["max_score"] as number) + (relativeValAnalysis["max_score"] as number);

    const intrinsicValue = intrinsicValAnalysis["intrinsic_value"] as number | null;
    const marginOfSafety = intrinsicValue && marketCap ? (intrinsicValue - marketCap) / marketCap : null;

    const signal = marginOfSafety != null && marginOfSafety >= 0.25 ? "bullish" : marginOfSafety != null && marginOfSafety <= -0.25 ? "bearish" : "neutral";

    const analysisData = { signal, score: totalScore, max_score: maxScore, margin_of_safety: marginOfSafety, growth_analysis: growthAnalysis, risk_analysis: riskAnalysis, relative_val_analysis: relativeValAnalysis, intrinsic_val_analysis: intrinsicValAnalysis, market_cap: marketCap };

    progress.updateStatus(agentId, ticker, "Generating Damodaran analysis");
    const template = ChatPromptTemplate.fromMessages([
      ["system", `You are Aswath Damodaran, Professor of Finance at NYU Stern. Use your valuation framework. Connect story to numbers: revenue growth, margins, reinvestment, risk. Conclude with FCFF DCF, margin of safety, relative valuation. Return JSON only.`],
      ["human", `Ticker: {ticker}\n\nAnalysis data:\n{analysis_data}\n\nRespond EXACTLY in this JSON schema:\n{{\n  "signal": "bullish" | "bearish" | "neutral",\n  "confidence": float (0-100),\n  "reasoning": "string"\n}}`],
    ]);
    const prompt = await template.invoke({ analysis_data: JSON.stringify(analysisData, null, 2), ticker });
    const result = await callLlm(prompt, SignalSchema, {
      agentName: agentId, state,
      defaultFactory: () => ({ signal: "neutral" as const, confidence: 0, reasoning: "Parsing error" }),
    });

    damodaranSignals[ticker] = { signal: result?.signal ?? "neutral", confidence: result?.confidence ?? 0, reasoning: result?.reasoning ?? "" };
    progress.updateStatus(agentId, ticker, "Done", result?.reasoning);
  }

  const message = new HumanMessage({ content: JSON.stringify(damodaranSignals), name: agentId });
  if ((state.metadata as Record<string, unknown>)["show_reasoning"]) showAgentReasoning(damodaranSignals, "Aswath Damodaran Agent");

  const existingSignals = (data["analyst_signals"] as Record<string, unknown>) ?? {};
  data["analyst_signals"] = { ...existingSignals, [agentId]: damodaranSignals };
  progress.updateStatus(agentId, null, "Done");
  return { messages: [message], data };
}
