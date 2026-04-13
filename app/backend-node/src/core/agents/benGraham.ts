import { HumanMessage } from "@langchain/core/messages";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import type { AgentState } from "../graph/state.js";
import { showAgentReasoning } from "../graph/state.js";
import { getApiKeyFromState } from "../utils/apiKey.js";
import { progress } from "../utils/progress.js";
import { callLlm } from "../utils/llm.js";
import { getFinancialMetrics, getMarketCap, searchLineItems } from "../tools/api.js";
import { z } from "zod";

const BenGrahamSignalSchema = z.object({
  signal: z.enum(["bullish", "bearish", "neutral"]),
  confidence: z.number().min(0).max(100),
  reasoning: z.string(),
});

function analyzeEarningsStability(metrics: unknown[], lineItems: unknown[]): Record<string, unknown> {
  let score = 0;
  const details: string[] = [];
  if (!metrics.length || !lineItems.length) return { score, details: "Insufficient data" };

  const epsVals: number[] = lineItems
    .map((li: any) => li.earnings_per_share as number | null)
    .filter((v): v is number => v != null);

  if (epsVals.length < 2) {
    details.push("Not enough multi-year EPS data.");
    return { score, details: details.join("; ") };
  }

  const positiveEpsYears = epsVals.filter(e => e > 0).length;
  if (positiveEpsYears === epsVals.length) { score += 3; details.push("EPS positive in all periods"); }
  else if (positiveEpsYears >= epsVals.length * 0.8) { score += 2; details.push("EPS positive in most periods"); }
  else { details.push("EPS negative in multiple periods"); }

  if (epsVals[0]! > epsVals[epsVals.length - 1]!) { score += 1; details.push("EPS grew from earliest to latest"); }
  else { details.push("EPS did not grow"); }

  return { score, details: details.join("; ") };
}

function analyzeFinancialStrength(lineItems: unknown[]): Record<string, unknown> {
  let score = 0;
  const details: string[] = [];
  if (!lineItems.length) return { score, details: "No data" };

  const latest: any = lineItems[0];
  const currentAssets = latest.current_assets ?? 0;
  const currentLiabilities = latest.current_liabilities ?? 0;
  const totalAssets = latest.total_assets ?? 0;
  const totalLiabilities = latest.total_liabilities ?? 0;

  if (currentLiabilities > 0) {
    const cr = currentAssets / currentLiabilities;
    if (cr >= 2.0) { score += 2; details.push(`Current ratio ${cr.toFixed(2)} (>=2.0)`); }
    else if (cr >= 1.5) { score += 1; details.push(`Current ratio ${cr.toFixed(2)} (moderate)`); }
    else { details.push(`Current ratio ${cr.toFixed(2)} (<1.5 weak)`); }
  } else { details.push("Cannot compute current ratio"); }

  if (totalAssets > 0) {
    const dr = totalLiabilities / totalAssets;
    if (dr < 0.5) { score += 2; details.push(`Debt ratio ${dr.toFixed(2)} (conservative)`); }
    else if (dr < 0.8) { score += 1; details.push(`Debt ratio ${dr.toFixed(2)} (moderate)`); }
    else { details.push(`Debt ratio ${dr.toFixed(2)} (high)`); }
  }

  const divPeriods: number[] = lineItems
    .map((li: any) => li.dividends_and_other_cash_distributions as number | null)
    .filter((v): v is number => v != null);

  if (divPeriods.length) {
    const divPaid = divPeriods.filter(d => d < 0).length;
    if (divPaid >= Math.floor(divPeriods.length / 2) + 1) {
      score += 1; details.push("Dividends paid most years");
    } else { details.push("Limited dividend payments"); }
  }

  return { score, details: details.join("; ") };
}

function analyzeValuationGraham(lineItems: unknown[], marketCap: number | null): Record<string, unknown> {
  if (!lineItems.length || !marketCap || marketCap <= 0) return { score: 0, details: "Insufficient data" };

  const latest: any = lineItems[0];
  const currentAssets: number = latest.current_assets ?? 0;
  const totalLiabilities: number = latest.total_liabilities ?? 0;
  const bookValuePs: number = latest.book_value_per_share ?? 0;
  const eps: number = latest.earnings_per_share ?? 0;
  const sharesOutstanding: number = latest.outstanding_shares ?? 0;

  const details: string[] = [];
  let score = 0;

  const ncav = currentAssets - totalLiabilities;
  if (ncav > 0 && sharesOutstanding > 0) {
    const ncavPs = ncav / sharesOutstanding;
    const pricePs = marketCap / sharesOutstanding;
    details.push(`NCAV: $${ncav.toLocaleString()}, NCAV/share: $${ncavPs.toFixed(2)}, Price/share: $${pricePs.toFixed(2)}`);
    if (ncav > marketCap) { score += 4; details.push("NCAV > Market Cap (classic Graham deep value)"); }
    else if (ncavPs >= pricePs * 0.67) { score += 2; details.push("NCAV/share >= 2/3 price (moderate discount)"); }
  } else { details.push("NCAV not available"); }

  let grahamNumber: number | null = null;
  if (eps > 0 && bookValuePs > 0) {
    grahamNumber = Math.sqrt(22.5 * eps * bookValuePs);
    details.push(`Graham Number: $${grahamNumber.toFixed(2)}`);
  } else { details.push("Cannot compute Graham Number"); }

  if (grahamNumber && sharesOutstanding > 0) {
    const currentPrice = marketCap / sharesOutstanding;
    if (currentPrice > 0) {
      const mos = (grahamNumber - currentPrice) / currentPrice;
      details.push(`Margin of Safety: ${(mos * 100).toFixed(1)}%`);
      if (mos > 0.5) { score += 3; details.push("Price well below Graham Number (>50% margin)"); }
      else if (mos > 0.2) { score += 1; details.push("Some margin of safety"); }
      else { details.push("Price near or above Graham Number"); }
    }
  }

  return { score, details: details.join("; ") };
}

