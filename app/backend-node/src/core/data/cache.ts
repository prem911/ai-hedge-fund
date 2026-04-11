import fs from "fs";
import path from "path";

const CACHE_DIR = path.resolve(process.cwd(), "cache");

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function cacheFilePath(key: string): string {
  // Sanitize key to be safe for filenames
  const safe = key.replace(/[^a-zA-Z0-9_\-.]/g, "_");
  return path.join(CACHE_DIR, `${safe}.json`);
}

function readCache<T>(key: string): T | null {
  const filePath = cacheFilePath(key);
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      return JSON.parse(raw) as T;
    }
  } catch {
    // Corrupt cache — ignore
  }
  return null;
}

function writeCache<T>(key: string, data: T): void {
  ensureCacheDir();
  const filePath = cacheFilePath(key);
  fs.writeFileSync(filePath, JSON.stringify(data), "utf8");
}

// ─── Cache class ──────────────────────────────────────────────────────────────
class Cache {
  getPrices(key: string): Record<string, unknown>[] | null {
    return readCache<Record<string, unknown>[]>(key);
  }

  setPrices(key: string, data: Record<string, unknown>[]): void {
    writeCache(key, data);
  }

  getFinancialMetrics(key: string): Record<string, unknown>[] | null {
    return readCache<Record<string, unknown>[]>(key);
  }

  setFinancialMetrics(key: string, data: Record<string, unknown>[]): void {
    writeCache(key, data);
  }

  getInsiderTrades(key: string): Record<string, unknown>[] | null {
    return readCache<Record<string, unknown>[]>(key);
  }

  setInsiderTrades(key: string, data: Record<string, unknown>[]): void {
    writeCache(key, data);
  }

  getCompanyNews(key: string): Record<string, unknown>[] | null {
    return readCache<Record<string, unknown>[]>(key);
  }

  setCompanyNews(key: string, data: Record<string, unknown>[]): void {
    writeCache(key, data);
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────
let _cache: Cache | null = null;

export function getCache(): Cache {
  if (!_cache) {
    _cache = new Cache();
  }
  return _cache;
}

export { Cache };
