import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// ─── Test 1: extractBaseAgentKey ──────────────────────────────────────────────
import { extractBaseAgentKey, parseHedgeFundResponse } from "../services/graphService.js";

describe("extractBaseAgentKey", () => {
  it("strips 6-char alphanumeric suffix", () => {
    expect(extractBaseAgentKey("warren_buffett_abc123")).toBe("warren_buffett");
  });

  it("strips suffix from single-part key", () => {
    expect(extractBaseAgentKey("technical_analyst_x9z1w2")).toBe("technical_analyst");
  });

  it("returns original when no suffix pattern", () => {
    expect(extractBaseAgentKey("warren_buffett")).toBe("warren_buffett");
  });

  it("returns original for short suffix (not 6 chars)", () => {
    expect(extractBaseAgentKey("ben_graham_abc")).toBe("ben_graham_abc");
  });

  it("handles portfolio_manager node ID", () => {
    expect(extractBaseAgentKey("portfolio_manager_zz1234")).toBe("portfolio_manager");
  });

  it("does not strip when suffix contains uppercase", () => {
    // Our regex is ^[a-z0-9]+$ — uppercase should NOT be stripped
    expect(extractBaseAgentKey("warren_buffett_ABC123")).toBe("warren_buffett_ABC123");
  });
});

// ─── Test 2: parseHedgeFundResponse ──────────────────────────────────────────
describe("parseHedgeFundResponse", () => {
  it("parses valid JSON string", () => {
    const input = JSON.stringify({ action: "buy", ticker: "AAPL", quantity: 10 });
    const result = parseHedgeFundResponse(input);
    expect(result).toEqual({ action: "buy", ticker: "AAPL", quantity: 10 });
  });

  it("returns null for invalid JSON", () => {
    const result = parseHedgeFundResponse("not json at all {{{");
    expect(result).toBeNull();
  });

  it("returns null for empty string", () => {
    const result = parseHedgeFundResponse("");
    expect(result).toBeNull();
  });

  it("parses nested JSON correctly", () => {
    const data = {
      decisions: { AAPL: { action: "buy", quantity: 5 } },
      analyst_signals: { warren_buffett: { signal: "bullish" } },
    };
    const result = parseHedgeFundResponse(JSON.stringify(data));
    expect(result).toEqual(data);
  });

  it("returns parsed value for number-only JSON (valid JSON)", () => {
    // JSON.parse("42") is valid and returns 42, not null
    const result = parseHedgeFundResponse("42");
    expect(result).toBe(42);
  });
});

// ─── Test 3: Cache layer ──────────────────────────────────────────────────────
describe("Cache", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    // Use a temp dir to avoid polluting the real cache
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hedge-fund-cache-test-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for missing key", async () => {
    // Dynamic import to get a fresh cache instance scoped to tmp dir
    const { getCache } = await import("../core/data/cache.js?t=" + Date.now());
    const cache = getCache();
    expect(cache.getPrices("AAPL_2024-01-01_2024-12-31")).toBeNull();
  });

  it("stores and retrieves prices", async () => {
    const { getCache } = await import("../core/data/cache.js?t=" + Date.now() + "x");
    const cache = getCache();
    const key = "AAPL_2024-01-01_2024-12-31";
    const prices = [{ open: 100, close: 105, high: 110, low: 98, volume: 1000000, time: "2024-01-01" }];
    cache.setPrices(key, prices);
    const retrieved = cache.getPrices(key);
    expect(retrieved).toEqual(prices);
  });

  it("stores and retrieves financial metrics", async () => {
    const { getCache } = await import("../core/data/cache.js?t=" + Date.now() + "y");
    const cache = getCache();
    const key = "AAPL_ttm_2024-12-31_10";
    const metrics = [{ ticker: "AAPL", report_period: "2024-12-31", market_cap: 3e12 }];
    cache.setFinancialMetrics(key, metrics);
    const retrieved = cache.getFinancialMetrics(key);
    expect(retrieved).toEqual(metrics);
  });

  it("stores and retrieves insider trades", async () => {
    const { getCache } = await import("../core/data/cache.js?t=" + Date.now() + "z");
    const cache = getCache();
    const key = "AAPL_none_2024-12-31_1000";
    const trades = [{ ticker: "AAPL", filing_date: "2024-01-15", transaction_value: 500000 }];
    cache.setInsiderTrades(key, trades);
    const retrieved = cache.getInsiderTrades(key);
    expect(retrieved).toEqual(trades);
  });

  it("stores and retrieves company news", async () => {
    const { getCache } = await import("../core/data/cache.js?t=" + Date.now() + "w");
    const cache = getCache();
    const key = "AAPL_none_2024-12-31_1000";
    const news = [{ ticker: "AAPL", title: "Apple Reports Q4 Earnings", date: "2024-11-01", source: "Reuters", url: "https://example.com" }];
    cache.setCompanyNews(key, news);
    const retrieved = cache.getCompanyNews(key);
    expect(retrieved).toEqual(news);
  });
});
