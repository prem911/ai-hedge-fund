import { HumanMessage } from "@langchain/core/messages";
import type { AgentState } from "../graph/state.js";
import { showAgentReasoning } from "../graph/state.js";
import { getApiKeyFromState } from "../utils/apiKey.js";
import { progress } from "../utils/progress.js";
import { getPrices } from "../tools/api.js";

// ---- Pure TypeScript technical indicators ----

export function calculateEma(prices: number[], period: number): number[] {
  if (prices.length < period) return [];
  const k = 2 / (period + 1);
  const result: number[] = new Array(prices.length).fill(NaN);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = ema;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i]! * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

export function calculateRsi(prices: number[], period = 14): number[] {
  if (prices.length < period + 1) return [];
  const result: number[] = new Array(prices.length).fill(NaN);
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i <= period; i++) {
    const diff = prices[i]! - prices[i - 1]!;
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }
  let avgGain = gains.reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.reduce((a, b) => a + b, 0) / period;
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result[period] = 100 - 100 / (1 + rs);
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i]! - prices[i - 1]!;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = 100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss));
  }
  return result;
}

export function calculateBollingerBands(prices: number[], period = 20, stdMult = 2): { upper: number[]; middle: number[]; lower: number[] } {
  const upper: number[] = new Array(prices.length).fill(NaN);
  const middle: number[] = new Array(prices.length).fill(NaN);
  const lower: number[] = new Array(prices.length).fill(NaN);
  for (let i = period - 1; i < prices.length; i++) {
    const window = prices.slice(i - period + 1, i + 1);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(window.reduce((acc, v) => acc + (v - mean) ** 2, 0) / period);
    middle[i] = mean;
    upper[i] = mean + stdMult * std;
    lower[i] = mean - stdMult * std;
  }
  return { upper, middle, lower };
}

export function calculateAtr(highs: number[], lows: number[], closes: number[], period = 14): number[] {
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const hl = highs[i]! - lows[i]!;
    const hc = Math.abs(highs[i]! - closes[i - 1]!);
    const lc = Math.abs(lows[i]! - closes[i - 1]!);
    trs.push(Math.max(hl, hc, lc));
  }
  const result: number[] = new Array(highs.length).fill(NaN);
  if (trs.length < period) return result;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period] = atr;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]!) / period;
    result[i + 1] = atr;
  }
  return result;
}

export function calculateAdx(highs: number[], lows: number[], closes: number[], period = 14): number[] {
  const result: number[] = new Array(highs.length).fill(NaN);
  if (highs.length < period * 2) return result;

  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const high = highs[i]!;
    const low = lows[i]!;
    const prevHigh = highs[i - 1]!;
    const prevLow = lows[i - 1]!;
    const prevClose = closes[i - 1]!;

    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    const plusDM = high - prevHigh > prevLow - low ? Math.max(high - prevHigh, 0) : 0;
    const minusDM = prevLow - low > high - prevHigh ? Math.max(prevLow - low, 0) : 0;
    trs.push(tr);
    plusDMs.push(plusDM);
    minusDMs.push(minusDM);
  }

  let smTr = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let smPlus = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let smMinus = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  const dxValues: number[] = [];

  for (let i = period; i < trs.length; i++) {
    smTr = smTr - smTr / period + trs[i]!;
    smPlus = smPlus - smPlus / period + plusDMs[i]!;
    smMinus = smMinus - smMinus / period + minusDMs[i]!;
    const plusDI = smTr > 0 ? (smPlus / smTr) * 100 : 0;
    const minusDI = smTr > 0 ? (smMinus / smTr) * 100 : 0;
    const sum = plusDI + minusDI;
    dxValues.push(sum > 0 ? (Math.abs(plusDI - minusDI) / sum) * 100 : 0);
  }

  if (dxValues.length < period) return result;
  let adx = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period * 2] = adx;
  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]!) / period;
    result[period + i + 1] = adx;
  }
  return result;
}

