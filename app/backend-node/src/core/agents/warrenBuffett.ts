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
  confidence: z.number().int().min(0).max(100),
  reasoning: z.string(),
});

function analyzeFundamentals(metrics: unknown[]): Record<string, unknown> {
  if (!metrics.length) return { score: 0, details: "Insufficient data" };
  const m0: any = metrics[0];
  let score = 0;
  const reasoning: string[] = [];

  if (m0.return_on_equity && m0.return_on_equity > 0.15) { score += 2; reasoning.push(`Strong ROE ${(m0.return_on_equity * 100).toFixed(1)}%`); }
  else if (m0.return_on_equity) { reasoning.push(`Weak ROE ${(m0.return_on_equity * 100).toFixed(1)}%`); }
  else { reasoning.push("ROE N/A"); }

  if (m0.debt_to_equity && m0.debt_to_equity < 0.5) { score += 2; reasoning.push("Conservative debt"); }
  else if (m0.debt_to_equity) { reasoning.push(`High D/E ${m0.debt_to_equity.toFixed(1)}`); }

  if (m0.operating_margin && m0.operating_margin > 0.15) { score += 2; reasoning.push("Strong operating margins"); }
  else if (m0.operating_margin) { reasoning.push(`Weak op margin ${(m0.operating_margin * 100).toFixed(1)}%`); }

  if (m0.current_ratio && m0.current_ratio > 1.5) { score += 1; reasoning.push("Good liquidity"); }
  else if (m0.current_ratio) { reasoning.push(`Weak liquidity CR ${m0.current_ratio.toFixed(1)}`); }

  return { score, details: reasoning.join("; ") };
}

function analyzeConsistency(lineItems: unknown[]): Record<string, unknown> {
  if (lineItems.length < 4) return { score: 0, details: "Insufficient historical data" };
  const earnings: number[] = lineItems.map((li: any) => li.net_income).filter((v: any): v is number => v != null);
  if (earnings.length < 4) return { score: 0, details: "Insufficient earnings data" };

  const growing = earnings.slice(0, -1).every((v, i) => v > earnings[i + 1]!);
  let score = 0;
  const reasoning: string[] = [];
  if (growing) { score += 3; reasoning.push("Consistent earnings growth"); }
  else { reasoning.push("Inconsistent earnings growth"); }

  if (earnings.length >= 2 && earnings[earnings.length - 1]! !== 0) {
    const growth = (earnings[0]! - earnings[earnings.length - 1]!) / Math.abs(earnings[earnings.length - 1]!);
    reasoning.push(`Total earnings growth ${(growth * 100).toFixed(1)}% over ${earnings.length} periods`);
  }
  return { score, details: reasoning.join("; ") };
}

function analyzeMoat(metrics: unknown[]): Record<string, unknown> {
  if (!metrics.length || metrics.length < 5) return { score: 0, max_score: 5, details: "Insufficient data" };
  let moatScore = 0;
  const reasoning: string[] = [];

  const roes: number[] = (metrics as any[]).map(m => m.return_on_equity).filter((v: any): v is number => v != null);
  if (roes.length >= 5) {
    const highRoePeriods = roes.filter(r => r > 0.15).length;
    const consistency = highRoePeriods / roes.length;
    if (consistency >= 0.8) { moatScore += 2; reasoning.push(`Excellent ROE consistency ${highRoePeriods}/${roes.length} periods`); }
    else if (consistency >= 0.6) { moatScore += 1; reasoning.push(`Good ROE ${highRoePeriods}/${roes.length} periods`); }
    else { reasoning.push(`Inconsistent ROE ${highRoePeriods}/${roes.length} periods`); }
  }

  const margins: number[] = (metrics as any[]).map(m => m.operating_margin).filter((v: any): v is number => v != null);
  if (margins.length >= 5) {
    const avg = margins.reduce((a, b) => a + b, 0) / margins.length;
    const recentAvg = margins.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
    const olderAvg = margins.slice(-3).reduce((a, b) => a + b, 0) / 3;
    if (avg > 0.20 && recentAvg >= olderAvg) { moatScore += 1; reasoning.push(`Strong stable margins avg ${(avg * 100).toFixed(1)}%`); }
    else if (avg > 0.15) { reasoning.push(`Decent margins avg ${(avg * 100).toFixed(1)}%`); }
  }

  if (moatScore >= 3) { moatScore = Math.min(moatScore, 5); reasoning.push("Strong moat indicators"); }
  return { score: moatScore, max_score: 5, details: reasoning.join("; ") };
}

