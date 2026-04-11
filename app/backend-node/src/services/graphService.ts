import { StateGraph, END, START } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { AgentStateAnnotation, type AgentState } from "../core/graph/state.js";
import { portfolioManagementAgent } from "../core/agents/portfolioManager.js";
import { riskManagementAgent } from "../core/agents/riskManager.js";
import type { GraphNode, GraphEdge } from "../models/schemas.js";

// ─── ANALYST_CONFIG ────────────────────────────────────────────────────────────
// Maps analyst keys to placeholder agent functions.
// Phase 3+ agents are stubs — replace with real implementations as they are migrated.

type AgentFunction = (state: AgentState) => Promise<Partial<AgentState>>;

function placeholderAgent(key: string): AgentFunction {
  return async (state: AgentState) => {
    console.warn(`[${key}] Analyst agent not yet migrated (Phase 3+). Returning empty signal.`);
    const data = state.data as Record<string, unknown>;
    const existingSignals = (data["analyst_signals"] as Record<string, unknown>) ?? {};
    return {
      data: {
        analyst_signals: {
          ...existingSignals,
          [key]: { signal: null, confidence: 0, reasoning: "Agent not yet migrated" },
        },
      },
    };
  };
}

export const ANALYST_CONFIG: Record<
  string,
  { display_name: string; description: string; investing_style: string; agent_func: AgentFunction; order: number }
