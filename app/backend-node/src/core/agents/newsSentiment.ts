import { HumanMessage } from "@langchain/core/messages";
import type { AgentState } from "../graph/state.js";
import { showAgentReasoning } from "../graph/state.js";
import { getApiKeyFromState } from "../utils/apiKey.js";
import { progress } from "../utils/progress.js";
import { getCompanyNews } from "../tools/api.js";
import type { CompanyNews } from "../data/models.js";
import { callLlm } from "../utils/llm.js";
import { z } from "zod";

const SentimentSchema = z.object({
  sentiment: z.enum(["positive", "negative", "neutral"]),
  confidence: z.number().int().min(0).max(100),
});

export function calculateConfidenceScore(
  sentimentConfidences: Map<object, number>,
  companyNews: CompanyNews[],
  overallSignal: string,
  bullishSignals: number,
  bearishSignals: number,
  totalSignals: number
): number {
  if (totalSignals === 0) return 0;

  if (sentimentConfidences.size > 0) {
    const matchingArticles = companyNews.filter(news =>
      news.sentiment && (
        (overallSignal === "bullish" && news.sentiment === "positive") ||
        (overallSignal === "bearish" && news.sentiment === "negative") ||
        (overallSignal === "neutral" && news.sentiment === "neutral")
      )
    );

    const llmConfs = matchingArticles
      .map(n => sentimentConfidences.get(n))
      .filter((v): v is number => v !== undefined);

    if (llmConfs.length > 0) {
      const avgLlm = llmConfs.reduce((a, b) => a + b, 0) / llmConfs.length;
      const signalProportion = (Math.max(bullishSignals, bearishSignals) / totalSignals) * 100;
      return Math.round((0.7 * avgLlm + 0.3 * signalProportion) * 100) / 100;
    }
  }

  return Math.round((Math.max(bullishSignals, bearishSignals) / totalSignals) * 100 * 100) / 100;
}

export async function newsSentimentAgent(
  state: AgentState,
  agentId = "news_sentiment_agent"
): Promise<Partial<AgentState>> {
  const data = state.data as Record<string, unknown>;
  const endDate = data["end_date"] as string;
  const tickers = data["tickers"] as string[];
  const apiKey = getApiKeyFromState(state, "FINANCIAL_DATASETS_API_KEY");

  const sentimentAnalysis: Record<string, unknown> = {};

  for (const ticker of tickers) {
    progress.updateStatus(agentId, ticker, "Fetching company news");
    const companyNews = await getCompanyNews(ticker, endDate, undefined, 100, apiKey);

    const newsSignals: string[] = [];
    const sentimentConfidences = new Map<object, number>();
    let sentimentsClassifiedByLlm = 0;

    if (companyNews.length > 0) {
      const recentArticles = companyNews.slice(0, 10);
      const articlesWithoutSentiment = recentArticles.filter(n => n.sentiment == null);

      if (articlesWithoutSentiment.length > 0) {
        const toAnalyze = articlesWithoutSentiment.slice(0, 5);
        progress.updateStatus(agentId, ticker, `Analyzing sentiment for ${toAnalyze.length} articles`);

        for (let idx = 0; idx < toAnalyze.length; idx++) {
          const newsItem = toAnalyze[idx]!;
          progress.updateStatus(agentId, ticker, `Analyzing sentiment for article ${idx + 1} of ${toAnalyze.length}`);
          const prompt = `Please analyze the sentiment of the following news headline with the following context: The stock is ${ticker}. Determine if sentiment is 'positive', 'negative', or 'neutral' for the stock ${ticker} only. Also provide a confidence score for your prediction from 0 to 100. Respond in JSON format.\n\nHeadline: ${newsItem.title}`;

          const response = await callLlm(prompt, SentimentSchema, { agentName: agentId, state });
          if (response) {
            (newsItem as Record<string, unknown>)["sentiment"] = response.sentiment.toLowerCase();
            sentimentConfidences.set(newsItem, response.confidence);
          } else {
            (newsItem as Record<string, unknown>)["sentiment"] = "neutral";
            sentimentConfidences.set(newsItem, 0);
          }
          sentimentsClassifiedByLlm++;
        }
      }

      for (const n of companyNews) {
        if (n.sentiment != null) {
          newsSignals.push(n.sentiment === "negative" ? "bearish" : n.sentiment === "positive" ? "bullish" : "neutral");
        }
      }
    }

    progress.updateStatus(agentId, ticker, "Aggregating signals");

    const bullishSignals = newsSignals.filter(s => s === "bullish").length;
    const bearishSignals = newsSignals.filter(s => s === "bearish").length;
    const neutralSignals = newsSignals.filter(s => s === "neutral").length;
    const totalSignals = newsSignals.length;

    const overallSignal = bullishSignals > bearishSignals ? "bullish" : bearishSignals > bullishSignals ? "bearish" : "neutral";

    const confidence = calculateConfidenceScore(sentimentConfidences, companyNews, overallSignal, bullishSignals, bearishSignals, totalSignals);

    const reasoning = {
      news_sentiment: {
        signal: overallSignal,
        confidence,
        metrics: {
          total_articles: totalSignals,
          bullish_articles: bullishSignals,
          bearish_articles: bearishSignals,
          neutral_articles: neutralSignals,
          articles_classified_by_llm: sentimentsClassifiedByLlm,
        },
      },
    };

    sentimentAnalysis[ticker] = { signal: overallSignal, confidence, reasoning };
    progress.updateStatus(agentId, ticker, "Done", JSON.stringify(reasoning, null, 4));
  }

  const message = new HumanMessage({ content: JSON.stringify(sentimentAnalysis), name: agentId });

  if ((state.metadata as Record<string, unknown>)["show_reasoning"]) {
    showAgentReasoning(sentimentAnalysis, "News Sentiment Analysis Agent");
  }

  const existingSignals = (data["analyst_signals"] as Record<string, unknown>) ?? {};
  data["analyst_signals"] = { ...existingSignals, [agentId]: sentimentAnalysis };

  progress.updateStatus(agentId, null, "Done");

  return { messages: [message], data };
}
