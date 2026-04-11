import type { AgentState } from "../graph/state.js";

export function getApiKeyFromState(state: AgentState, keyName: string): string | undefined {
  const metadata = state.metadata as Record<string, unknown>;
  const request = metadata?.["request"] as Record<string, unknown> | undefined;
  if (request?.["api_keys"]) {
    return (request["api_keys"] as Record<string, string>)[keyName];
  }
  return undefined;
}