> = {
  aswath_damodaran: {
    display_name: "Aswath Damodaran",
    description: "The Dean of Valuation",
    investing_style: "Focuses on intrinsic value and financial metrics.",
    agent_func: placeholderAgent("aswath_damodaran"),
    order: 0,
  },
  ben_graham: {
    display_name: "Ben Graham",
    description: "The Father of Value Investing",
    investing_style: "Emphasizes a margin of safety and invests in undervalued companies.",
    agent_func: placeholderAgent("ben_graham"),
    order: 1,
  },
  bill_ackman: {
    display_name: "Bill Ackman",
    description: "The Activist Investor",
    investing_style: "Seeks to influence management and unlock value.",
    agent_func: placeholderAgent("bill_ackman"),
    order: 2,
  },
  cathie_wood: {
    display_name: "Cathie Wood",
    description: "The Queen of Growth Investing",
    investing_style: "Focuses on disruptive innovation and growth.",
    agent_func: placeholderAgent("cathie_wood"),
    order: 3,
  },
  charlie_munger: {
    display_name: "Charlie Munger",
    description: "The Rational Thinker",
    investing_style: "Advocates for value investing with a focus on quality businesses.",
    agent_func: placeholderAgent("charlie_munger"),
    order: 4,
  },
  michael_burry: {
    display_name: "Michael Burry",
    description: "The Big Short Contrarian",
    investing_style: "Makes contrarian bets on overvalued markets.",
    agent_func: placeholderAgent("michael_burry"),
    order: 5,
  },
  mohnish_pabrai: {
    display_name: "Mohnish Pabrai",
    description: "The Dhandho Investor",
    investing_style: "Focuses on value investing and long-term growth.",
    agent_func: placeholderAgent("mohnish_pabrai"),
    order: 6,
  },
  nassim_taleb: {
    display_name: "Nassim Taleb",
    description: "The Black Swan Risk Analyst",
    investing_style: "Focuses on tail risk, antifragility, and asymmetric payoffs.",
    agent_func: placeholderAgent("nassim_taleb"),
    order: 7,
  },
  peter_lynch: {
    display_name: "Peter Lynch",
    description: "The 10-Bagger Investor",
    investing_style: "Invests in companies with understandable business models.",
    agent_func: placeholderAgent("peter_lynch"),
    order: 8,
  },
  phil_fisher: {
    display_name: "Phil Fisher",
    description: "The Scuttlebutt Investor",
    investing_style: "Emphasizes companies with strong management.",
    agent_func: placeholderAgent("phil_fisher"),
    order: 9,
  },
  rakesh_jhunjhunwala: {
    display_name: "Rakesh Jhunjhunwala",
    description: "The Big Bull Of India",
    investing_style: "Leverages macroeconomic insights.",
    agent_func: placeholderAgent("rakesh_jhunjhunwala"),
    order: 10,
  },
  stanley_druckenmiller: {
    display_name: "Stanley Druckenmiller",
    description: "The Macro Investor",
    investing_style: "Focuses on macroeconomic trends.",
    agent_func: placeholderAgent("stanley_druckenmiller"),
    order: 11,
  },
  warren_buffett: {
    display_name: "Warren Buffett",
    description: "The Oracle of Omaha",
    investing_style: "Seeks companies with strong fundamentals.",
    agent_func: placeholderAgent("warren_buffett"),
    order: 12,
  },
  technical_analyst: {
    display_name: "Technical Analyst",
    description: "Chart Pattern Specialist",
    investing_style: "Focuses on chart patterns and market trends.",
    agent_func: placeholderAgent("technical_analyst"),
    order: 13,
  },
  fundamentals_analyst: {
    display_name: "Fundamentals Analyst",
    description: "Financial Statement Specialist",
    investing_style: "Delves into financial statements.",
    agent_func: placeholderAgent("fundamentals_analyst"),
    order: 14,
  },
  growth_analyst: {
    display_name: "Growth Analyst",
    description: "Growth Specialist",
    investing_style: "Analyzes growth trends and valuation.",
    agent_func: placeholderAgent("growth_analyst"),
    order: 15,
  },
  news_sentiment_analyst: {
    display_name: "News Sentiment Analyst",
    description: "News Sentiment Specialist",
    investing_style: "Analyzes news sentiment.",
    agent_func: placeholderAgent("news_sentiment_analyst"),
    order: 16,
  },
  sentiment_analyst: {
    display_name: "Sentiment Analyst",
    description: "Market Sentiment Specialist",
    investing_style: "Gauges market sentiment.",
    agent_func: placeholderAgent("sentiment_analyst"),
    order: 17,
  },
  valuation_analyst: {
    display_name: "Valuation Analyst",
    description: "Company Valuation Specialist",
    investing_style: "Determines the fair value of companies.",
    agent_func: placeholderAgent("valuation_analyst"),
    order: 18,
  },
  portfolio_manager: {
    display_name: "Portfolio Manager",
    description: "Portfolio allocation decision maker",
    investing_style: "Synthesizes analyst signals into final portfolio decisions.",
    agent_func: portfolioManagementAgent,
    order: 19,
  },
};

// ─── extractBaseAgentKey ───────────────────────────────────────────────────────
export function extractBaseAgentKey(uniqueId: string): string {
  const parts = uniqueId.split("_");
  if (parts.length >= 2) {
    const lastPart = parts[parts.length - 1]!;
    if (lastPart.length === 6 && /^[a-z0-9]+$/.test(lastPart)) {
      return parts.slice(0, -1).join("_");
    }
  }
  return uniqueId;
}

// ─── Start node ───────────────────────────────────────────────────────────────
async function startNode(state: AgentState): Promise<Partial<AgentState>> {
  return {
    messages: [new HumanMessage("Make trading decisions based on the provided data.")],
  };
}