export function calculateHurstExponent(prices: number[], maxLag = 20): number {
  if (prices.length < maxLag * 2) return 0.5;
  const lags = Array.from({ length: maxLag - 1 }, (_, i) => i + 2);
  const tau: number[] = lags.map(lag => {
    const diffs: number[] = [];
    for (let i = lag; i < prices.length; i++) {
      diffs.push(Math.abs(prices[i]! - prices[i - lag]!));
    }
    return diffs.reduce((a, b) => a + b, 0) / diffs.length;
  });

  const logLags = lags.map(l => Math.log(l));
  const logTau = tau.map(t => Math.log(Math.max(t, 1e-10)));
  const n = logLags.length;
  const sumX = logLags.reduce((a, b) => a + b, 0);
  const sumY = logTau.reduce((a, b) => a + b, 0);
  const sumXY = logLags.reduce((acc, x, i) => acc + x * logTau[i]!, 0);
  const sumX2 = logLags.reduce((acc, x) => acc + x * x, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0.5;
  return (n * sumXY - sumX * sumY) / denom;
}

// ---- Signal calculation functions ----

export function calculateTrendSignals(closes: number[], highs: number[], lows: number[]): Record<string, unknown> {
  if (closes.length < 50) return { signal: "neutral", confidence: 0, metrics: {} };

  const ema8 = calculateEma(closes, 8);
  const ema21 = calculateEma(closes, 21);
  const ema50 = calculateEma(closes, 50);
  const adx = calculateAdx(highs, lows, closes, 14);

  const last = closes.length - 1;
  const lastEma8 = ema8[last];
  const lastEma21 = ema21[last];
  const lastEma50 = ema50[last];
  const lastAdx = adx.filter(v => !isNaN(v)).at(-1) ?? 0;
  const price = closes[last]!;

  let score = 0;
  if (lastEma8 != null && !isNaN(lastEma8) && lastEma8 > (lastEma21 ?? 0)) score++;
  if (lastEma21 != null && !isNaN(lastEma21) && lastEma21 > (lastEma50 ?? 0)) score++;
  if (price > (lastEma21 ?? 0)) score++;
  if (lastAdx > 25) score++;

  const signal = score >= 3 ? "bullish" : score <= 1 ? "bearish" : "neutral";
  const confidence = score / 4;
  return { signal, confidence, metrics: { ema8: lastEma8, ema21: lastEma21, ema50: lastEma50, adx: lastAdx } };
}

export function calculateMeanReversionSignals(closes: number[]): Record<string, unknown> {
  if (closes.length < 20) return { signal: "neutral", confidence: 0, metrics: {} };

  const bb = calculateBollingerBands(closes, 20, 2);
  const rsi14 = calculateRsi(closes, 14);
  const last = closes.length - 1;
  const price = closes[last]!;
  const upper = bb.upper[last];
  const lower = bb.lower[last];
  const middle = bb.middle[last];
  const rsi = rsi14[last];

  if (upper == null || lower == null || middle == null || upper === lower) return { signal: "neutral", confidence: 0 };
  const bbPos = (price - lower) / (upper - lower);

  let signal: string;
  let confidence: number;
  if (bbPos < 0.2 && rsi != null && rsi < 35) { signal = "bullish"; confidence = 0.8; }
  else if (bbPos > 0.8 && rsi != null && rsi > 65) { signal = "bearish"; confidence = 0.8; }
  else if (bbPos < 0.35 && rsi != null && rsi < 45) { signal = "bullish"; confidence = 0.6; }
  else if (bbPos > 0.65 && rsi != null && rsi > 55) { signal = "bearish"; confidence = 0.6; }
  else { signal = "neutral"; confidence = 0.4; }

  return { signal, confidence, metrics: { bb_position: bbPos, rsi, upper, lower, middle, price } };
}

export function calculateMomentumSignals(closes: number[]): Record<string, unknown> {
  if (closes.length < 50) return { signal: "neutral", confidence: 0, metrics: {} };

  const last = closes.length - 1;
  const momentum20 = closes[last]! / closes[last - 20]! - 1;
  const momentum50 = closes[last]! / closes[last - 50]! - 1;
  const ema8 = calculateEma(closes, 8);
  const ema21 = calculateEma(closes, 21);
  const rsi7 = calculateRsi(closes, 7);

  let score = 0;
  if (momentum20 > 0.05) score++;
  if (momentum50 > 0.10) score++;
  if (ema8[last] != null && ema21[last] != null && !isNaN(ema8[last]!) && !isNaN(ema21[last]!) && ema8[last]! > ema21[last]!) score++;
  if (rsi7[last] != null && !isNaN(rsi7[last]!) && rsi7[last]! > 60) score++;

  const signal = score >= 3 ? "bullish" : score <= 1 ? "bearish" : "neutral";
  return { signal, confidence: score / 4, metrics: { momentum_20d: momentum20, momentum_50d: momentum50, rsi7: rsi7[last] } };
}

export function calculateVolatilitySignals(closes: number[], highs: number[], lows: number[]): Record<string, unknown> {
  if (closes.length < 20) return { signal: "neutral", confidence: 0, metrics: {} };

  const atr = calculateAtr(highs, lows, closes, 14);
  const lastValidAtr = atr.filter(v => !isNaN(v));
  if (!lastValidAtr.length) return { signal: "neutral", confidence: 0 };

  const currentAtr = lastValidAtr.at(-1)!;
  const avgAtr20 = lastValidAtr.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, lastValidAtr.length);
  const atrRatio = avgAtr20 > 0 ? currentAtr / avgAtr20 : 1;

  const bb = calculateBollingerBands(closes, 20, 2);
  const last = closes.length - 1;
  const upper = bb.upper[last];
  const lower = bb.lower[last];
  const bbWidth = (upper != null && lower != null && bb.middle[last] != null) ? (upper - lower) / bb.middle[last]! : 0;

  let signal: string;
  let confidence: number;
  if (atrRatio < 0.7 && bbWidth < 0.05) { signal = "bearish"; confidence = 0.7; }
  else if (atrRatio > 1.3 && bbWidth > 0.10) { signal = "bullish"; confidence = 0.6; }
  else { signal = "neutral"; confidence = 0.5; }

  return { signal, confidence, metrics: { atr_ratio: atrRatio, bb_width: bbWidth } };
}

