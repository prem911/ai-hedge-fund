import { HumanMessage } from "@langchain/core/messages";
import type { AgentState } from "../graph/state.js";
import { getLlm, ModelProvider } from "../llm/models.js";

/**
 * Risk Manager agent scaffold.
 *
 * Evaluates risk metrics from the current analyst signals and portfolio state,
 * then returns risk-adjusted signals in the state.
 */
export async function riskManagementAgent(state: AgentState): Promise<Partial<AgentState>> {
  const metadata = state.metadata as Record<string, unknown>;
  const modelName = (metadata["model_name"] as string | undefined) ?? "gpt-4.1";
  const modelProvider = (metadata["model_provider"] as string | undefined) ?? ModelProvider.OPENAI;
  const apiKeys = (metadata["api_keys"] as Record<string, string> | undefined) ?? {};

  const llm = getLlm(modelName, modelProvider, apiKeys);

  const data = state.data as Record<string, unknown>;
  const analystSignals = data["analyst_signals"] ?? {};
  const tickers = (data["tickers"] as string[] | undefined) ?? [];
  const portfolio = data["portfolio"] ?? {};

  const prompt = `You are a risk manager. Review the analyst signals and portfolio state below, then provide risk-adjusted position sizing recommendations.

Tickers: ${tickers.join(", ")}
Portfolio: ${JSON.stringify(portfolio, null, 2)}
Analyst signals: ${JSON.stringify(analystSignals, null, 2)}

Respond with a JSON object where each ticker maps to a risk signal:
  max_position_size: number (fraction of portfolio, 0-1)
  risk_score: number (0-10, higher = riskier)
  reasoning: string`;

  const response = await llm.invoke([new HumanMessage(prompt)]);
  const content = typeof response.content === "string" ? response.content : JSON.stringify(response.content);

  // Store risk signals in analyst_signals under "risk_management_agent" key
  const existingSignals = (data["analyst_signals"] as Record<string, unknown>) ?? {};
  const updatedSignals = {
    ...existingSignals,
    risk_management_agent: content,
  };

  return {
    messages: [response],
    data: { analyst_signals: updatedSignals },
  };
}
