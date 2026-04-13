import { HumanMessage } from "@langchain/core/messages";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import type { AgentState } from "../graph/state.js";
import { showAgentReasoning } from "../graph/state.js";
import { progress } from "../utils/progress.js";
import { callLlm } from "../utils/llm.js";
import { z } from "zod";

const PortfolioDecisionSchema = z.object({
  action: z.enum(["buy", "sell", "short", "cover", "hold"]),
  quantity: z.number().int(),
  confidence: z.number().int().min(0).max(100),
  reasoning: z.string(),
});

const PortfolioManagerOutputSchema = z.object({
  decisions: z.record(z.string(), PortfolioDecisionSchema),
});

type PortfolioDecision = z.infer<typeof PortfolioDecisionSchema>;
type PortfolioManagerOutput = z.infer<typeof PortfolioManagerOutputSchema>;

function computeAllowedActions(
  tickers: string[],
  currentPrices: Record<string, number>,
  maxShares: Record<string, number>,
  portfolio: Record<string, unknown>
): Record<string, Record<string, number>> {
  const allowed: Record<string, Record<string, number>> = {};
  const cash = parseFloat(String(portfolio["cash"] ?? 0));
  const positions = (portfolio["positions"] as Record<string, unknown>) ?? {};
  const marginRequirement = parseFloat(String(portfolio["margin_requirement"] ?? 0.5));
  const marginUsed = parseFloat(String(portfolio["margin_used"] ?? 0));
  const equity = parseFloat(String(portfolio["equity"] ?? cash));

  for (const ticker of tickers) {
    const price = parseFloat(String(currentPrices[ticker] ?? 0));
    const pos = (positions[ticker] as Record<string, unknown> | undefined) ?? { long: 0, short: 0 };
    const longShares = parseInt(String(pos["long"] ?? 0));
    const shortShares = parseInt(String(pos["short"] ?? 0));
    const maxQty = parseInt(String(maxShares[ticker] ?? 0));

    const actions: Record<string, number> = { hold: 0 };

    if (longShares > 0) actions["sell"] = longShares;
    if (cash > 0 && price > 0) {
      const maxBuy = Math.max(0, Math.min(maxQty, Math.floor(cash / price)));
      if (maxBuy > 0) actions["buy"] = maxBuy;
    }
    if (shortShares > 0) actions["cover"] = shortShares;
    if (price > 0 && maxQty > 0) {
      let maxShort: number;
      if (marginRequirement <= 0) {
        maxShort = maxQty;
      } else {
        const availMargin = Math.max(0, equity / marginRequirement - marginUsed);
        maxShort = Math.max(0, Math.min(maxQty, Math.floor(availMargin / price)));
      }
      if (maxShort > 0) actions["short"] = maxShort;
    }

    allowed[ticker] = actions;
  }
  return allowed;
}

function compactSignals(signalsByTicker: Record<string, Record<string, unknown>>): Record<string, Record<string, { sig: string; conf: unknown }>> {
  const out: Record<string, Record<string, { sig: string; conf: unknown }>> = {};
  for (const [ticker, agents] of Object.entries(signalsByTicker)) {
    const compact: Record<string, { sig: string; conf: unknown }> = {};
    for (const [agent, payload] of Object.entries(agents)) {
      const p = payload as Record<string, unknown>;
      const sig = (p["sig"] ?? p["signal"]) as string;
      const conf = "conf" in p ? p["conf"] : p["confidence"];
      if (sig != null && conf != null) compact[agent] = { sig, conf };
    }
    out[ticker] = compact;
  }
  return out;
}

