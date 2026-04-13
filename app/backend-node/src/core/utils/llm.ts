import { HumanMessage } from "@langchain/core/messages";
import { getLlm } from "../llm/models.js";
import type { AgentState } from "../graph/state.js";
import { z } from "zod";
import { progress } from "./progress.js";

function getAgentModelConfig(state: AgentState, agentName: string): [string, string] {
  const metadata = state.metadata as Record<string, unknown>;
  const request = metadata?.["request"] as Record<string, unknown> | undefined;
  if (request) {
    const agentModels = request["agent_models"] as Record<string, { model_name?: string; model_provider?: string }> | undefined;
    if (agentModels?.[agentName]) {
      const cfg = agentModels[agentName];
      return [cfg.model_name ?? "gpt-4.1", cfg.model_provider ?? "OpenAI"];
    }
    const modelName = request["model_name"] as string | undefined;
    const modelProvider = request["model_provider"] as string | undefined;
    if (modelName && modelProvider) return [modelName, modelProvider];
  }
  const modelName = metadata["model_name"] as string | undefined;
  const modelProvider = metadata["model_provider"] as string | undefined;
  return [modelName ?? "gpt-4.1", modelProvider ?? "OpenAI"];
}

function createDefaultResponse<T>(zodSchema: z.ZodType<T>): T | null {
  try {
    return zodSchema.parse({});
  } catch {
    return null;
  }
}

export async function callLlm<T>(
  prompt: string | object,
  zodSchema: z.ZodType<T>,
  options?: {
    agentName?: string;
    state?: AgentState;
    maxRetries?: number;
    defaultFactory?: () => T;
  }
): Promise<T | null> {
  const { agentName, state, maxRetries = 3, defaultFactory } = options ?? {};

  let modelName = "gpt-4.1";
  let modelProvider = "OpenAI";

  if (state && agentName) {
    [modelName, modelProvider] = getAgentModelConfig(state, agentName);
  } else if (state) {
    const metadata = state.metadata as Record<string, unknown>;
    modelName = (metadata["model_name"] as string | undefined) ?? "gpt-4.1";
    modelProvider = (metadata["model_provider"] as string | undefined) ?? "OpenAI";
  }

  const metadata = state?.metadata as Record<string, unknown> | undefined;
  const request = metadata?.["request"] as Record<string, unknown> | undefined;
  let apiKeys: Record<string, string> | undefined;
  if (request?.["api_keys"]) {
    apiKeys = request["api_keys"] as Record<string, string>;
  }

  const llm = getLlm(modelName, modelProvider, apiKeys);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const llmWithStructuredOutput = (llm as any).withStructuredOutput(zodSchema, { method: "json_mode" });

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const messages = typeof prompt === "string" ? [new HumanMessage(prompt)] : [prompt];
      const result = await llmWithStructuredOutput.invoke(messages) as T;
      return result;
    } catch (e) {
      if (agentName) {
        progress.updateStatus(agentName, null, `Error - retry ${attempt + 1}/${maxRetries}`);
      }
      if (attempt === maxRetries - 1) {
        if (defaultFactory) return defaultFactory();
        return createDefaultResponse(zodSchema);
      }
    }
  }
  return createDefaultResponse(zodSchema);
}