export function calculateStatArbSignals(closes: number[]): Record<string, unknown> {
  if (closes.length < 50) return { signal: "neutral", confidence: 0, metrics: {} };
  const hurst = calculateHurstExponent(closes);
  let signal: string;
  let confidence: number;
  if (hurst < 0.4) { signal = "neutral"; confidence = 0.7; }
  else if (hurst > 0.6) { signal = "bullish"; confidence = 0.6; }
  else { signal = "neutral"; confidence = 0.4; }

  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) returns.push(closes[i]! / closes[i - 1]! - 1);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / returns.length);
  const zScore = std > 0 ? (closes[closes.length - 1]! / closes[closes.length - 2]! - 1 - mean) / std : 0;

  if (Math.abs(zScore) > 2.5) signal = zScore < 0 ? "bullish" : "bearish";

  return { signal, confidence, metrics: { hurst_exponent: hurst, z_score: zScore } };
}

export function weightedSignalCombination(signals: { signal: string; confidence: number; weight: number }[]): { signal: string; confidence: number } {
  let bullish = 0, bearish = 0, totalWeight = 0;
  for (const { signal, confidence, weight } of signals) {
    if (signal === "bullish") bullish += confidence * weight;
    else if (signal === "bearish") bearish += confidence * weight;
    totalWeight += weight;
  }
  if (totalWeight === 0) return { signal: "neutral", confidence: 0 };
  bullish /= totalWeight;
  bearish /= totalWeight;
  if (bullish > bearish && bullish > 0.3) return { signal: "bullish", confidence: bullish };
  if (bearish > bullish && bearish > 0.3) return { signal: "bearish", confidence: bearish };
  return { signal: "neutral", confidence: 0.5 };
}

