import { HumanMessage } from "@langchain/core/messages";
import type { AgentState } from "../graph/state.js";
import { showAgentReasoning } from "../graph/state.js";
import { getApiKeyFromState } from "../utils/apiKey.js";
import { progress } from "../utils/progress.js";
import { getFinancialMetrics, searchLineItems, getMarketCap } from "../tools/api.js";

function calculateOwnerEarningsValue(
  netIncome: number | null,
  depreciation: number | null,
  capex: number | null,
  workingCapitalChange: number | null,
  growthRate = 0.05,
  requiredReturn = 0.15,
  marginOfSafety = 0.25,
  numYears = 5,
): number {
  if (netIncome == null || depreciation == null || capex == null || workingCapitalChange == null) return 0;
  const ownerEarnings = netIncome + depreciation - capex - workingCapitalChange;
  if (ownerEarnings <= 0) return 0;

  let pv = 0.0;
  for (let yr = 1; yr <= numYears; yr++) {
    const future = ownerEarnings * (1 + growthRate) ** yr;
    pv += future / (1 + requiredReturn) ** yr;
  }

  const terminalGrowth = Math.min(growthRate, 0.03);
  const termVal = (ownerEarnings * (1 + growthRate) ** numYears * (1 + terminalGrowth)) /
    (requiredReturn - terminalGrowth);
  const pvTerm = termVal / (1 + requiredReturn) ** numYears;

  return (pv + pvTerm) * (1 - marginOfSafety);
}

