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
  confidence: z.number().min(0).max(100),
  reasoning: z.string(),
});

function analyzeValue(metrics: unknown[], lineItems: unknown[], marketCap: number | null): Record<string, unknown> {
  const maxScore = 6;
  let score = 0;
  const details: string[] = [];

  const li0: any = lineItems[0];
  const fcf: number | null = li0?.free_cash_flow ?? null;
  if (fcf != null && marketCap) {
    const fcfYield = fcf / marketCap;
    if (fcfYield >= 0.15) { score += 4; details.push(`Extraordinary FCF yield ${(fcfYield * 100).toFixed(1)}%`); }
    else if (fcfYield >= 0.12) { score += 3; details.push(`Very high FCF yield ${(fcfYield * 100).toFixed(1)}%`); }
    else if (fcfYield >= 0.08) { score += 2; details.push(`Respectable FCF yield ${(fcfYield * 100).toFixed(1)}%`); }
    else { details.push(`Low FCF yield ${(fcfYield * 100).toFixed(1)}%`); }
  } else { details.push("FCF data unavailable"); }

  if (metrics.length) {
    const m0: any = metrics[0];
    const evEbit = m0.ev_to_ebit ?? null;
    if (evEbit != null) {
      if (evEbit < 6) { score += 2; details.push(`EV/EBIT ${evEbit.toFixed(1)} (<6)`); }
      else if (evEbit < 10) { score += 1; details.push(`EV/EBIT ${evEbit.toFixed(1)} (<10)`); }
      else { details.push(`High EV/EBIT ${evEbit.toFixed(1)}`); }
    } else { details.push("EV/EBIT unavailable"); }
  }

  return { score, max_score: maxScore, details: details.join("; ") };
}

function analyzeBalanceSheet(metrics: unknown[], lineItems: unknown[]): Record<string, unknown> {
  const maxScore = 3;
  let score = 0;
  const details: string[] = [];
  const m0: any = metrics[0];
  const li0: any = lineItems[0];

  const dte = m0?.debt_to_equity ?? null;
  if (dte != null) {
    if (dte < 0.5) { score += 2; details.push(`Low D/E ${dte.toFixed(2)}`); }
    else if (dte < 1) { score += 1; details.push(`Moderate D/E ${dte.toFixed(2)}`); }
    else { details.push(`High D/E ${dte.toFixed(2)}`); }
  }

  if (li0) {
    const cash = li0.cash_and_equivalents ?? null;
    const debt = li0.total_debt ?? null;
    if (cash != null && debt != null) {
      if (cash > debt) { score += 1; details.push("Net cash position"); }
      else { details.push("Net debt position"); }
    }
  }

  return { score, max_score: maxScore, details: details.join("; ") };
}

function analyzeInsiderActivity(trades: unknown[]): Record<string, unknown> {
  const maxScore = 2;
  let score = 0;
  const details: string[] = [];
  if (!trades.length) { details.push("No insider trade data"); return { score, max_score: maxScore, details: details.join("; ") }; }

  let sharesBought = 0, sharesSold = 0;
  for (const t of trades) {
    const shares = (t as any).transaction_shares ?? 0;
    if (shares > 0) sharesBought += shares;
    else if (shares < 0) sharesSold += Math.abs(shares);
  }
  const net = sharesBought - sharesSold;
  if (net > 0) {
    score += (net / Math.max(sharesSold, 1) > 1) ? 2 : 1;
    details.push(`Net insider buying ${net.toLocaleString()} shares`);
  } else { details.push("Net insider selling"); }

  return { score, max_score: maxScore, details: details.join("; ") };
}

function analyzeContrarianSentiment(news: unknown[]): Record<string, unknown> {
  const maxScore = 1;
  let score = 0;
  const details: string[] = [];
  if (!news.length) { details.push("No recent news"); return { score, max_score: maxScore, details: details.join("; ") }; }

  const negCount = news.filter((n: any) => n.sentiment && ["negative", "bearish"].includes(n.sentiment.toLowerCase())).length;
  if (negCount >= 5) { score += 1; details.push(`${negCount} negative headlines (contrarian opportunity)`); }
  else { details.push("Limited negative press"); }

  return { score, max_score: maxScore, details: details.join("; ") };
}

