#!/usr/bin/env node
/**
 * AI Hedge Fund — Node.js CLI
 *
 * Translates src/main.py + src/cli/input.py into TypeScript using
 * Commander (argparse), @inquirer/prompts (questionary), chalk (colorama),
 * and cli-table3 (tabulate).
 */

import "dotenv/config";
import { Command } from "commander";
import { checkbox } from "@inquirer/prompts";
import chalk from "chalk";
import Table from "cli-table3";
import { format, subMonths } from "date-fns";

import {
  ANALYST_CONFIG,
  createGraph,
  runGraph,
  buildDefaultGraphNodes,
  buildDefaultGraphEdges,
} from "./services/graphService.js";
import { createPortfolio } from "./services/portfolioService.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TradingResult {
  decisions: Record<string, Record<string, unknown>> | null;
  analyst_signals: Record<string, Record<string, Record<string, unknown>>>;
}

// ─── Text wrapping helper ─────────────────────────────────────────────────────

function wrapText(text: string, maxLen = 60): string {
  if (!text) return "";
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length + word.length + 1 > maxLen) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.join("\n");
}

// ─── Signal / action colors ───────────────────────────────────────────────────

function signalColor(signal: string): string {
  switch (signal.toUpperCase()) {
    case "BULLISH":
      return chalk.green(signal.toUpperCase());
    case "BEARISH":
      return chalk.red(signal.toUpperCase());
    case "NEUTRAL":
      return chalk.yellow(signal.toUpperCase());
    default:
      return chalk.white(signal.toUpperCase());
  }
}

function actionColor(action: string): string {
  switch (action.toUpperCase()) {
    case "BUY":
    case "COVER":
      return chalk.green(action.toUpperCase());
    case "SELL":
    case "SHORT":
      return chalk.red(action.toUpperCase());
    case "HOLD":
      return chalk.yellow(action.toUpperCase());
    default:
      return chalk.white(action.toUpperCase());
  }
}

// ─── printTradingOutput ───────────────────────────────────────────────────────

export function printTradingOutput(result: TradingResult): void {
  const { decisions, analyst_signals } = result;

  if (!decisions) {
    console.log(chalk.red("No trading decisions available"));
    return;
  }

  for (const [ticker, decision] of Object.entries(decisions)) {
    console.log(`\n${chalk.bold.white(`Analysis for `)}${chalk.cyan(ticker)}`);
    console.log(chalk.bold.white("=".repeat(50)));

    // ── Agent signals table ──
    const agentTable = new Table({
      head: [
        chalk.white("Agent"),
        chalk.white("Signal"),
        chalk.white("Confidence"),
        chalk.white("Reasoning"),
      ],
      colWidths: [28, 12, 12, 64],
      wordWrap: true,
    });

    const orderedAnalysts = Object.entries(ANALYST_CONFIG).sort(
      ([, a], [, b]) => a.order - b.order
    );

    for (const [key] of orderedAnalysts) {
      const agentKey = `${key}_agent`;
      const signals = analyst_signals[agentKey] ?? analyst_signals[key];
      if (!signals) continue;
      const signal = signals[ticker];
      if (!signal) continue;

      // Skip risk management in signals section
      if (key === "risk_management") continue;

      const agentName = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      const signalType = (signal["signal"] as string) ?? "";
      const confidence = (signal["confidence"] as number) ?? 0;
      let reasoning = signal["reasoning"];
      let reasoningStr = "";
      if (typeof reasoning === "string") {
        reasoningStr = reasoning;
      } else if (reasoning != null) {
        reasoningStr = JSON.stringify(reasoning, null, 2);
      }

      agentTable.push([
        chalk.cyan(agentName),
        signalColor(signalType),
        chalk.white(`${confidence}%`),
        chalk.white(wrapText(reasoningStr)),
      ]);
    }

    console.log(`\n${chalk.bold.white("AGENT ANALYSIS:")} [${chalk.cyan(ticker)}]`);
    console.log(agentTable.toString());

    // ── Trading decision table ──
    const action = (decision["action"] as string) ?? "";
    const quantity = decision["quantity"] as number;
    const confidence = decision["confidence"] as number;
    const reasoning = decision["reasoning"] as string | undefined;
    const reasoningStr = wrapText(reasoning ?? "");

    const decisionTable = new Table({ colWidths: [16, 64], wordWrap: true });
    decisionTable.push(
      ["Action", actionColor(action)],
      ["Quantity", actionColor(String(quantity))],
      ["Confidence", chalk.white(`${typeof confidence === "number" ? confidence.toFixed(1) : confidence}%`)],
      ["Reasoning", chalk.white(reasoningStr)]
    );

    console.log(`\n${chalk.bold.white("TRADING DECISION:")} [${chalk.cyan(ticker)}]`);
    console.log(decisionTable.toString());
  }

  // ── Portfolio summary table ──
  const portfolioTable = new Table({
    head: [
      chalk.white("Ticker"),
      chalk.white("Action"),
      chalk.white("Quantity"),
      chalk.white("Confidence"),
      chalk.green("Bullish"),
      chalk.red("Bearish"),
      chalk.yellow("Neutral"),
    ],
  });

  for (const [ticker, decision] of Object.entries(decisions)) {
    const action = (decision["action"] as string) ?? "";
    const quantity = decision["quantity"] as number;
    const confidence = decision["confidence"] as number;

    let bullishCount = 0;
    let bearishCount = 0;
    let neutralCount = 0;

    for (const signals of Object.values(analyst_signals)) {
      const s = signals[ticker];
      if (!s) continue;
      const sig = ((s["signal"] as string) ?? "").toUpperCase();
      if (sig === "BULLISH") bullishCount++;
      else if (sig === "BEARISH") bearishCount++;
      else if (sig === "NEUTRAL") neutralCount++;
    }

    portfolioTable.push([
      chalk.cyan(ticker),
      actionColor(action),
      actionColor(String(quantity)),
      chalk.white(`${typeof confidence === "number" ? confidence.toFixed(1) : confidence}%`),
      chalk.green(String(bullishCount)),
      chalk.red(String(bearishCount)),
      chalk.yellow(String(neutralCount)),
    ]);
  }

  console.log(`\n${chalk.bold.white("PORTFOLIO SUMMARY:")}`);
  console.log(portfolioTable.toString());
}

