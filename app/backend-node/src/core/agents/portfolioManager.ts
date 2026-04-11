import { HumanMessage } from "@langchain/core/messages";
import type { AgentState } from "../graph/state.js";
import { getLlm, ModelProvider } from "../llm/models.js";

/**
 * Portfolio Manager agent scaffold.
 *
 * Receives the aggregated analyst signals in AgentState, calls the LLM with
 * structured output to produce trading decisions, and returns a state update.
 */
export async function portfolioManagementAgent(state: AgentState): Promise<Partial<AgentState>> {
  const metadata = state.metadata as Record<string, unknown>;
  const modelName = (metadata["model_name"] as string | undefined) ?? "gpt-4.1";
  const modelProvider = (metadata["model_provider"] as string | undefined) ?? ModelProvider.OPENAI;
  const apiKeys = (metadata["api_keys"] as Record<string, string> | undefined) ?? {};

  const llm = getLlm(modelName, modelProvider, apiKeys);

  const data = state.data as Record<string, unknown>;
  const analystSignals = data["analyst_signals"] ?? {};
  const tickers = (data["tickers"] as string[] | undefined) ?? [];
  const portfolio = data["portfolio"] ?? {};

  const prompt = `You are a portfolio manager. Based on the analyst signals below, decide how to allocate the portfolio.

Tickers: ${tickers.join(", ")}
Portfolio: ${JSON.stringify(portfolio, null, 2)}
Analyst signals: ${JSON.stringify(analystSignals, null, 2)}

Respond with a JSON object where each ticker maps to an action object with fields:
  action: "buy" | "sell" | "hold"
  quantity: number (integer shares)
  confidence: number (0-1)
  reasoning: string`;

  const response = await llm.invoke([new HumanMessage(prompt)]);
  const content = typeof response.content === "string" ? response.content : JSON.stringify(response.content);

  return {
    messages: [response],
    data: { decisions: content },
  };
}
