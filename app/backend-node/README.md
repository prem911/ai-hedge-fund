# AI Hedge Fund — Node.js Backend

A full Node.js/TypeScript migration of the Python FastAPI backend (`app/backend/`) and core data/tools layer (`src/data/`, `src/tools/`, `src/graph/`, `src/llm/`).

## Technology Stack

| Python (original) | Node.js (this backend) |
|---|---|
| FastAPI | Fastify v5 + `@fastify/cors` |
| Pydantic | Zod v3 |
| SQLAlchemy + Alembic | Drizzle ORM + Drizzle Kit (SQLite) |
| LangChain (Python) | `@langchain/core`, `@langchain/openai`, etc. |
| LangGraph (Python) | `@langchain/langgraph` |
| httpx / requests | Native `fetch` (Node 18+) |
| pandas `prices_to_df` | `danfojs-node` |
| colorama / tabulate | `chalk` + `cli-table3` |

## Installation

```bash
cd app/backend-node
npm install
```

## Database Setup

Generate and run migrations:

```bash
npm run db:generate
npm run db:migrate
```

This creates a `hedge_fund.db` SQLite database in the `app/backend-node/` directory.

You can override the database path via the `DATABASE_URL` environment variable:

```env
DATABASE_URL=./my_custom_path.db
```

## Development Server

```bash
npm run dev
```

This starts the Fastify server on **port 8000** (the same port as the Python backend), using `tsx watch` for hot-reloading.

## Production Build

```bash
npm run build
npm start
```

## Running Tests

```bash
npm test
```

Tests use [Vitest](https://vitest.dev/). Test files are in `src/__tests__/`.

## Environment Variables

Create a `.env` file in `app/backend-node/` (or use the root `.env.example`):

```env
# Financial data API
FINANCIAL_DATASETS_API_KEY=your_key_here

# LLM providers (set whichever you use)
OPENAI_API_KEY=your_key_here
ANTHROPIC_API_KEY=your_key_here
GROQ_API_KEY=your_key_here
GOOGLE_API_KEY=your_key_here
DEEPSEEK_API_KEY=your_key_here
XAI_API_KEY=your_key_here
OPENROUTER_API_KEY=your_key_here
GIGACHAT_API_KEY=your_key_here

# Azure OpenAI (if using Azure)
AZURE_OPENAI_API_KEY=your_key_here
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
AZURE_OPENAI_DEPLOYMENT_NAME=your-deployment-name

# Ollama (optional, defaults to localhost:11434)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_HOST=localhost

# Database
DATABASE_URL=./hedge_fund.db
```

## API Endpoints

The Node.js backend is a drop-in replacement for the Python FastAPI backend and exposes the same REST API:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/hedge-fund/run` | Run hedge fund analysis (SSE streaming) |
| `POST` | `/hedge-fund/backtest` | Run backtest (SSE streaming) |
| `GET` | `/hedge-fund/agents` | List available agents |
| `POST` | `/flows/` | Create a flow |
| `GET` | `/flows/` | List all flows |
| `GET` | `/flows/:id` | Get flow by ID |
| `PUT` | `/flows/:id` | Update flow |
| `DELETE` | `/flows/:id` | Delete flow |
| `POST` | `/flows/:id/duplicate` | Duplicate flow |
| `GET` | `/flows/search/:name` | Search flows by name |
| `POST` | `/flows/:id/runs` | Create flow run |
| `GET` | `/flows/:id/runs` | List flow runs |
| `GET` | `/flows/:id/runs/active` | Get active run |
| `GET` | `/flows/:id/runs/latest` | Get latest run |
| `GET` | `/flows/:id/runs/:runId` | Get run by ID |
| `PUT` | `/flows/:id/runs/:runId` | Update run |
| `DELETE` | `/flows/:id/runs/:runId` | Delete run |
| `DELETE` | `/flows/:id/runs` | Delete all runs |
| `GET` | `/flows/:id/runs/count` | Count runs |
| `POST` | `/api-keys/` | Create/update API key |
| `GET` | `/api-keys/` | List API keys |
| `GET` | `/api-keys/:provider` | Get API key |
| `PUT` | `/api-keys/:provider` | Update API key |
| `DELETE` | `/api-keys/:provider` | Delete API key |
| `POST` | `/api-keys/bulk` | Bulk create/update |
| `PATCH` | `/api-keys/:provider/deactivate` | Deactivate key |
| `PATCH` | `/api-keys/:provider/last-used` | Update last used |
| `GET` | `/ollama/status` | Ollama server status |
| `POST` | `/ollama/start` | Start Ollama server |
| `POST` | `/ollama/stop` | Stop Ollama server |
| `GET` | `/ollama/models/recommended` | Recommended Ollama models |
| `POST` | `/ollama/models/:name/download` | Download model |
| `GET` | `/ollama/models/:name/download/progress` | SSE download progress |
| `DELETE` | `/ollama/models/:name` | Delete model |
| `DELETE` | `/ollama/models/:name/cancel` | Cancel download |
| `GET` | `/ollama/models/:name/progress` | Download progress |
| `GET` | `/ollama/models/progress` | All download progress |
| `GET` | `/language-models/` | List language models |
| `GET` | `/language-models/providers` | List providers |
| `POST` | `/storage/save-json` | Save JSON to outputs/ |

## CORS

CORS is configured to allow:
- `http://localhost:5173` (Vite frontend dev server)
- `http://127.0.0.1:5173`

## Migration Status

| Phase | Scope | Status |
|---|---|---|
| **Phase 1** | Fastify API server, Drizzle ORM, Zod schemas, repositories, routes | ✅ Complete |
| **Phase 2** | Data models, financial API tools, LangGraph.js state graph, LLM provider wiring, agent scaffolds | ✅ Complete |
| **Phase 3+** | All 18 analyst agent implementations (warren_buffett, ben_graham, etc.) | 🔜 Pending |
| **Phase 4** | Full backtesting engine (day-by-day loop, trade execution, performance metrics) | 🔜 Pending |
| **Phase 5** | CLI interface | 🔜 Pending |

> The portfolio manager and risk manager agents are fully scaffolded (Phase 2). The remaining 18 analyst agents use placeholder implementations that return empty signals. Replace them with full implementations in Phase 3+.

## Notes

- All JSON fields in SQLite are stored as serialized strings (SQLite has no native JSON type in Drizzle).
- API keys stored in the database are used as fallback if not provided in the request.
- The cache layer uses file-based JSON storage in `./cache/`.
- `danfojs-node` is used for DataFrame operations (replacing pandas).
- GigaChat has no official LangChain.js package — a stub implementation is provided.