export async function portfolioManagementAgent(
  state: AgentState,
  agentId = "portfolio_manager"
): Promise<Partial<AgentState>> {
  const data = state.data as Record<string, unknown>;
  const portfolio = (data["portfolio"] as Record<string, unknown>) ?? {};
  const analystSignals = (data["analyst_signals"] as Record<string, Record<string, Record<string, unknown>>>) ?? {};
  const tickers = (data["tickers"] as string[]) ?? [];

  const positionLimits: Record<string, number> = {};
  const currentPrices: Record<string, number> = {};
  const maxShares: Record<string, number> = {};
  const signalsByTicker: Record<string, Record<string, unknown>> = {};

  for (const ticker of tickers) {
    progress.updateStatus(agentId, ticker, "Processing analyst signals");

    let riskManagerId: string;
    if (agentId.startsWith("portfolio_manager_")) {
      const suffix = agentId.split("_").at(-1);
      riskManagerId = `risk_management_agent_${suffix}`;
    } else {
      riskManagerId = "risk_management_agent";
    }

    const riskData = (analystSignals[riskManagerId]?.[ticker] ?? {}) as Record<string, unknown>;
    positionLimits[ticker] = parseFloat(String(riskData["remaining_position_limit"] ?? 0));
    currentPrices[ticker] = parseFloat(String(riskData["current_price"] ?? 0));

    maxShares[ticker] = currentPrices[ticker]! > 0 ? Math.floor(positionLimits[ticker]! / currentPrices[ticker]!) : 0;

    const tickerSignals: Record<string, unknown> = {};
    for (const [agent, signals] of Object.entries(analystSignals)) {
      if (!agent.startsWith("risk_management_agent") && signals[ticker]) {
        const s = signals[ticker] as Record<string, unknown>;
        const sig = s["signal"];
        const conf = s["confidence"];
        if (sig != null && conf != null) tickerSignals[agent] = { sig, conf };
      }
    }
    signalsByTicker[ticker] = tickerSignals;
  }

  data["current_prices"] = currentPrices;
  progress.updateStatus(agentId, null, "Generating trading decisions");

  const allowedActions = computeAllowedActions(tickers, currentPrices, maxShares, portfolio);

  // Pre-fill pure holds
  const prefilled: Record<string, PortfolioDecision> = {};
  const tickersForLlm: string[] = [];
  for (const t of tickers) {
    const aa = allowedActions[t] ?? { hold: 0 };
    if (Object.keys(aa).every(k => k === "hold")) {
      prefilled[t] = { action: "hold", quantity: 0, confidence: 100, reasoning: "No valid trade available" };
    } else {
      tickersForLlm.push(t);
    }
  }

  let decisions: Record<string, PortfolioDecision> = { ...prefilled };

  if (tickersForLlm.length > 0) {
    const compactSigs = compactSignals(
      Object.fromEntries(tickersForLlm.map(t => [t, signalsByTicker[t] as Record<string, unknown>]))
    );
    const compactAllowed = Object.fromEntries(tickersForLlm.map(t => [t, allowedActions[t]]));

    const template = ChatPromptTemplate.fromMessages([
      ["system", "You are a portfolio manager.\nInputs per ticker: analyst signals and allowed actions with max qty (already validated).\nPick one allowed action per ticker and a quantity ≤ the max. Keep reasoning very concise (max 100 chars). No cash or margin math. Return JSON only."],
      ["human", "Signals:\n{signals}\n\nAllowed:\n{allowed}\n\nFormat:\n{{\n  \"decisions\": {{\n    \"TICKER\": {{\"action\":\"...\",\"quantity\":int,\"confidence\":int,\"reasoning\":\"...\"}}\n  }}\n}}"],
    ]);
    const prompt = await template.invoke({
      signals: JSON.stringify(compactSigs),
      allowed: JSON.stringify(compactAllowed),
    });

    const result = await callLlm(prompt, PortfolioManagerOutputSchema, {
      agentName: agentId,
      state,
      defaultFactory: () => {
        const fallback: Record<string, PortfolioDecision> = {};
        for (const t of tickersForLlm) fallback[t] = { action: "hold", quantity: 0, confidence: 0, reasoning: "Default: hold" };
        return { decisions: { ...prefilled, ...fallback } };
      },
    });

    if (result?.decisions) {
      decisions = { ...prefilled, ...result.decisions };
    }
  }

  const message = new HumanMessage({
    content: JSON.stringify(Object.fromEntries(Object.entries(decisions).map(([t, d]) => [t, d]))),
    name: agentId,
  });

  if ((state.metadata as Record<string, unknown>)["show_reasoning"]) {
    showAgentReasoning(decisions, "Portfolio Manager");
  }

  progress.updateStatus(agentId, null, "Done");

  const messages = [...(state.messages ?? []), message];
  return { messages, data };
}