export async function technicalAnalystAgent(
  state: AgentState,
  agentId = "technical_analyst_agent"
): Promise<Partial<AgentState>> {
  const data = state.data as Record<string, unknown>;
  const startDate = data["start_date"] as string;
  const endDate = data["end_date"] as string;
  const tickers = data["tickers"] as string[];
  const apiKey = getApiKeyFromState(state, "FINANCIAL_DATASETS_API_KEY");

  const technicalAnalysis: Record<string, unknown> = {};

  for (const ticker of tickers) {
    progress.updateStatus(agentId, ticker, "Fetching price data");
    const prices = await getPrices(ticker, startDate, endDate, apiKey);

    if (prices.length < 50) {
      progress.updateStatus(agentId, ticker, "Insufficient price data");
      technicalAnalysis[ticker] = { signal: "neutral", confidence: 0, reasoning: "Insufficient price data", strategy_signals: {} };
      continue;
    }

    const closes = prices.map(p => p.close);
    const highs = prices.map(p => p.high);
    const lows = prices.map(p => p.low);

    progress.updateStatus(agentId, ticker, "Calculating trend signals");
    const trend = calculateTrendSignals(closes, highs, lows);

    progress.updateStatus(agentId, ticker, "Calculating mean reversion signals");
    const meanReversion = calculateMeanReversionSignals(closes);

    progress.updateStatus(agentId, ticker, "Calculating momentum signals");
    const momentum = calculateMomentumSignals(closes);

    progress.updateStatus(agentId, ticker, "Calculating volatility signals");
    const volatility = calculateVolatilitySignals(closes, highs, lows);

    progress.updateStatus(agentId, ticker, "Calculating stat arb signals");
    const statArb = calculateStatArbSignals(closes);

    const weights = { trend: 0.25, mean_reversion: 0.20, momentum: 0.25, volatility: 0.15, stat_arb: 0.15 };
    const strategySignals = [
      { signal: trend["signal"] as string, confidence: trend["confidence"] as number, weight: weights.trend },
      { signal: meanReversion["signal"] as string, confidence: meanReversion["confidence"] as number, weight: weights.mean_reversion },
      { signal: momentum["signal"] as string, confidence: momentum["confidence"] as number, weight: weights.momentum },
      { signal: volatility["signal"] as string, confidence: volatility["confidence"] as number, weight: weights.volatility },
      { signal: statArb["signal"] as string, confidence: statArb["confidence"] as number, weight: weights.stat_arb },
    ];

    const { signal, confidence } = weightedSignalCombination(strategySignals);
    const confidencePct = Math.round(confidence * 100);

    const reasoning = `Technical analysis: Trend=${trend["signal"]}, MeanReversion=${meanReversion["signal"]}, Momentum=${momentum["signal"]}, Volatility=${volatility["signal"]}, StatArb=${statArb["signal"]}. Weighted signal: ${signal} (${confidencePct}%)`;

    technicalAnalysis[ticker] = {
      signal,
      confidence: confidencePct,
      reasoning,
      strategy_signals: { trend, mean_reversion: meanReversion, momentum, volatility, stat_arb: statArb },
    };

    progress.updateStatus(agentId, ticker, "Done", reasoning);
  }

  const message = new HumanMessage({ content: JSON.stringify(technicalAnalysis), name: agentId });
  if ((state.metadata as Record<string, unknown>)["show_reasoning"]) showAgentReasoning(technicalAnalysis, "Technical Analyst Agent");

  const existingSignals = (data["analyst_signals"] as Record<string, unknown>) ?? {};
  data["analyst_signals"] = { ...existingSignals, [agentId]: technicalAnalysis };
  progress.updateStatus(agentId, null, "Done");
  return { messages: [message], data };
}
