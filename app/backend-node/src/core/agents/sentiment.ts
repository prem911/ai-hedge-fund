import { HumanMessage } from "@langchain/core/messages";
import type { AgentState } from "../graph/state.js";
import { showAgentReasoning } from "../graph/state.js";
import { getApiKeyFromState } from "../utils/apiKey.js";
import { progress } from "../utils/progress.js";
import { getInsiderTrades, getCompanyNews } from "../tools/api.js";

export async function sentimentAnalystAgent(
  state: AgentState,
  agentId = "sentiment_analyst_agent"
): Promise<Partial<AgentState>> {
  const data = state.data as Record<string, unknown>;
  const endDate = data["end_date"] as string;
  const tickers = data["tickers"] as string[];
  const apiKey = getApiKeyFromState(state, "FINANCIAL_DATASETS_API_KEY");

  const sentimentAnalysis: Record<string, unknown> = {};

  for (const ticker of tickers) {
    progress.updateStatus(agentId, ticker, "Fetching insider trades");
    const insiderTrades = await getInsiderTrades(ticker, endDate, undefined, 1000, apiKey);

    progress.updateStatus(agentId, ticker, "Analyzing trading patterns");
    const insiderSignals: string[] = insiderTrades
      .filter(t => t.transaction_shares != null)
      .map(t => (t.transaction_shares! < 0 ? "bearish" : "bullish"));

    progress.updateStatus(agentId, ticker, "Fetching company news");
    const companyNews = await getCompanyNews(ticker, endDate, undefined, 100, apiKey);

    const newsSignals: string[] = companyNews
      .filter(n => n.sentiment != null)
      .map(n => n.sentiment === "negative" ? "bearish" : n.sentiment === "positive" ? "bullish" : "neutral");

    progress.updateStatus(agentId, ticker, "Combining signals");
    const insiderWeight = 0.3;
    const newsWeight = 0.7;

    const insiderBullish = insiderSignals.filter(s => s === "bullish").length;
    const insiderBearish = insiderSignals.filter(s => s === "bearish").length;
    const newsBullish = newsSignals.filter(s => s === "bullish").length;
    const newsBearish = newsSignals.filter(s => s === "bearish").length;
    const newsNeutral = newsSignals.filter(s => s === "neutral").length;

    const bullishSignals = insiderBullish * insiderWeight + newsBullish * newsWeight;
    const bearishSignals = insiderBearish * insiderWeight + newsBearish * newsWeight;

    const overallSignal = bullishSignals > bearishSignals ? "bullish" : bearishSignals > bullishSignals ? "bearish" : "neutral";

    const totalWeightedSignals = insiderSignals.length * insiderWeight + newsSignals.length * newsWeight;
    const confidence = totalWeightedSignals > 0
      ? Math.round((Math.max(bullishSignals, bearishSignals) / totalWeightedSignals) * 100 * 100) / 100
      : 0;

    const reasoning = {
      insider_trading: {
        signal: insiderBullish > insiderBearish ? "bullish" : insiderBearish > insiderBullish ? "bearish" : "neutral",
        confidence: Math.round((Math.max(insiderBullish, insiderBearish) / Math.max(insiderSignals.length, 1)) * 100),
        metrics: {
          total_trades: insiderSignals.length,
          bullish_trades: insiderBullish,
          bearish_trades: insiderBearish,
          weight: insiderWeight,
          weighted_bullish: Math.round(insiderBullish * insiderWeight * 10) / 10,
          weighted_bearish: Math.round(insiderBearish * insiderWeight * 10) / 10,
        },
      },
      news_sentiment: {
        signal: newsBullish > newsBearish ? "bullish" : newsBearish > newsBullish ? "bearish" : "neutral",
        confidence: Math.round((Math.max(newsBullish, newsBearish) / Math.max(newsSignals.length, 1)) * 100),
        metrics: {
          total_articles: newsSignals.length,
          bullish_articles: newsBullish,
          bearish_articles: newsBearish,
          neutral_articles: newsNeutral,
          weight: newsWeight,
          weighted_bullish: Math.round(newsBullish * newsWeight * 10) / 10,
          weighted_bearish: Math.round(newsBearish * newsWeight * 10) / 10,
        },
      },
      combined_analysis: {
        total_weighted_bullish: Math.round(bullishSignals * 10) / 10,
        total_weighted_bearish: Math.round(bearishSignals * 10) / 10,
        signal_determination: `${overallSignal.charAt(0).toUpperCase() + overallSignal.slice(1)} based on weighted signal comparison`,
      },
    };

    sentimentAnalysis[ticker] = { signal: overallSignal, confidence, reasoning };
    progress.updateStatus(agentId, ticker, "Done", JSON.stringify(reasoning, null, 4));
  }

  const message = new HumanMessage({ content: JSON.stringify(sentimentAnalysis), name: agentId });

  if ((state.metadata as Record<string, unknown>)["show_reasoning"]) {
    showAgentReasoning(sentimentAnalysis, "Sentiment Analysis Agent");
  }

  const existingSignals = (data["analyst_signals"] as Record<string, unknown>) ?? {};
  data["analyst_signals"] = { ...existingSignals, [agentId]: sentimentAnalysis };

  progress.updateStatus(agentId, null, "Done");

  return { messages: [message], data };
}