function analyzePricingPower(lineItems: unknown[], metrics: unknown[]): Record<string, unknown> {
  if (!lineItems.length || !metrics.length) return { score: 0, details: "Insufficient data" };
  let score = 0;
  const reasoning: string[] = [];

  const grossMargins: number[] = lineItems.map((li: any) => li.gross_margin).filter((v: any): v is number => v != null);
  if (grossMargins.length >= 3) {
    const recentAvg = grossMargins.slice(0, 2).reduce((a, b) => a + b, 0) / 2;
    const olderAvg = grossMargins.slice(-2).reduce((a, b) => a + b, 0) / 2;
    if (recentAvg > olderAvg + 0.02) { score += 3; reasoning.push("Expanding gross margins - strong pricing power"); }
    else if (recentAvg > olderAvg) { score += 2; reasoning.push("Improving gross margins"); }
    else if (Math.abs(recentAvg - olderAvg) < 0.01) { score += 1; reasoning.push("Stable margins"); }
    else { reasoning.push("Declining margins"); }
  }

  if (grossMargins.length) {
    const avg = grossMargins.reduce((a, b) => a + b, 0) / grossMargins.length;
    if (avg > 0.50) { score += 2; reasoning.push(`High gross margin ${(avg * 100).toFixed(1)}%`); }
    else if (avg > 0.30) { score += 1; reasoning.push(`Good gross margin ${(avg * 100).toFixed(1)}%`); }
  }

  return { score, details: reasoning.join("; ") };
}

function analyzeBookValueGrowth(lineItems: unknown[]): Record<string, unknown> {
  if (lineItems.length < 3) return { score: 0, details: "Insufficient data" };
  const bookValues: number[] = lineItems.map((li: any) => {
    const equity = li.shareholders_equity;
    const shares = li.outstanding_shares;
    return equity && shares && shares > 0 ? equity / shares : null;
  }).filter((v): v is number => v != null);

  if (bookValues.length < 3) return { score: 0, details: "Insufficient book value data" };
  let score = 0;
  const reasoning: string[] = [];

  const growthPeriods = bookValues.slice(0, -1).filter((v, i) => v > bookValues[i + 1]!).length;
  const growthRate = growthPeriods / (bookValues.length - 1);
  if (growthRate >= 0.8) { score += 3; reasoning.push("Consistent BV/share growth"); }
  else if (growthRate >= 0.6) { score += 2; reasoning.push("Good BV/share growth"); }
  else if (growthRate >= 0.4) { score += 1; reasoning.push("Moderate BV growth"); }
  else { reasoning.push("Inconsistent BV growth"); }

  const oldest = bookValues[bookValues.length - 1]!;
  const latest = bookValues[0]!;
  const years = bookValues.length - 1;
  if (oldest > 0 && latest > 0) {
    const cagr = (latest / oldest) ** (1 / years) - 1;
    if (cagr > 0.15) { score += 2; reasoning.push(`Excellent BV CAGR ${(cagr * 100).toFixed(1)}%`); }
    else if (cagr > 0.10) { score += 1; reasoning.push(`Good BV CAGR ${(cagr * 100).toFixed(1)}%`); }
    else { reasoning.push(`BV CAGR ${(cagr * 100).toFixed(1)}%`); }
  } else if (oldest < 0 && latest > 0) { score += 3; reasoning.push("Excellent: from negative to positive BV"); }

  return { score, details: reasoning.join("; ") };
}

function analyzeManagementQuality(lineItems: unknown[]): Record<string, unknown> {
  if (!lineItems.length) return { score: 0, max_score: 3, details: "Insufficient data" };
  let score = 0;
  const reasoning: string[] = [];

  const shares: number[] = lineItems.map((li: any) => li.outstanding_shares).filter((v: any): v is number => v != null);
  if (shares.length >= 2) {
    if (shares[0]! < shares[shares.length - 1]!) { score += 1; reasoning.push("Share count decreased (buybacks)"); }
    else if (shares[0]! > shares[shares.length - 1]! * 1.05) { reasoning.push("Share dilution detected"); }
    else { reasoning.push("Share count relatively stable"); }
  }

  const fcfs: number[] = lineItems.map((li: any) => li.free_cash_flow).filter((v: any): v is number => v != null);
  if (fcfs.length) {
    const posFcf = fcfs.filter(v => v > 0).length;
    if (posFcf === fcfs.length) { score += 1; reasoning.push("Consistent positive FCF generation"); }
    else { reasoning.push(`FCF positive ${posFcf}/${fcfs.length} periods`); }
  }

  const divs: number[] = lineItems.map((li: any) => li.dividends_and_other_cash_distributions).filter((v: any): v is number => v != null);
  if (divs.length && divs.filter(d => d < 0).length >= Math.floor(divs.length / 2) + 1) { score += 1; reasoning.push("Consistent dividends paid"); }

  return { score, max_score: 3, details: reasoning.join("; ") };
}

