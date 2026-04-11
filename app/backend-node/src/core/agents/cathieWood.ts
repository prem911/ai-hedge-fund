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

function analyzeInnovationPotential(metrics: unknown[], lineItems: unknown[]): Record<string, unknown> {
  let score = 0;
  const details: string[] = [];
  if (!lineItems.length) return { score, details: "No data" };

  const li0: any = lineItems[0];
  const rd = li0.research_and_development as number | null;
  const revenue = li0.revenue as number | null;
  if (rd != null && revenue && revenue > 0) {
    const rdRatio = Math.abs(rd) / revenue;
    if (rdRatio > 0.20) { score += 3; details.push(`Very high R&D intensity ${(rdRatio * 100).toFixed(1)}%`); }
    else if (rdRatio > 0.10) { score += 2; details.push(`High R&D intensity ${(rdRatio * 100).toFixed(1)}%`); }
    else if (rdRatio > 0.05) { score += 1; details.push(`Some R&D ${(rdRatio * 100).toFixed(1)}%`); }
    else { details.push(`Low R&D ${(rdRatio * 100).toFixed(1)}%`); }
  }

  const revenues: number[] = lineItems.map((li: any) => li.revenue).filter((v: any): v is number => v != null);
  if (revenues.length >= 2) {
    const growth = revenues[0]! / revenues[revenues.length - 1]! - 1;
    if (growth > 0.5) { score += 3; details.push(`Exceptional revenue growth ${(growth * 100).toFixed(0)}%`); }
    else if (growth > 0.25) { score += 2; details.push(`Strong revenue growth ${(growth * 100).toFixed(0)}%`); }
    else if (growth > 0.10) { score += 1; details.push(`Good revenue growth ${(growth * 100).toFixed(0)}%`); }
  }

  const m0: any = metrics[0];
  if (m0?.revenue_growth && m0.revenue_growth > 0.20) { score += 2; details.push(`Recent revenue growth ${(m0.revenue_growth * 100).toFixed(1)}%`); }

  return { score, details: details.join("; ") };
}

function analyzeDisruptivePotential(lineItems: unknown[]): Record<string, unknown> {
  let score = 0;
  const details: string[] = [];
  const grossMargins: number[] = lineItems.map((li: any) => li.gross_margin).filter((v: any): v is number => v != null);
  if (grossMargins.length) {
    const avg = grossMargins.reduce((a, b) => a + b, 0) / grossMargins.length;
    if (avg > 0.60) { score += 2; details.push(`High gross margin ${(avg * 100).toFixed(1)}% (scalable)`); }
    else if (avg > 0.40) { score += 1; details.push(`Decent gross margin ${(avg * 100).toFixed(1)}%`); }
  }

  const opMargins: number[] = lineItems.map((li: any) => li.operating_margin).filter((v: any): v is number => v != null);
  if (opMargins.length) {
    const improving = opMargins[0]! > (opMargins[opMargins.length - 1] ?? opMargins[0]!);
    if (improving) { score += 1; details.push("Operating margin improving (scaling)"); }
  }

  return { score, details: details.join("; ") };
}

function analyzeMarketOpportunity(metrics: unknown[], marketCap: number | null): Record<string, unknown> {
  let score = 0;
  const details: string[] = [];
  const m0: any = metrics[0];
  if (!m0 || !marketCap) return { score, details: "No data" };

  const revGrowth = m0.revenue_growth ?? 0;
  if (revGrowth > 0.30) { score += 2; details.push(`High revenue growth ${(revGrowth * 100).toFixed(1)}%`); }
  else if (revGrowth > 0.15) { score += 1; details.push(`Moderate revenue growth ${(revGrowth * 100).toFixed(1)}%`); }

  const psr = m0.price_to_sales_ratio;
  if (psr != null) {
    if (psr < 5) { score += 2; details.push(`Attractive P/S ${psr.toFixed(1)}`); }
    else if (psr < 15) { score += 1; details.push(`Fair P/S ${psr.toFixed(1)}`); }
    else { details.push(`High P/S ${psr.toFixed(1)}`); }
  }

  return { score, details: details.join("; ") };
}

export async function cathieWoodAgent(
  state: AgentState,
  agentId = "cathie_wood_agent"
): Promise<Partial<AgentState>> {
  const data = state.data as Record<string, unknown>;
  const endDate = data["end_date"] as string;
  const tickers = data["tickers"] as string[];
  const apiKey = getApiKeyFromState(state, "FINANCIAL_DATASETS_API_KEY");

  const woodAnalysis: Record<string, unknown> = {};

  for (const ticker of tickers) {
    progress.updateStatus(agentId, ticker, "Fetching financial metrics");
    const metrics = await getFinancialMetrics(ticker, endDate, "ttm", 5, apiKey);

    progress.updateStatus(agentId, ticker, "Gathering financial line items");
    const lineItems = await searchLineItems(ticker,
      ["revenue", "gross_margin", "operating_margin", "research_and_development",
       "free_cash_flow", "total_debt", "cash_and_equivalents", "outstanding_shares"],
      endDate, "ttm", 5, apiKey);

    progress.updateStatus(agentId, ticker, "Getting market cap");
    const marketCap = await getMarketCap(ticker, endDate, apiKey);

    const innovationAnalysis = analyzeInnovationPotential(metrics, lineItems);
    const disruptiveAnalysis = analyzeDisruptivePotential(lineItems);
    const marketOpportunity = analyzeMarketOpportunity(metrics, marketCap);

    const totalScore = (innovationAnalysis["score"] as number) * 0.40 + (disruptiveAnalysis["score"] as number) * 0.30 + (marketOpportunity["score"] as number) * 0.30;
    const signal = totalScore >= 6 ? "bullish" : totalScore <= 3 ? "bearish" : "neutral";
    const analysisData = { signal, total_score: totalScore, innovation_analysis: innovationAnalysis, disruptive_analysis: disruptiveAnalysis, market_opportunity: marketOpportunity, market_cap: marketCap };

    progress.updateStatus(agentId, ticker, "Generating Cathie Wood analysis");
    const template = ChatPromptTemplate.fromMessages([
      ["system", `You are a Cathie Wood AI agent. Focus on: disruptive innovation, exponential growth platforms, large total addressable markets, technology convergence. Think 5-year horizons. Return JSON only.`],
      ["human", `Analysis Data for {ticker}:\n{analysis_data}\n\nReturn JSON:\n{{\n  "signal": "bullish" | "bearish" | "neutral",\n  "confidence": float (0-100),\n  "reasoning": "string"\n}}`],
    ]);
    const prompt = await template.invoke({ analysis_data: JSON.stringify(analysisData, null, 2), ticker });
    const result = await callLlm(prompt, SignalSchema, {
      agentName: agentId, state,
      defaultFactory: () => ({ signal: "neutral" as const, confidence: 0, reasoning: "Error in analysis" }),
    });

    woodAnalysis[ticker] = { signal: result?.signal ?? "neutral", confidence: result?.confidence ?? 0, reasoning: result?.reasoning ?? "" };
    progress.updateStatus(agentId, ticker, "Done", result?.reasoning);
  }

  const message = new HumanMessage({ content: JSON.stringify(woodAnalysis), name: agentId });
  if ((state.metadata as Record<string, unknown>)["show_reasoning"]) showAgentReasoning(woodAnalysis, "Cathie Wood Agent");

  const existingSignals = (data["analyst_signals"] as Record<string, unknown>) ?? {};
  data["analyst_signals"] = { ...existingSignals, [agentId]: woodAnalysis };
  progress.updateStatus(agentId, null, "Done");
  return { messages: [message], data };
}
