# 🐝 SWARM — Agentic Memecoin Trading Network

An AI-powered multi-agent trading swarm for Solana memecoins. Built with Bun.

## Architecture

```
┌─────────────────────────────────────────────┐
│              ORCHESTRATOR                    │
│  Deploys, coordinates, and manages agents   │
├─────────┬──────────┬──────────┬─────────────┤
│Narrative│  Coin    │  Whale   │    Risk     │
│ Scanner │  Hunter  │ Tracker  │  Manager   │
│         │          │          │            │
│Finds    │Discovers │Tracks    │Stop loss   │
│trending │tokens    │smart     │Take profit │
│metas    │via AI    │money     │Portfolio   │
│         │scoring   │wallets   │heat mgmt   │
├─────────┴──────────┴──────────┴─────────────┤
│              EXECUTOR                        │
│  Jupiter V6 swaps · Buy/Sell · TX confirm    │
├──────────────────────────────────────────────┤
│              DATA LAYER                      │
│  DexScreener · Jupiter · Solana RPC          │
└──────────────────────────────────────────────┘
```

## Agent Swarm

| Agent | Role | Interval |
|-------|------|----------|
| **Narrative Scanner** | Scans DexScreener for trending tokens, uses LLM to identify market narratives | 2 min |
| **Coin Hunter** | Discovers new tokens, filters by liquidity/mcap/volume, AI-scores each one | 1 min |
| **Whale Tracker** | Monitors smart money wallet activity (coming: Helius webhooks) | — |
| **Risk Manager** | Monitors open positions, enforces stop-loss/take-profit, checks liquidity | 30s |
| **Executor** | Executes Jupiter swaps, manages transaction confirmation | On-demand |
| **Backtester** | Learns from trade history to improve scoring (coming) | — |

## Quick Start

```bash
# 1. Clone / copy project
cd swarm

# 2. Install dependencies
bun install

# 3. Set up environment
cp .env.example .env
# Edit .env with your API keys

# 4. Run
bun run dev
# or
bun run src/index.ts

# 5. Open dashboard
# http://localhost:3000
```

## Setup on GitHub Codespaces

1. Create a new Codespace
2. In the terminal:
```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# Clone/upload project files
cd swarm
bun install
cp .env.example .env
# Edit .env with your keys

bun run dev
```
3. Codespaces will auto-forward port 3000 — click the link to open the dashboard

## Configuration

All config can be set via:
- **Dashboard UI** → Config tab (overrides .env for current session)
- **.env file** → Persistent defaults
- **API** → POST /api/start with config JSON

### Risk Parameters

| Param | Default | Description |
|-------|---------|-------------|
| maxPositionSol | 0.05 | Max SOL per trade |
| stopLossPct | 30 | Stop loss percentage |
| takeProfitPct | 100 | Take profit percentage |
| maxConcurrentTrades | 3 | Max open positions |
| minScoreToTrade | 80 | Minimum AI score to auto-buy |
| slippageBps | 500 | Slippage tolerance (5%) |

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/start | Start the swarm (send config JSON) |
| POST | /api/stop | Stop the swarm |
| GET | /api/status | Get agent statuses |
| GET | /api/positions | Get all positions |
| GET | /api/tokens | Get scanned tokens with scores |
| GET | /api/narratives | Get detected narratives |
| GET | /api/history | Get trade history |
| GET | /api/balance | Get wallet balance |
| GET | /api/logs | Get recent logs |
| POST | /api/buy | Manual buy `{tokenAddress, solAmount}` |
| POST | /api/sell | Manual sell `{positionId}` |
| GET | /api/search?q= | Search tokens |

WebSocket at `/ws` for real-time logs and status updates.

## ⚠️ Risk Warning

This is experimental software that trades real money. You will lose money.

- **Use a dedicated wallet** with only what you can afford to lose
- **Start with minimum amounts** (0.01-0.05 SOL)
- **Monitor positions actively** — AI scoring is not perfect
- **Memecoins are extremely volatile** — 90%+ go to zero
- The default public Solana RPC is slow; use Helius/Quicknode for real trading