export async function benGrahamAgent(
  state: AgentState,
  agentId = "ben_graham_agent"
): Promise<Partial<AgentState>> {
  const data = state.data as Record<string, unknown>;
  const endDate = data["end_date"] as string;
  const tickers = data["tickers"] as string[];
  const apiKey = getApiKeyFromState(state, "FINANCIAL_DATASETS_API_KEY");

  const grahamAnalysis: Record<string, unknown> = {};

  for (const ticker of tickers) {
    progress.updateStatus(agentId, ticker, "Fetching financial metrics");
    const metrics = await getFinancialMetrics(ticker, endDate, "annual", 10, apiKey);

    progress.updateStatus(agentId, ticker, "Gathering financial line items");
    const lineItems = await searchLineItems(ticker,
      ["earnings_per_share", "revenue", "net_income", "book_value_per_share", "total_assets",
       "total_liabilities", "current_assets", "current_liabilities",
       "dividends_and_other_cash_distributions", "outstanding_shares"],
      endDate, "annual", 10, apiKey);

    progress.updateStatus(agentId, ticker, "Getting market cap");
    const marketCap = await getMarketCap(ticker, endDate, apiKey);

    progress.updateStatus(agentId, ticker, "Analyzing earnings stability");
    const earningsAnalysis = analyzeEarningsStability(metrics, lineItems);

    progress.updateStatus(agentId, ticker, "Analyzing financial strength");
    const strengthAnalysis = analyzeFinancialStrength(lineItems);

    progress.updateStatus(agentId, ticker, "Analyzing Graham valuation");
    const valuationAnalysis = analyzeValuationGraham(lineItems, marketCap);

    const totalScore = (earningsAnalysis["score"] as number) + (strengthAnalysis["score"] as number) + (valuationAnalysis["score"] as number);
    const maxPossibleScore = 15;
    const signal = totalScore >= 0.7 * maxPossibleScore ? "bullish" : totalScore <= 0.3 * maxPossibleScore ? "bearish" : "neutral";

    const analysisData = { signal, score: totalScore, max_score: maxPossibleScore, earnings_analysis: earningsAnalysis, strength_analysis: strengthAnalysis, valuation_analysis: valuationAnalysis };

    progress.updateStatus(agentId, ticker, "Generating Ben Graham analysis");
    const template = ChatPromptTemplate.fromMessages([
      ["system", `You are a Benjamin Graham AI agent. Use his principles:
1. Insist on margin of safety (Graham Number, net-net).
2. Emphasize financial strength (low leverage, ample current assets).
3. Prefer stable earnings over multiple years.
4. Consider dividend record.
Be thorough and specific with numbers. Return JSON only.`],
      ["human", `Analysis Data for {ticker}:\n{analysis_data}\n\nReturn JSON:\n{{\n  "signal": "bullish" | "bearish" | "neutral",\n  "confidence": float (0-100),\n  "reasoning": "string"\n}}`],
    ]);
    const prompt = await template.invoke({ analysis_data: JSON.stringify(analysisData, null, 2), ticker });
    const result = await callLlm(prompt, BenGrahamSignalSchema, {
      agentName: agentId, state,
      defaultFactory: () => ({ signal: "neutral" as const, confidence: 0, reasoning: "Error in analysis" }),
    });

    grahamAnalysis[ticker] = { signal: result?.signal ?? "neutral", confidence: result?.confidence ?? 0, reasoning: result?.reasoning ?? "" };
    progress.updateStatus(agentId, ticker, "Done", result?.reasoning);
  }

  const message = new HumanMessage({ content: JSON.stringify(grahamAnalysis), name: agentId });
  if ((state.metadata as Record<string, unknown>)["show_reasoning"]) showAgentReasoning(grahamAnalysis, "Ben Graham Agent");

  const existingSignals = (data["analyst_signals"] as Record<string, unknown>) ?? {};
  data["analyst_signals"] = { ...existingSignals, [agentId]: grahamAnalysis };
  progress.updateStatus(agentId, null, "Done");
  return { messages: [message], data };
}