export async function michaelBurryAgent(
  state: AgentState,
  agentId = "michael_burry_agent"
): Promise<Partial<AgentState>> {
  const data = state.data as Record<string, unknown>;
  const endDate = data["end_date"] as string;
  const tickers = data["tickers"] as string[];
  const apiKey = getApiKeyFromState(state, "FINANCIAL_DATASETS_API_KEY");
  const startDate = new Date(new Date(endDate).getTime() - 365 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]!;

  const burryAnalysis: Record<string, unknown> = {};

  for (const ticker of tickers) {
    progress.updateStatus(agentId, ticker, "Fetching financial metrics");
    const metrics = await getFinancialMetrics(ticker, endDate, "ttm", 5, apiKey);

    progress.updateStatus(agentId, ticker, "Fetching line items");
    const lineItems = await searchLineItems(ticker,
      ["free_cash_flow", "net_income", "total_debt", "cash_and_equivalents", "total_assets",
       "total_liabilities", "outstanding_shares", "issuance_or_purchase_of_equity_shares"],
      endDate, "ttm", 5, apiKey);

    progress.updateStatus(agentId, ticker, "Fetching insider trades");
    const insiderTrades = await getInsiderTrades(ticker, endDate, startDate, 1000, apiKey);

    progress.updateStatus(agentId, ticker, "Fetching company news");
    const news = await getCompanyNews(ticker, endDate, startDate, 250, apiKey);

    progress.updateStatus(agentId, ticker, "Getting market cap");
    const marketCap = await getMarketCap(ticker, endDate, apiKey);

    const valueAnalysis = analyzeValue(metrics, lineItems, marketCap);
    const balanceSheetAnalysis = analyzeBalanceSheet(metrics, lineItems);
    const insiderAnalysis = analyzeInsiderActivity(insiderTrades);
    const contrarianAnalysis = analyzeContrarianSentiment(news);

    const totalScore = (valueAnalysis["score"] as number) + (balanceSheetAnalysis["score"] as number) + (insiderAnalysis["score"] as number) + (contrarianAnalysis["score"] as number);
    const maxScore = (valueAnalysis["max_score"] as number) + (balanceSheetAnalysis["max_score"] as number) + (insiderAnalysis["max_score"] as number) + (contrarianAnalysis["max_score"] as number);
    const signal = totalScore >= 0.7 * maxScore ? "bullish" : totalScore <= 0.3 * maxScore ? "bearish" : "neutral";

    const analysisData = { signal, score: totalScore, max_score: maxScore, value_analysis: valueAnalysis, balance_sheet_analysis: balanceSheetAnalysis, insider_analysis: insiderAnalysis, contrarian_analysis: contrarianAnalysis, market_cap: marketCap };

    progress.updateStatus(agentId, ticker, "Generating LLM output");
    const template = ChatPromptTemplate.fromMessages([
      ["system", `You are Michael Burry. Hunt for deep value using hard numbers (FCF yield, EV/EBIT, balance sheet). Be contrarian. Focus on downside first. Look for insider buying, buybacks, asset sales. Be terse and data-driven. Return JSON only.`],
      ["human", `Analysis Data for {ticker}:\n{analysis_data}\n\nReturn JSON:\n{{\n  "signal": "bullish" | "bearish" | "neutral",\n  "confidence": float (0-100),\n  "reasoning": "string"\n}}`],
    ]);
    const prompt = await template.invoke({ analysis_data: JSON.stringify(analysisData, null, 2), ticker });
    const result = await callLlm(prompt, SignalSchema, {
      agentName: agentId, state,
      defaultFactory: () => ({ signal: "neutral" as const, confidence: 0, reasoning: "Parsing error" }),
    });

    burryAnalysis[ticker] = { signal: result?.signal ?? "neutral", confidence: result?.confidence ?? 0, reasoning: result?.reasoning ?? "" };
    progress.updateStatus(agentId, ticker, "Done", result?.reasoning);
  }

  const message = new HumanMessage({ content: JSON.stringify(burryAnalysis), name: agentId });
  if ((state.metadata as Record<string, unknown>)["show_reasoning"]) showAgentReasoning(burryAnalysis, "Michael Burry Agent");

  const existingSignals = (data["analyst_signals"] as Record<string, unknown>) ?? {};
  data["analyst_signals"] = { ...existingSignals, [agentId]: burryAnalysis };
  progress.updateStatus(agentId, null, "Done");
  return { messages: [message], data };
}