function calculateIntrinsicValue(lineItems: unknown[]): Record<string, unknown> {
  const details: string[] = [];
  if (!lineItems.length) return { intrinsic_value: null, details: ["Insufficient data"] };

  const li0: any = lineItems[0];
  const netIncome: number | null = li0.net_income ?? null;
  const capex: number | null = li0.capital_expenditure ?? null;
  const da: number | null = li0.depreciation_and_amortization ?? null;

  if (!netIncome || netIncome <= 0) return { intrinsic_value: null, details: ["No positive net income"] };

  const ownerEarnings = netIncome + (da ?? 0) - Math.abs(capex ?? 0) * 0.75;
  if (ownerEarnings <= 0) return { intrinsic_value: null, details: ["Negative owner earnings"] };

  const historicalEarnings: number[] = lineItems.slice(0, 5).map((li: any) => li.net_income).filter((v: any): v is number => v != null && v > 0);
  let conservativeGrowth = 0.03;
  if (historicalEarnings.length >= 3) {
    const oldest = historicalEarnings[historicalEarnings.length - 1]!;
    const latest = historicalEarnings[0]!;
    const years = historicalEarnings.length - 1;
    if (oldest > 0) {
      const histGrowth = (latest / oldest) ** (1 / years) - 1;
      conservativeGrowth = Math.max(-0.05, Math.min(histGrowth, 0.15)) * 0.7;
    }
  }

  const s1Growth = Math.min(conservativeGrowth, 0.08);
  const s2Growth = Math.min(conservativeGrowth * 0.5, 0.04);
  const terminalGrowth = 0.025;
  const dr = 0.10;

  let s1Pv = 0;
  for (let yr = 1; yr <= 5; yr++) s1Pv += ownerEarnings * (1 + s1Growth) ** yr / (1 + dr) ** yr;

  const s1Final = ownerEarnings * (1 + s1Growth) ** 5;
  let s2Pv = 0;
  for (let yr = 1; yr <= 5; yr++) s2Pv += s1Final * (1 + s2Growth) ** yr / (1 + dr) ** (5 + yr);

  const finalEarnings = s1Final * (1 + s2Growth) ** 5;
  const tv = finalEarnings * (1 + terminalGrowth) / (dr - terminalGrowth);
  const tvPv = tv / (1 + dr) ** 10;

  const intrinsicValue = (s1Pv + s2Pv + tvPv) * 0.85;
  details.push(`Owner earnings: $${ownerEarnings.toLocaleString()}`, `Stage1 growth: ${(s1Growth * 100).toFixed(1)}%`, `Conservative IV: $${intrinsicValue.toLocaleString()}`);

  return { intrinsic_value: intrinsicValue, owner_earnings: ownerEarnings, assumptions: { s1_growth: s1Growth, s2_growth: s2Growth, terminal_growth: terminalGrowth, discount_rate: dr }, details };
}