function calculateIntrinsicValue(
  freeCashFlow: number | null,
  growthRate = 0.05,
  discountRate = 0.10,
  terminalGrowthRate = 0.02,
  numYears = 5,
): number {
  if (freeCashFlow == null || freeCashFlow <= 0) return 0;

  let pv = 0.0;
  for (let yr = 1; yr <= numYears; yr++) {
    const fcft = freeCashFlow * (1 + growthRate) ** yr;
    pv += fcft / (1 + discountRate) ** yr;
  }

  const termVal = (freeCashFlow * (1 + growthRate) ** numYears * (1 + terminalGrowthRate)) /
    (discountRate - terminalGrowthRate);
  const pvTerm = termVal / (1 + discountRate) ** numYears;

  return pv + pvTerm;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function calculateEvEbitdaValue(financialMetrics: any[]): number {
  if (!financialMetrics.length) return 0;
  const m0 = financialMetrics[0];
  if (!m0.enterprise_value || !m0.enterprise_value_to_ebitda_ratio) return 0;
  if (m0.enterprise_value_to_ebitda_ratio === 0) return 0;

  const ebitdaNow = m0.enterprise_value / m0.enterprise_value_to_ebitda_ratio;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ratios = financialMetrics
    .filter((m: any) => m.enterprise_value_to_ebitda_ratio)
    .map((m: any) => m.enterprise_value_to_ebitda_ratio as number);
  const sorted = [...ratios].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medMult = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  const evImplied = medMult * ebitdaNow;
  const netDebt = (m0.enterprise_value ?? 0) - (m0.market_cap ?? 0);
  return Math.max(evImplied - netDebt, 0);
}

function calculateResidualIncomeValue(
  marketCap: number | null,
  netIncome: number | null,
  priceToBookRatio: number | null,
  bookValueGrowth = 0.03,
  costOfEquity = 0.10,
  terminalGrowthRate = 0.03,
  numYears = 5,
): number {
  if (!marketCap || !netIncome || !priceToBookRatio || priceToBookRatio <= 0) return 0;

  const bookVal = marketCap / priceToBookRatio;
  const ri0 = netIncome - costOfEquity * bookVal;
  if (ri0 <= 0) return 0;

  let pvRi = 0.0;
  for (let yr = 1; yr <= numYears; yr++) {
    const riT = ri0 * (1 + bookValueGrowth) ** yr;
    pvRi += riT / (1 + costOfEquity) ** yr;
  }

  const termRi = ri0 * (1 + bookValueGrowth) ** (numYears + 1) / (costOfEquity - terminalGrowthRate);
  const pvTerm = termRi / (1 + costOfEquity) ** numYears;

  return (bookVal + pvRi + pvTerm) * 0.8;
}

function calculateWacc(
  marketCap: number,
  totalDebt: number | null,
  cash: number | null,
  interestCoverage: number | null,
  _debtToEquity: number | null,
  betaProxy = 1.0,
  riskFreeRate = 0.045,
  marketRiskPremium = 0.06,
): number {
  const costOfEquity = riskFreeRate + betaProxy * marketRiskPremium;

  let costOfDebt: number;
  if (interestCoverage && interestCoverage > 0) {
    costOfDebt = Math.max(riskFreeRate + 0.01, riskFreeRate + 10 / interestCoverage);
  } else {
    costOfDebt = riskFreeRate + 0.05;
  }

  const netDebt = Math.max((totalDebt ?? 0) - (cash ?? 0), 0);
  const totalValue = marketCap + netDebt;

  let wacc: number;
  if (totalValue > 0) {
    const weightEquity = marketCap / totalValue;
    const weightDebt = netDebt / totalValue;
    wacc = weightEquity * costOfEquity + weightDebt * costOfDebt * 0.75;
  } else {
    wacc = costOfEquity;
  }

  return Math.min(Math.max(wacc, 0.06), 0.20);
}

function calculateFcfVolatility(fcfHistory: number[]): number {
  if (fcfHistory.length < 3) return 0.5;
  const positiveFcf = fcfHistory.filter(f => f > 0);
  if (positiveFcf.length < 2) return 0.8;

  const meanFcf = positiveFcf.reduce((a, b) => a + b, 0) / positiveFcf.length;
  const variance = positiveFcf.reduce((acc, v) => acc + (v - meanFcf) ** 2, 0) / positiveFcf.length;
  const stdFcf = Math.sqrt(variance);
  return meanFcf > 0 ? Math.min(stdFcf / meanFcf, 1.0) : 0.8;
}

function calculateEnhancedDcfValue(
  fcfHistory: number[],
  _growthMetrics: Record<string, unknown>,
  wacc: number,
  marketCap: number,
  revenueGrowth?: number | null,
): number {
  if (!fcfHistory.length || fcfHistory[0]! <= 0) return 0;

  const fcfCurrent = fcfHistory[0]!;
  const fcfAvg3yr = fcfHistory.slice(0, 3).reduce((a, b) => a + b, 0) / Math.min(3, fcfHistory.length);
  const fcfVolatility = calculateFcfVolatility(fcfHistory);

  let highGrowth = Math.min(revenueGrowth ?? 0.05, 0.25);
  if (marketCap > 50_000_000_000) highGrowth = Math.min(highGrowth, 0.10);

  const transitionGrowth = (highGrowth + 0.03) / 2;
  let terminalGrowth = Math.min(0.03, highGrowth * 0.6);

  let pv = 0;
  const baseFcf = Math.max(fcfCurrent, fcfAvg3yr * 0.85);

  for (let year = 1; year <= 3; year++) {
    const fcfProjected = baseFcf * (1 + highGrowth) ** year;
    pv += fcfProjected / (1 + wacc) ** year;
  }

  for (let year = 4; year <= 7; year++) {
    const transitionRate = transitionGrowth * (8 - year) / 4;
    const fcfProjected = baseFcf * (1 + highGrowth) ** 3 * (1 + transitionRate) ** (year - 3);
    pv += fcfProjected / (1 + wacc) ** year;
  }

  const finalFcf = baseFcf * (1 + highGrowth) ** 3 * (1 + transitionGrowth) ** 4;
  if (wacc <= terminalGrowth) terminalGrowth = wacc * 0.8;
  const terminalValue = (finalFcf * (1 + terminalGrowth)) / (wacc - terminalGrowth);
  const pvTerminal = terminalValue / (1 + wacc) ** 7;

  const qualityFactor = Math.max(0.7, 1 - fcfVolatility * 0.5);
  return (pv + pvTerminal) * qualityFactor;
}

function calculateDcfScenarios(
  fcfHistory: number[],
  growthMetrics: Record<string, unknown>,
  wacc: number,
  marketCap: number,
  revenueGrowth?: number | null,
): { scenarios: Record<string, number>; expected_value: number; range: number; upside: number; downside: number } {
  const scenarios = {
    bear: { growth_adj: 0.5, wacc_adj: 1.2 },
    base: { growth_adj: 1.0, wacc_adj: 1.0 },
    bull: { growth_adj: 1.5, wacc_adj: 0.9 },
  };

  const baseRevenueGrowth = revenueGrowth ?? 0.05;
  const results: Record<string, number> = {};

  for (const [scenario, adjustments] of Object.entries(scenarios)) {
    results[scenario] = calculateEnhancedDcfValue(
      fcfHistory,
      growthMetrics,
      wacc * adjustments.wacc_adj,
      marketCap,
      baseRevenueGrowth * adjustments.growth_adj,
    );
  }

  const expectedValue = (results["bear"]! * 0.2 + results["base"]! * 0.6 + results["bull"]! * 0.2);
  return {
    scenarios: results,
    expected_value: expectedValue,
    range: results["bull"]! - results["bear"]!,
    upside: results["bull"]!,
    downside: results["bear"]!,
  };
}

export async function valuationAnalystAgent(
  state: AgentState,
  agentId = "valuation_analyst_agent"
): Promise<Partial<AgentState>> {
  const data = state.data as Record<string, unknown>;
  const endDate = data["end_date"] as string;
  const tickers = data["tickers"] as string[];
  const apiKey = getApiKeyFromState(state, "FINANCIAL_DATASETS_API_KEY");

  const valuationAnalysis: Record<string, unknown> = {};

  for (const ticker of tickers) {
    progress.updateStatus(agentId, ticker, "Fetching financial data");

    const financialMetrics = await getFinancialMetrics(ticker, endDate, "ttm", 8, apiKey);
    if (!financialMetrics.length) {
      progress.updateStatus(agentId, ticker, "Failed: No financial metrics found");
      continue;
    }
    const mostRecentMetrics = financialMetrics[0]!;

    progress.updateStatus(agentId, ticker, "Gathering comprehensive line items");
    const lineItems = await searchLineItems(
      ticker,
      ["free_cash_flow", "net_income", "depreciation_and_amortization", "capital_expenditure",
       "working_capital", "total_debt", "cash_and_equivalents", "interest_expense",
       "revenue", "operating_income", "ebit", "ebitda"],
      endDate, "ttm", 8, apiKey,
    );

    if (lineItems.length < 2) {
      progress.updateStatus(agentId, ticker, "Failed: Insufficient financial line items");
      continue;
    }

    const liCurr = lineItems[0] as Record<string, unknown>;
    const liPrev = lineItems[1] as Record<string, unknown>;

    const wcChange = (liCurr["working_capital"] != null && liPrev["working_capital"] != null)
      ? (liCurr["working_capital"] as number) - (liPrev["working_capital"] as number)
      : 0;

    const ownerVal = calculateOwnerEarningsValue(
      liCurr["net_income"] as number | null,
      liCurr["depreciation_and_amortization"] as number | null,
      liCurr["capital_expenditure"] as number | null,
      wcChange, mostRecentMetrics.earnings_growth ?? 0.05,
    );

    progress.updateStatus(agentId, ticker, "Calculating WACC and enhanced DCF");
    const wacc = calculateWacc(
      mostRecentMetrics.market_cap ?? 0,
      liCurr["total_debt"] as number | null,
      liCurr["cash_and_equivalents"] as number | null,
      mostRecentMetrics.interest_coverage,
      mostRecentMetrics.debt_to_equity,
    );

    const fcfHistory: number[] = lineItems
      .map((li) => (li as Record<string, unknown>)["free_cash_flow"] as number | null)
      .filter((f): f is number => f != null && f > 0);

    const dcfResults = calculateDcfScenarios(
      fcfHistory,
      { revenue_growth: mostRecentMetrics.revenue_growth, fcf_growth: mostRecentMetrics.free_cash_flow_growth, earnings_growth: mostRecentMetrics.earnings_growth },
      wacc, mostRecentMetrics.market_cap ?? 0, mostRecentMetrics.revenue_growth,
    );
    const dcfVal = dcfResults.expected_value;

    const evEbitdaVal = calculateEvEbitdaValue(financialMetrics);
    const rimVal = calculateResidualIncomeValue(
      mostRecentMetrics.market_cap,
      liCurr["net_income"] as number | null,
      mostRecentMetrics.price_to_book_ratio,
      mostRecentMetrics.book_value_growth ?? 0.03,
    );

    const marketCap = await getMarketCap(ticker, endDate, apiKey);
    if (!marketCap) {
      progress.updateStatus(agentId, ticker, "Failed: Market cap unavailable");
      continue;
    }

    const methodValues: Record<string, { value: number; weight: number; gap?: number | null }> = {
      dcf: { value: dcfVal, weight: 0.35 },
      owner_earnings: { value: ownerVal, weight: 0.35 },
      ev_ebitda: { value: evEbitdaVal, weight: 0.20 },
      residual_income: { value: rimVal, weight: 0.10 },
    };

    const totalWeight = Object.values(methodValues).filter(v => v.value > 0).reduce((acc, v) => acc + v.weight, 0);
    if (totalWeight === 0) {
      progress.updateStatus(agentId, ticker, "Failed: All valuation methods zero");
      continue;
    }

    for (const v of Object.values(methodValues)) {
      v.gap = v.value > 0 ? (v.value - marketCap) / marketCap : null;
    }

    const weightedGap = Object.values(methodValues)
      .filter(v => v.gap != null)
      .reduce((acc, v) => acc + v.weight * v.gap!, 0) / totalWeight;

    const signal = weightedGap > 0.15 ? "bullish" : weightedGap < -0.15 ? "bearish" : "neutral";
    const confidence = Math.round(Math.min(Math.abs(weightedGap) / 0.30 * 100, 100));

    const reasoning: Record<string, unknown> = {};
    for (const [m, vals] of Object.entries(methodValues)) {
      if (vals.value > 0) {
        const gapPct = ((vals.gap ?? 0) * 100).toFixed(1);
        let details = `Value: $${vals.value.toLocaleString("en-US", { maximumFractionDigits: 0 })}, Market Cap: $${marketCap.toLocaleString("en-US", { maximumFractionDigits: 0 })}, Gap: ${gapPct}%, Weight: ${(vals.weight * 100).toFixed(0)}%`;
        if (m === "dcf") {
          details += `\n  WACC: ${(wacc * 100).toFixed(1)}%, Bear: $${dcfResults.downside.toLocaleString()}, Bull: $${dcfResults.upside.toLocaleString()}`;
        }
        reasoning[`${m}_analysis`] = {
          signal: vals.gap && vals.gap > 0.15 ? "bullish" : vals.gap && vals.gap < -0.15 ? "bearish" : "neutral",
          details,
        };
      }
    }

    reasoning["dcf_scenario_analysis"] = {
      bear_case: `$${dcfResults.downside.toLocaleString()}`,
      base_case: `$${(dcfResults.scenarios["base"] ?? 0).toLocaleString()}`,
      bull_case: `$${dcfResults.upside.toLocaleString()}`,
      wacc_used: `${(wacc * 100).toFixed(1)}%`,
      fcf_periods_analyzed: fcfHistory.length,
    };

    valuationAnalysis[ticker] = { signal, confidence, reasoning };
    progress.updateStatus(agentId, ticker, "Done", JSON.stringify(reasoning, null, 4));
  }

  const message = new HumanMessage({ content: JSON.stringify(valuationAnalysis), name: agentId });

  if ((state.metadata as Record<string, unknown>)["show_reasoning"]) {
    showAgentReasoning(valuationAnalysis, "Valuation Analysis Agent");
  }

  const existingSignals = (data["analyst_signals"] as Record<string, unknown>) ?? {};
  data["analyst_signals"] = { ...existingSignals, [agentId]: valuationAnalysis };

  progress.updateStatus(agentId, null, "Done");

  return { messages: [message], data };
}