// ─── runGraphAsync helper ─────────────────────────────────────────────────────

async function runGraphAsync(
  graph: ReturnType<typeof createGraph>,
  portfolio: Record<string, unknown>,
  tickers: string[],
  startDate: string,
  endDate: string,
  modelName: string,
  modelProvider: string
): Promise<TradingResult> {
  const result = await runGraph(graph, portfolio, tickers, startDate, endDate, modelName, modelProvider);

  const messages = (result["messages"] as Array<{ content: unknown }> | undefined) ?? [];
  const lastContent = messages[messages.length - 1]?.content;
  const contentStr = typeof lastContent === "string" ? lastContent : JSON.stringify(lastContent ?? "{}");

  let decisions: Record<string, Record<string, unknown>> | null = null;
  try {
    decisions = JSON.parse(contentStr) as Record<string, Record<string, unknown>>;
  } catch {
    decisions = null;
  }

  const data = result["data"] as Record<string, unknown> | undefined;
  const analystSignals = (data?.["analyst_signals"] as Record<
    string,
    Record<string, Record<string, unknown>>
  >) ?? {};

  return { decisions, analyst_signals: analystSignals };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const program = new Command();

  const today = format(new Date(), "yyyy-MM-dd");
  const threeMonthsAgo = format(subMonths(new Date(), 3), "yyyy-MM-dd");

  program
    .name("ai-hedge-fund")
    .description("AI Hedge Fund — run analyst agents and get trading decisions")
    .requiredOption("--tickers <tickers>", "Comma-separated stock tickers, e.g. AAPL,MSFT")
    .option("--start-date <date>", "Start date YYYY-MM-DD", threeMonthsAgo)
    .option("--end-date <date>", "End date YYYY-MM-DD", today)
    .option("--initial-cash <number>", "Starting cash", parseFloat, 100000)
    .option("--margin-requirement <number>", "Margin requirement 0–1", parseFloat, 0.0)
    .option("--analysts <analysts>", "Comma-separated analyst keys; omit for interactive selection")
    .option("--model <model>", "LLM model name", "gpt-4.1")
    .option("--provider <provider>", "LLM provider", "OPENAI")
    .option("--reasoning", "Show agent reasoning", false)
    .option("--show-graph", "Save graph PNG (not implemented in Node.js CLI)", false)
    .parse(process.argv);

  const opts = program.opts<{
    tickers: string;
    startDate: string;
    endDate: string;
    initialCash: number;
    marginRequirement: number;
    analysts?: string;
    model: string;
    provider: string;
    reasoning: boolean;
    showGraph: boolean;
  }>();

  // Parse tickers
  const tickers = opts.tickers
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  if (tickers.length === 0) {
    console.error(chalk.red("Error: --tickers must contain at least one ticker symbol."));
    process.exit(1);
  }

  // Resolve analyst selection
  let selectedAnalysts: string[];

  if (opts.analysts) {
    selectedAnalysts = opts.analysts
      .split(",")
      .map((a) => a.trim())
      .filter((a) => a in ANALYST_CONFIG && a !== "portfolio_manager");

    if (selectedAnalysts.length === 0) {
      console.error(chalk.red("Error: None of the specified analysts are valid."));
      process.exit(1);
    }
  } else {
    // Interactive selection
    const analystChoices = Object.entries(ANALYST_CONFIG)
      .filter(([key]) => key !== "portfolio_manager")
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([key, cfg]) => ({
        name: cfg.display_name,
        value: key,
        checked: true,
      }));

    selectedAnalysts = await checkbox({
      message: "Select analysts to include:",
      choices: analystChoices,
    });

    if (selectedAnalysts.length === 0) {
      console.error(chalk.red("Error: You must select at least one analyst."));
      process.exit(1);
    }
  }

  console.log(
    chalk.cyan("\nSelected analysts: ") +
      selectedAnalysts
        .map((a) => chalk.green(ANALYST_CONFIG[a]?.display_name ?? a))
        .join(", ") +
      "\n"
  );

  // Build portfolio
  const portfolio = createPortfolio(opts.initialCash, opts.marginRequirement, tickers);

  // Build graph
  const graphNodes = buildDefaultGraphNodes(selectedAnalysts);
  const graphEdges = buildDefaultGraphEdges(selectedAnalysts);
  const graph = createGraph(graphNodes, graphEdges);

  console.log(chalk.white(`\nRunning hedge fund analysis from ${opts.startDate} to ${opts.endDate}…\n`));

  try {
    const result = await runGraphAsync(
      graph,
      portfolio,
      tickers,
      opts.startDate,
      opts.endDate,
      opts.model,
      opts.provider
    );

    printTradingOutput(result);
  } catch (err) {
    console.error(chalk.red(`\nError: ${String(err)}`));
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(chalk.red(String(err)));
  process.exit(1);
});
