import { Annotation } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";

// ─── Agent state annotation ───────────────────────────────────────────────────
export const AgentStateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  data: Annotation<Record<string, unknown>>({
    reducer: (a, b) => ({ ...a, ...b }),
    default: () => ({}),
  }),
  metadata: Annotation<Record<string, unknown>>({
    reducer: (a, b) => ({ ...a, ...b }),
    default: () => ({}),
  }),
});

export type AgentState = typeof AgentStateAnnotation.State;

// ─── Utility ──────────────────────────────────────────────────────────────────
function convertToSerializable(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "number" || typeof obj === "boolean" || typeof obj === "string") return obj;
  if (Array.isArray(obj)) return obj.map(convertToSerializable);
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = convertToSerializable(v);
    }
    return result;
  }
  return String(obj);
}

export function showAgentReasoning(output: unknown, agentName: string): void {
  console.log(`\n${"=".repeat(10)} ${agentName.padStart(14 + agentName.length / 2).padEnd(28)} ${"=".repeat(10)}`);

  if (typeof output === "object" && output !== null) {
    console.log(JSON.stringify(convertToSerializable(output), null, 2));
  } else if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      console.log(JSON.stringify(parsed, null, 2));
    } catch {
      console.log(output);
    }
  } else {
    console.log(String(output));
  }

  console.log("=".repeat(48));
}
