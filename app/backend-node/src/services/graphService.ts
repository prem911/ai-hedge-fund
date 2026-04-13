import { StateGraph, END, START } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { AgentStateAnnotation, type AgentState } from "../core/graph/state.js";
import { portfolioManagementAgent } from "../core/agents/portfolioManager.js";
import { riskManagementAgent } from "../core/agents/riskManager.js";
import { aswathDamodaranAgent } from "../core/agents/aswathDamodaran.js";
import { benGrahamAgent } from "../core/agents/benGraham.js";
import { billAckmanAgent } from "../core/agents/billAckman.js";
import { cathieWoodAgent } from "../core/agents/cathieWood.js";
import { charlieMungerAgent } from "../core/agents/charlieMunger.js";
import { michaelBurryAgent } from "../core/agents/michaelBurry.js";
import { mohnishPabraiAgent } from "../core/agents/mohnishPabrai.js";
import { nassimTalebAgent } from "../core/agents/nassimTaleb.js";
import { peterLynchAgent } from "../core/agents/peterLynch.js";
import { philFisherAgent } from "../core/agents/philFisher.js";
import { rakeshJhunjhunwalaAgent } from "../core/agents/rakeshJhunjhunwala.js";
import { stanleyDruckenmillerAgent } from "../core/agents/stanleyDruckenmiller.js";
import { warrenBuffettAgent } from "../core/agents/warrenBuffett.js";
import { technicalAnalystAgent } from "../core/agents/technicals.js";
import { fundamentalsAnalystAgent } from "../core/agents/fundamentals.js";
import { growthAnalystAgent } from "../core/agents/growthAgent.js";
import { newsSentimentAgent } from "../core/agents/newsSentiment.js";
import { sentimentAnalystAgent } from "../core/agents/sentiment.js";
import { valuationAnalystAgent } from "../core/agents/valuation.js";
import type { GraphNode, GraphEdge } from "../models/schemas.js";

type AgentFunction = (state: AgentState) => Promise<Partial<AgentState>>;

export const ANALYST_CONFIG: Record<
  string,
  { display_name: string; description: string; investing_style: string; agent_func: AgentFunction; order: number }