// ─── createGraph ──────────────────────────────────────────────────────────────
export function createGraph(
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[]
): ReturnType<typeof StateGraph.prototype.compile> {
  const graph = new StateGraph(AgentStateAnnotation);

  graph.addNode("start_node", startNode);

  const agentIds = graphNodes.map((n) => n.id);
  const agentIdsSet = new Set(agentIds);
  const portfolioManagerNodes = new Set<string>();

  // Add analyst nodes
  for (const uniqueAgentId of agentIds) {
    const baseAgentKey = extractBaseAgentKey(uniqueAgentId);

    if (baseAgentKey === "portfolio_manager") {
      portfolioManagerNodes.add(uniqueAgentId);
      continue;
    }

    if (!(baseAgentKey in ANALYST_CONFIG)) continue;

    const config = ANALYST_CONFIG[baseAgentKey]!;
    graph.addNode(uniqueAgentId, config.agent_func);
  }

  // Add portfolio manager nodes + corresponding risk managers
  const riskManagerNodes = new Map<string, string>();
  for (const pmId of portfolioManagerNodes) {
    graph.addNode(pmId, portfolioManagementAgent);

    const suffix = pmId.split("_").pop()!;
    const rmId = `risk_management_agent_${suffix}`;
    riskManagerNodes.set(pmId, rmId);
    graph.addNode(rmId, riskManagementAgent);
  }

  // Build connections
  const nodesWithIncoming = new Set<string>();
  const nodesWithOutgoing = new Set<string>();
  const directToPm = new Map<string, string>(); // analyst → portfolio_manager

  for (const edge of graphEdges) {
    if (!agentIdsSet.has(edge.source) || !agentIdsSet.has(edge.target)) continue;

    const srcBase = extractBaseAgentKey(edge.source);
    const tgtBase = extractBaseAgentKey(edge.target);

    nodesWithIncoming.add(edge.target);
    nodesWithOutgoing.add(edge.source);

    if (srcBase in ANALYST_CONFIG && srcBase !== "portfolio_manager" && tgtBase === "portfolio_manager") {
      directToPm.set(edge.source, edge.target);
    } else {
      graph.addEdge(edge.source as never, edge.target as never);
    }
  }

  // Connect start_node → analyst nodes with no incoming edges
  for (const agentId of agentIds) {
    if (nodesWithIncoming.has(agentId)) continue;
    const base = extractBaseAgentKey(agentId);
    if (base in ANALYST_CONFIG && base !== "portfolio_manager") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (graph as any).addEdge("start_node", agentId);
    }
  }

  // Route analysts → risk manager → portfolio manager
  for (const [analystId, pmId] of directToPm) {
    const rmId = riskManagerNodes.get(pmId)!;
    graph.addEdge(analystId as never, rmId as never);
  }
  for (const [pmId, rmId] of riskManagerNodes) {
    graph.addEdge(rmId as never, pmId as never);
    graph.addEdge(pmId as never, END);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (graph as any).addEdge(START, "start_node");

  return graph.compile();
}

// ─── runGraph ─────────────────────────────────────────────────────────────────
export async function runGraph(
  graph: ReturnType<typeof createGraph>,
  portfolio: Record<string, unknown>,
  tickers: string[],
  startDate: string,
  endDate: string,
  modelName: string,
  modelProvider: string,
  request?: unknown
): Promise<Record<string, unknown>> {
  const result = await graph.invoke({
    messages: [new HumanMessage("Make trading decisions based on the provided data.")],
    data: {
      tickers,
      portfolio,
      start_date: startDate,
      end_date: endDate,
      analyst_signals: {},
    },
    metadata: {
      show_reasoning: false,
      model_name: modelName,
      model_provider: modelProvider,
      request,
    },
  });
  return result as Record<string, unknown>;
}

// ─── parseHedgeFundResponse ───────────────────────────────────────────────────
export function parseHedgeFundResponse(response: string): Record<string, unknown> | null {
  try {
    return JSON.parse(response) as Record<string, unknown>;
  } catch (e) {
    console.error("JSON decoding error:", e, "\nResponse:", JSON.stringify(response));
    return null;
  }
}

// ─── getAgentsList ────────────────────────────────────────────────────────────
export function getAgentsList(): Array<Record<string, unknown>> {
  return Object.entries(ANALYST_CONFIG)
    .sort(([, a], [, b]) => a.order - b.order)
    .map(([key, config]) => ({
      key,
      display_name: config.display_name,
      description: config.description,
      investing_style: config.investing_style,
      order: config.order,
    }));
}