export async function warrenBuffettAgent(
  state: AgentState,
  agentId = "warren_buffett_agent"
): Promise<Partial<AgentState>> {
  const data = state.data as Record<string, unknown>;
  const endDate = data["end_date"] as string;
  const tickers = data["tickers"] as string[];
  const apiKey = getApiKeyFromState(state, "FINANCIAL_DATASETS_API_KEY");

  const buffettAnalysis: Record<string, unknown> = {};

  for (const ticker of tickers) {
    progress.updateStatus(agentId, ticker, "Fetching financial metrics");
    const metrics = await getFinancialMetrics(ticker, endDate, "ttm", 10, apiKey);

    progress.updateStatus(agentId, ticker, "Gathering financial line items");
    const lineItems = await searchLineItems(ticker,
      ["capital_expenditure", "depreciation_and_amortization", "net_income", "outstanding_shares",
       "total_assets", "total_liabilities", "shareholders_equity", "dividends_and_other_cash_distributions",
       "issuance_or_purchase_of_equity_shares", "gross_profit", "revenue", "free_cash_flow", "gross_margin"],
      endDate, "ttm", 10, apiKey);

    progress.updateStatus(agentId, ticker, "Getting market cap");
    const marketCap = await getMarketCap(ticker, endDate, apiKey);

    const fundamentalAnalysis = analyzeFundamentals(metrics);
    const consistencyAnalysis = analyzeConsistency(lineItems);
    const moatAnalysis = analyzeMoat(metrics);
    const pricingPowerAnalysis = analyzePricingPower(lineItems, metrics);
    const bookValueAnalysis = analyzeBookValueGrowth(lineItems);
    const mgmtAnalysis = analyzeManagementQuality(lineItems);
    const intrinsicValueAnalysis = calculateIntrinsicValue(lineItems);

    const totalScore = (fundamentalAnalysis["score"] as number) + (consistencyAnalysis["score"] as number) + (moatAnalysis["score"] as number) + (mgmtAnalysis["score"] as number) + (pricingPowerAnalysis["score"] as number) + (bookValueAnalysis["score"] as number);
    const maxScore = 10 + (moatAnalysis["max_score"] as number) + (mgmtAnalysis["max_score"] as number) + 5 + 5;

    const intrinsicValue = intrinsicValueAnalysis["intrinsic_value"] as number | null;
    const marginOfSafety = intrinsicValue && marketCap ? (intrinsicValue - marketCap) / marketCap : null;

    const analysisData = { ticker, score: totalScore, max_score: maxScore, fundamental_analysis: fundamentalAnalysis, consistency_analysis: consistencyAnalysis, moat_analysis: moatAnalysis, pricing_power_analysis: pricingPowerAnalysis, book_value_analysis: bookValueAnalysis, management_analysis: mgmtAnalysis, intrinsic_value_analysis: intrinsicValueAnalysis, market_cap: marketCap, margin_of_safety: marginOfSafety };

    progress.updateStatus(agentId, ticker, "Generating Warren Buffett analysis");
    const facts = { score: totalScore, max_score: maxScore, fundamentals: fundamentalAnalysis["details"], consistency: consistencyAnalysis["details"], moat: moatAnalysis["details"], pricing_power: pricingPowerAnalysis["details"], book_value: bookValueAnalysis["details"], management: mgmtAnalysis["details"], intrinsic_value: intrinsicValue, market_cap: marketCap, margin_of_safety: marginOfSafety };

    const template = ChatPromptTemplate.fromMessages([
      ["system", "You are Warren Buffett. Decide bullish, bearish, or neutral using only the provided facts.\n\nChecklist: Circle of competence, Competitive moat, Management quality, Financial strength, Valuation vs intrinsic value, Long-term prospects.\n\nSignal rules:\n- Bullish: strong business AND margin_of_safety > 0.\n- Bearish: poor business OR clearly overvalued.\n- Neutral: good business but margin_of_safety <= 0, or mixed evidence.\n\nKeep reasoning under 120 characters. Return JSON only."],
      ["human", "Ticker: {ticker}\nFacts:\n{facts}\n\nReturn exactly:\n{{\n  \"signal\": \"bullish\" | \"bearish\" | \"neutral\",\n  \"confidence\": int,\n  \"reasoning\": \"short justification\"\n}}"],
    ]);
    const prompt = await template.invoke({ facts: JSON.stringify(facts), ticker });
    const result = await callLlm(prompt, SignalSchema, {
      agentName: agentId, state,
      defaultFactory: () => ({ signal: "neutral" as const, confidence: 50, reasoning: "Insufficient data" }),
    });

    buffettAnalysis[ticker] = { signal: result?.signal ?? "neutral", confidence: result?.confidence ?? 50, reasoning: result?.reasoning ?? "" };
    progress.updateStatus(agentId, ticker, "Done", result?.reasoning);
  }

  const message = new HumanMessage({ content: JSON.stringify(buffettAnalysis), name: agentId });
  if ((state.metadata as Record<string, unknown>)["show_reasoning"]) showAgentReasoning(buffettAnalysis, agentId);

  const existingSignals = (data["analyst_signals"] as Record<string, unknown>) ?? {};
  data["analyst_signals"] = { ...existingSignals, [agentId]: buffettAnalysis };
  progress.updateStatus(agentId, null, "Done");
  return { messages: [message], data };
}