> = {
  aswath_damodaran: {
    display_name: "Aswath Damodaran",
    description: "The Dean of Valuation",
    investing_style: "Focuses on intrinsic value and financial metrics.",
    agent_func: (state) => aswathDamodaranAgent(state, "aswath_damodaran_agent"),
    order: 0,
  },
  ben_graham: {
    display_name: "Ben Graham",
    description: "The Father of Value Investing",
    investing_style: "Emphasizes a margin of safety and invests in undervalued companies.",
    agent_func: (state) => benGrahamAgent(state, "ben_graham_agent"),
    order: 1,
  },
  bill_ackman: {
    display_name: "Bill Ackman",
    description: "The Activist Investor",
    investing_style: "Seeks to influence management and unlock value.",
    agent_func: (state) => billAckmanAgent(state, "bill_ackman_agent"),
    order: 2,
  },
  cathie_wood: {
    display_name: "Cathie Wood",
    description: "The Queen of Growth Investing",
    investing_style: "Focuses on disruptive innovation and growth.",
    agent_func: (state) => cathieWoodAgent(state, "cathie_wood_agent"),
    order: 3,
  },
  charlie_munger: {
    display_name: "Charlie Munger",
    description: "The Rational Thinker",
    investing_style: "Advocates for value investing with a focus on quality businesses.",
    agent_func: (state) => charlieMungerAgent(state, "charlie_munger_agent"),
    order: 4,
  },
  michael_burry: {
    display_name: "Michael Burry",
    description: "The Big Short Contrarian",
    investing_style: "Makes contrarian bets on overvalued markets.",
    agent_func: (state) => michaelBurryAgent(state, "michael_burry_agent"),
    order: 5,
  },
  mohnish_pabrai: {
    display_name: "Mohnish Pabrai",
    description: "The Dhandho Investor",
    investing_style: "Focuses on value investing and long-term growth.",
    agent_func: (state) => mohnishPabraiAgent(state, "mohnish_pabrai_agent"),
    order: 6,
  },
  nassim_taleb: {
    display_name: "Nassim Taleb",
    description: "The Black Swan Risk Analyst",
    investing_style: "Focuses on tail risk, antifragility, and asymmetric payoffs.",
    agent_func: (state) => nassimTalebAgent(state, "nassim_taleb_agent"),
    order: 7,
  },
  peter_lynch: {
    display_name: "Peter Lynch",
    description: "The 10-Bagger Investor",
    investing_style: "Invests in companies with understandable business models.",
    agent_func: (state) => peterLynchAgent(state, "peter_lynch_agent"),
    order: 8,
  },
  phil_fisher: {
    display_name: "Phil Fisher",
    description: "The Scuttlebutt Investor",
    investing_style: "Emphasizes companies with strong management.",
    agent_func: (state) => philFisherAgent(state, "phil_fisher_agent"),
    order: 9,
  },
  rakesh_jhunjhunwala: {
    display_name: "Rakesh Jhunjhunwala",
    description: "The Big Bull Of India",
    investing_style: "Leverages macroeconomic insights.",
    agent_func: (state) => rakeshJhunjhunwalaAgent(state, "rakesh_jhunjhunwala_agent"),
    order: 10,
  },
  stanley_druckenmiller: {
    display_name: "Stanley Druckenmiller",
    description: "The Macro Investor",
    investing_style: "Focuses on macroeconomic trends.",
    agent_func: (state) => stanleyDruckenmillerAgent(state, "stanley_druckenmiller_agent"),
    order: 11,
  },
  warren_buffett: {
    display_name: "Warren Buffett",
    description: "The Oracle of Omaha",
    investing_style: "Seeks companies with strong fundamentals.",
    agent_func: (state) => warrenBuffettAgent(state, "warren_buffett_agent"),
    order: 12,
  },
  technical_analyst: {
    display_name: "Technical Analyst",
    description: "Chart Pattern Specialist",
    investing_style: "Focuses on chart patterns and market trends.",
    agent_func: (state) => technicalAnalystAgent(state, "technical_analyst_agent"),
    order: 13,
  },
  fundamentals_analyst: {
    display_name: "Fundamentals Analyst",
    description: "Financial Statement Specialist",
    investing_style: "Delves into financial statements.",
    agent_func: (state) => fundamentalsAnalystAgent(state, "fundamentals_analyst_agent"),
    order: 14,
  },
  growth_analyst: {
    display_name: "Growth Analyst",
    description: "Growth Specialist",
    investing_style: "Analyzes growth trends and valuation.",
    agent_func: (state) => growthAnalystAgent(state, "growth_analyst_agent"),
    order: 15,
  },
  news_sentiment_analyst: {
    display_name: "News Sentiment Analyst",
    description: "News Sentiment Specialist",
    investing_style: "Analyzes news sentiment.",
    agent_func: (state) => newsSentimentAgent(state, "news_sentiment_agent"),
    order: 16,
  },
  sentiment_analyst: {
    display_name: "Sentiment Analyst",
    description: "Market Sentiment Specialist",
    investing_style: "Gauges market sentiment.",
    agent_func: (state) => sentimentAnalystAgent(state, "sentiment_analyst_agent"),
    order: 17,
  },
  valuation_analyst: {
    display_name: "Valuation Analyst",
    description: "Company Valuation Specialist",
    investing_style: "Determines the fair value of companies.",
    agent_func: (state) => valuationAnalystAgent(state, "valuation_analyst_agent"),
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
    const capturedPmId = pmId;
    graph.addNode(pmId, (state: AgentState) => portfolioManagementAgent(state, capturedPmId));

    const suffix = pmId.split("_").pop()!;
    const rmId = `risk_management_agent_${suffix}`;
    riskManagerNodes.set(pmId, rmId);
    const capturedRmId = rmId;
    graph.addNode(rmId, (state: AgentState) => riskManagementAgent(state, capturedRmId));
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

// ─── buildDefaultGraphNodes ───────────────────────────────────────────────────
/**
 * Build the list of GraphNode objects for the standard workflow topology.
 * Generates a unique suffix for each node to match the createGraph() convention.
 *
 * Topology: start → analysts → risk_management → portfolio_manager → END
 *
 * @param selectedAnalysts Array of analyst keys (e.g. ["warren_buffett", "technicals"])
 * @returns Array of GraphNode objects ready to pass to createGraph()
 */
export function buildDefaultGraphNodes(selectedAnalysts: string[]): GraphNode[] {
  // Use a fixed short suffix so node IDs are deterministic in CLI context
  const suffix = "000000";
  const nodes: GraphNode[] = [];

  for (const analystKey of selectedAnalysts) {
    if (analystKey in ANALYST_CONFIG && analystKey !== "portfolio_manager") {
      nodes.push({ id: `${analystKey}_${suffix}`, type: "agent" });
    }
  }

  nodes.push({ id: `portfolio_manager_${suffix}`, type: "agent" });
  return nodes;
}

// ─── buildDefaultGraphEdges ───────────────────────────────────────────────────
/**
 * Build the list of GraphEdge objects for the standard workflow topology.
 * Each analyst connects directly to the portfolio_manager node; createGraph()
 * will automatically insert the risk_management node in between.
 *
 * @param selectedAnalysts Array of analyst keys (e.g. ["warren_buffett", "technicals"])
 * @returns Array of GraphEdge objects ready to pass to createGraph()
 */
export function buildDefaultGraphEdges(selectedAnalysts: string[]): GraphEdge[] {
  const suffix = "000000";
  const edges: GraphEdge[] = [];

  for (const analystKey of selectedAnalysts) {
    if (analystKey in ANALYST_CONFIG && analystKey !== "portfolio_manager") {
      edges.push({
        id: `${analystKey}_${suffix}__portfolio_manager_${suffix}`,
        source: `${analystKey}_${suffix}`,
        target: `portfolio_manager_${suffix}`,
      });
    }
  }

  return edges;
}
