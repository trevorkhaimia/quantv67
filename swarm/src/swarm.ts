// src/swarm.ts — Orchestrator + All Agents

import { Database } from "bun:sqlite";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { llmChat, llmScore, llmNarrativeAnalysis, type LLMConfig } from "./llm";
import {
  getTrendingTokens,
  getNewPairs,
  getTokenByAddress,
  searchTokens,
  executeBuy,
  executeSell,
  getWalletBalance,
  createWallet,
  getConnection,
  formatMcap,
  formatAge,
  type TokenInfo,
  type TradeResult,
} from "./trading";

// ============================================================
// TYPES
// ============================================================

export interface SwarmConfig {
  openrouterKey: string;
  model: string;
  rpcUrl: string;
  walletKey: string;
  maxPositionSol: number;
  stopLossPct: number;
  takeProfitPct: number;
  maxConcurrentTrades: number;
  minScoreToTrade: number;
  scanIntervalMs: number;
  slippageBps: number;
}

export interface AgentStatus {
  id: string;
  name: string;
  status: "idle" | "running" | "error" | "waiting";
  lastRun?: number;
  lastResult?: string;
}

export interface Position {
  id: number;
  tokenAddress: string;
  symbol: string;
  entryPrice: number;
  entrySol: number;
  tokenAmount: number;
  tokenDecimals: number;
  currentPrice: number;
  pnlPct: number;
  status: "OPEN" | "CLOSED" | "STOPPED" | "TP_HIT";
  entryTx: string;
  exitTx?: string;
  entryTime: number;
  exitTime?: number;
  score: number;
  narrative: string;
}

export interface SwarmLog {
  timestamp: number;
  agent: string;
  type: "info" | "success" | "warn" | "error" | "cmd" | "trade";
  message: string;
}

type LogCallback = (log: SwarmLog) => void;

// ============================================================
// DATABASE
// ============================================================

function initDB(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_address TEXT NOT NULL,
    symbol TEXT NOT NULL,
    entry_price REAL NOT NULL,
    entry_sol REAL NOT NULL,
    token_amount REAL NOT NULL,
    token_decimals INTEGER DEFAULT 6,
    current_price REAL DEFAULT 0,
    pnl_pct REAL DEFAULT 0,
    status TEXT DEFAULT 'OPEN',
    entry_tx TEXT,
    exit_tx TEXT,
    entry_time INTEGER NOT NULL,
    exit_time INTEGER,
    score REAL DEFAULT 0,
    narrative TEXT DEFAULT ''
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS scanned_tokens (
    address TEXT PRIMARY KEY,
    symbol TEXT,
    score REAL,
    signal TEXT,
    reasoning TEXT,
    narrative TEXT,
    mcap REAL,
    liquidity REAL,
    first_seen INTEGER,
    last_seen INTEGER,
    times_seen INTEGER DEFAULT 1
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS narratives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    score REAL NOT NULL,
    trend TEXT,
    tokens TEXT,
    updated_at INTEGER NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS trade_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_address TEXT,
    symbol TEXT,
    side TEXT,
    sol_amount REAL,
    token_amount REAL,
    price REAL,
    tx_hash TEXT,
    success INTEGER,
    error TEXT,
    timestamp INTEGER
  )`);
}

// ============================================================
// SWARM ORCHESTRATOR
// ============================================================

export class Swarm {
  private config: SwarmConfig;
  private db: Database;
  private connection!: Connection;
  private wallet!: Keypair;
  private llmConfig!: LLMConfig;
  private running = false;
  private agents: Map<string, AgentStatus> = new Map();
  private intervals: Timer[] = [];
  private onLog: LogCallback;
  private tokenCache: Map<string, { token: TokenInfo; score: number; signal: string; narrative: string }> = new Map();

  constructor(config: SwarmConfig, onLog: LogCallback) {
    this.config = config;
    this.onLog = onLog;
    this.db = new Database("db/swarm.db");
    initDB(this.db);

    // Init agents
    const agentDefs = [
      { id: "narrative", name: "Narrative Scanner" },
      { id: "hunter", name: "Coin Hunter" },
      { id: "whale", name: "Whale Tracker" },
      { id: "risk", name: "Risk Manager" },
      { id: "executor", name: "Executor" },
      { id: "backtest", name: "Backtester" },
    ];
    for (const a of agentDefs) {
      this.agents.set(a.id, { ...a, status: "idle" });
    }
  }

  log(agent: string, type: SwarmLog["type"], message: string) {
    const entry: SwarmLog = { timestamp: Date.now(), agent, type, message };
    this.onLog(entry);
  }

  getAgentStatuses(): AgentStatus[] {
    return Array.from(this.agents.values());
  }

  getPositions(): Position[] {
    const rows = this.db.query("SELECT * FROM positions ORDER BY entry_time DESC").all() as any[];
    return rows.map((r) => ({
      id: r.id,
      tokenAddress: r.token_address,
      symbol: r.symbol,
      entryPrice: r.entry_price,
      entrySol: r.entry_sol,
      tokenAmount: r.token_amount,
      tokenDecimals: r.token_decimals,
      currentPrice: r.current_price,
      pnlPct: r.pnl_pct,
      status: r.status,
      entryTx: r.entry_tx,
      exitTx: r.exit_tx,
      entryTime: r.entry_time,
      exitTime: r.exit_time,
      score: r.score,
      narrative: r.narrative,
    }));
  }

  getScannedTokens() {
    return this.db.query("SELECT * FROM scanned_tokens ORDER BY score DESC LIMIT 50").all();
  }

  getNarratives() {
    return this.db.query("SELECT * FROM narratives ORDER BY score DESC LIMIT 10").all();
  }

  getTradeHistory() {
    return this.db.query("SELECT * FROM trade_history ORDER BY timestamp DESC LIMIT 100").all();
  }

  // ---- START / STOP ----

  async start() {
    if (this.running) return;

    this.log("orchestrator", "cmd", "$ swarm.start() — Initializing...");

    // Validate config
    if (!this.config.openrouterKey) {
      this.log("orchestrator", "error", "Missing OpenRouter API key");
      return;
    }
    if (!this.config.rpcUrl) {
      this.log("orchestrator", "error", "Missing Solana RPC URL");
      return;
    }

    this.llmConfig = {
      apiKey: this.config.openrouterKey,
      model: this.config.model || "deepseek/deepseek-chat",
    };

    this.connection = getConnection(this.config.rpcUrl);

    if (this.config.walletKey) {
      try {
        this.wallet = createWallet(this.config.walletKey);
        const bal = await this.connection.getBalance(this.wallet.publicKey);
        this.log("orchestrator", "success", `Wallet loaded: ${this.wallet.publicKey.toBase58().slice(0, 8)}... (${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
      } catch (e: any) {
        this.log("orchestrator", "error", `Wallet error: ${e.message}`);
        return;
      }
    } else {
      this.log("orchestrator", "warn", "No wallet key — running in SCAN-ONLY mode (no trades)");
    }

    this.running = true;

    // Deploy agents with staggered starts
    this.setAgentStatus("narrative", "running");
    this.log("narrative", "success", "Narrative Scanner deployed");

    this.setAgentStatus("hunter", "running");
    this.log("hunter", "success", "Coin Hunter deployed");

    this.setAgentStatus("whale", "running");
    this.log("whale", "success", "Whale Tracker deployed");

    this.setAgentStatus("risk", "running");
    this.log("risk", "success", "Risk Manager deployed");

    this.setAgentStatus("executor", "running");
    this.log("executor", "success", "Executor deployed");

    this.setAgentStatus("backtest", "running");
    this.log("backtest", "success", "Backtester deployed");

    this.log("orchestrator", "success", "⚡ All agents online — Swarm is hunting");

    // Run initial scan
    await this.runNarrativeScanner();
    await this.runCoinHunter();

    // Schedule recurring agent loops
    const scanInterval = this.config.scanIntervalMs || 60000;

    this.intervals.push(
      setInterval(() => this.runNarrativeScanner(), scanInterval * 2),
      setInterval(() => this.runCoinHunter(), scanInterval),
      setInterval(() => this.runRiskManager(), 30000),
      setInterval(() => this.runPriceUpdater(), 20000),
    );
  }

  stop() {
    this.running = false;
    for (const iv of this.intervals) clearInterval(iv);
    this.intervals = [];

    for (const [id] of this.agents) {
      this.setAgentStatus(id, "idle");
    }

    this.log("orchestrator", "warn", "$ swarm.stop() — All agents recalled");
  }

  private setAgentStatus(id: string, status: AgentStatus["status"], lastResult?: string) {
    const agent = this.agents.get(id);
    if (agent) {
      agent.status = status;
      agent.lastRun = Date.now();
      if (lastResult) agent.lastResult = lastResult;
    }
  }

  // ============================================================
  // NARRATIVE SCANNER AGENT
  // ============================================================

  private async runNarrativeScanner() {
    if (!this.running) return;
    this.setAgentStatus("narrative", "running");

    try {
      this.log("narrative", "info", "Scanning trending tokens for narratives...");

      const trending = await getTrendingTokens();
      const newPairs = await getNewPairs(3000);
      const allTokens = [...trending, ...newPairs];

      if (allTokens.length === 0) {
        this.log("narrative", "warn", "No tokens found from DexScreener");
        return;
      }

      // Build summary for LLM
      const summary = allTokens
        .slice(0, 30)
        .map(
          (t) =>
            `${t.symbol} | MC: ${formatMcap(t.mcap)} | Vol: ${formatMcap(t.volume24h)} | Liq: ${formatMcap(t.liquidity)} | 24h: ${t.priceChange24h.toFixed(1)}% | Age: ${formatAge(t.createdAt)} | Buys/Sells: ${t.txns24h.buys}/${t.txns24h.sells}`
        )
        .join("\n");

      const analysis = await llmNarrativeAnalysis(this.llmConfig, summary);

      // Save narratives
      this.db.run("DELETE FROM narratives");
      for (const n of analysis.narratives) {
        this.db.run(
          "INSERT INTO narratives (name, score, trend, tokens, updated_at) VALUES (?, ?, ?, ?, ?)",
          [n.name, n.score, n.trend, JSON.stringify(n.tokens), Date.now()]
        );
        this.log("narrative", n.score > 80 ? "success" : "info", `${n.name}: score ${n.score} (${n.trend}) — ${n.tokens.join(", ")}`);
      }

      this.setAgentStatus("narrative", "running", `Found ${analysis.narratives.length} narratives`);
    } catch (e: any) {
      this.log("narrative", "error", `Narrative scan failed: ${e.message}`);
      this.setAgentStatus("narrative", "error", e.message);
    }
  }

  // ============================================================
  // COIN HUNTER AGENT
  // ============================================================

  private async runCoinHunter() {
    if (!this.running) return;
    this.setAgentStatus("hunter", "running");

    try {
      this.log("hunter", "info", "Hunting for alpha...");

      // Get trending + new
      const trending = await getTrendingTokens();
      const newPairs = await getNewPairs(5000);
      const allTokens = [...trending, ...newPairs];

      // Deduplicate
      const seen = new Set<string>();
      const unique = allTokens.filter((t) => {
        if (seen.has(t.address)) return false;
        seen.add(t.address);
        return true;
      });

      // Filter basics
      const filtered = unique.filter(
        (t) =>
          t.liquidity >= 5000 &&
          t.mcap > 10000 &&
          t.mcap < 50_000_000 &&
          t.volume24h > 1000 &&
          t.txns24h.buys > 5
      );

      this.log("hunter", "info", `Found ${filtered.length} candidates after filtering`);

      // Score each with LLM
      let scored = 0;
      for (const token of filtered.slice(0, 15)) {
        if (!this.running) break;

        // Check if already scored recently
        const existing = this.db.query("SELECT * FROM scanned_tokens WHERE address = ?").get(token.address) as any;
        if (existing && Date.now() - existing.last_seen < 300000) {
          continue; // Skip if scored within 5 min
        }

        const buyRatio = token.txns24h.buys / Math.max(token.txns24h.sells, 1);
        const prompt = `Analyze this Solana memecoin for trading potential:
Token: ${token.symbol} (${token.name})
Market Cap: ${formatMcap(token.mcap)}
Liquidity: ${formatMcap(token.liquidity)}
24h Volume: ${formatMcap(token.volume24h)}
Price Change: 5m: ${token.priceChange5m.toFixed(1)}% | 1h: ${token.priceChange1h.toFixed(1)}% | 24h: ${token.priceChange24h.toFixed(1)}%
Buy/Sell Ratio (24h): ${buyRatio.toFixed(2)} (${token.txns24h.buys} buys / ${token.txns24h.sells} sells)
Age: ${formatAge(token.createdAt)}
DEX: ${token.dexId}
FDV: ${formatMcap(token.fdv)}`;

        try {
          const result = await llmScore(this.llmConfig, prompt);

          // Get narrative context
          const narratives = this.db.query("SELECT name FROM narratives ORDER BY score DESC").all() as any[];
          const narrative = narratives.find((n: any) =>
            token.symbol.toLowerCase().includes(n.name.toLowerCase().split(" ")[0]) ||
            token.name.toLowerCase().includes(n.name.toLowerCase().split(" ")[0])
          )?.name || "Unknown";

          // Upsert scanned token
          this.db.run(
            `INSERT INTO scanned_tokens (address, symbol, score, signal, reasoning, narrative, mcap, liquidity, first_seen, last_seen, times_seen)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
             ON CONFLICT(address) DO UPDATE SET
               score = ?, signal = ?, reasoning = ?, narrative = ?, mcap = ?, liquidity = ?, last_seen = ?, times_seen = times_seen + 1`,
            [
              token.address, token.symbol, result.score, result.signal, result.reasoning, narrative, token.mcap, token.liquidity, Date.now(), Date.now(),
              result.score, result.signal, result.reasoning, narrative, token.mcap, token.liquidity, Date.now(),
            ]
          );

          this.tokenCache.set(token.address, { token, score: result.score, signal: result.signal, narrative });

          const logType = result.score >= 85 ? "success" : result.score >= 70 ? "warn" : "info";
          this.log("hunter", logType, `${token.symbol} → Score: ${result.score} | Signal: ${result.signal} | ${result.reasoning}`);

          // AUTO-BUY if score is high enough
          if (
            result.signal === "BUY" &&
            result.score >= this.config.minScoreToTrade &&
            this.wallet
          ) {
            await this.executeTrade(token, result.score, narrative);
          }

          scored++;
        } catch (e: any) {
          this.log("hunter", "error", `Failed to score ${token.symbol}: ${e.message}`);
        }

        // Rate limit
        await new Promise((r) => setTimeout(r, 1000));
      }

      this.setAgentStatus("hunter", "running", `Scored ${scored} tokens`);
    } catch (e: any) {
      this.log("hunter", "error", `Coin hunter failed: ${e.message}`);
      this.setAgentStatus("hunter", "error", e.message);
    }
  }

  // ============================================================
  // RISK MANAGER AGENT
  // ============================================================

  private async runRiskManager() {
    if (!this.running) return;
    this.setAgentStatus("risk", "running");

    try {
      const openPositions = this.db.query("SELECT * FROM positions WHERE status = 'OPEN'").all() as any[];

      if (openPositions.length === 0) {
        this.setAgentStatus("risk", "running", "No open positions");
        return;
      }

      for (const pos of openPositions) {
        // Check stop loss
        if (pos.pnl_pct <= -this.config.stopLossPct) {
          this.log("risk", "error", `⛔ ${pos.symbol} hit stop loss at ${pos.pnl_pct.toFixed(1)}% — closing position`);
          await this.closePosition(pos.id, "STOPPED");
        }
        // Check take profit
        else if (pos.pnl_pct >= this.config.takeProfitPct) {
          this.log("risk", "success", `🎯 ${pos.symbol} hit take profit at ${pos.pnl_pct.toFixed(1)}% — taking profits`);
          await this.closePosition(pos.id, "TP_HIT");
        }
        // Check if liquidity dropped dangerously
        else {
          const tokenData = await getTokenByAddress(pos.token_address);
          if (tokenData && tokenData.liquidity < 3000) {
            this.log("risk", "warn", `⚠️ ${pos.symbol} liquidity dropped to ${formatMcap(tokenData.liquidity)} — emergency exit`);
            await this.closePosition(pos.id, "STOPPED");
          }
        }
      }

      // Portfolio heat check
      const totalExposure = openPositions.reduce((sum: number, p: any) => sum + p.entry_sol, 0);
      if (this.wallet) {
        const bal = await this.connection.getBalance(this.wallet.publicKey);
        const solBal = bal / LAMPORTS_PER_SOL;
        const heatPct = totalExposure / (solBal + totalExposure) * 100;
        this.log("risk", "info", `Portfolio heat: ${heatPct.toFixed(0)}% | ${openPositions.length} open positions | ${totalExposure.toFixed(4)} SOL exposed`);
      }

      this.setAgentStatus("risk", "running", `Monitoring ${openPositions.length} positions`);
    } catch (e: any) {
      this.log("risk", "error", `Risk check failed: ${e.message}`);
      this.setAgentStatus("risk", "error", e.message);
    }
  }

  // ============================================================
  // PRICE UPDATER (feeds Risk Manager)
  // ============================================================

  private async runPriceUpdater() {
    if (!this.running) return;

    const openPositions = this.db.query("SELECT * FROM positions WHERE status = 'OPEN'").all() as any[];
    for (const pos of openPositions) {
      try {
        const tokenData = await getTokenByAddress(pos.token_address);
        if (tokenData) {
          const pnlPct = ((tokenData.price - pos.entry_price) / pos.entry_price) * 100;
          this.db.run(
            "UPDATE positions SET current_price = ?, pnl_pct = ? WHERE id = ?",
            [tokenData.price, pnlPct, pos.id]
          );
        }
      } catch { /* silent */ }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // ============================================================
  // TRADE EXECUTION
  // ============================================================

  private async executeTrade(token: TokenInfo, score: number, narrative: string) {
    if (!this.wallet) {
      this.log("executor", "warn", `Would buy ${token.symbol} but no wallet configured`);
      return;
    }

    // Check max concurrent
    const openCount = (this.db.query("SELECT COUNT(*) as c FROM positions WHERE status = 'OPEN'").get() as any).c;
    if (openCount >= this.config.maxConcurrentTrades) {
      this.log("executor", "warn", `Max concurrent trades (${this.config.maxConcurrentTrades}) reached — skipping ${token.symbol}`);
      return;
    }

    // Check if already holding
    const existing = this.db.query("SELECT * FROM positions WHERE token_address = ? AND status = 'OPEN'").get(token.address);
    if (existing) {
      this.log("executor", "info", `Already holding ${token.symbol} — skipping`);
      return;
    }

    // Check balance
    const balance = await this.connection.getBalance(this.wallet.publicKey);
    const solBal = balance / LAMPORTS_PER_SOL;
    const tradeSize = Math.min(this.config.maxPositionSol, solBal * 0.3); // Never more than 30% of wallet

    if (tradeSize < 0.005) {
      this.log("executor", "error", `Insufficient balance (${solBal.toFixed(4)} SOL) — cannot trade`);
      return;
    }

    this.setAgentStatus("executor", "running");
    this.log("executor", "cmd", `🔫 Executing BUY: ${token.symbol} | ${tradeSize.toFixed(4)} SOL | Score: ${score}`);

    const result = await executeBuy(
      this.connection,
      this.wallet,
      token.address,
      tradeSize,
      this.config.slippageBps
    );

    // Record trade
    this.db.run(
      `INSERT INTO trade_history (token_address, symbol, side, sol_amount, token_amount, price, tx_hash, success, error, timestamp)
       VALUES (?, ?, 'BUY', ?, ?, ?, ?, ?, ?, ?)`,
      [token.address, token.symbol, tradeSize, result.outputAmount || 0, result.price || 0, result.txHash || "", result.success ? 1 : 0, result.error || "", result.timestamp]
    );

    if (result.success) {
      // Create position
      this.db.run(
        `INSERT INTO positions (token_address, symbol, entry_price, entry_sol, token_amount, token_decimals, current_price, status, entry_tx, entry_time, score, narrative)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)`,
        [token.address, token.symbol, token.price, tradeSize, result.outputAmount || 0, 6, token.price, result.txHash || "", Date.now(), score, narrative]
      );

      this.log("executor", "success", `✅ BOUGHT ${token.symbol} | ${tradeSize.toFixed(4)} SOL | TX: ${result.txHash?.slice(0, 16)}...`);
    } else {
      this.log("executor", "error", `❌ BUY FAILED ${token.symbol}: ${result.error}`);
    }
  }

  private async closePosition(positionId: number, reason: string) {
    if (!this.wallet) return;

    const pos = this.db.query("SELECT * FROM positions WHERE id = ?").get(positionId) as any;
    if (!pos || pos.status !== "OPEN") return;

    this.log("executor", "cmd", `Closing ${pos.symbol} (${reason})...`);

    const result = await executeSell(
      this.connection,
      this.wallet,
      pos.token_address,
      pos.token_amount,
      pos.token_decimals,
      this.config.slippageBps
    );

    // Record trade
    this.db.run(
      `INSERT INTO trade_history (token_address, symbol, side, sol_amount, token_amount, price, tx_hash, success, error, timestamp)
       VALUES (?, ?, 'SELL', ?, ?, ?, ?, ?, ?, ?)`,
      [pos.token_address, pos.symbol, result.outputAmount || 0, pos.token_amount, result.price || 0, result.txHash || "", result.success ? 1 : 0, result.error || "", result.timestamp]
    );

    if (result.success) {
      this.db.run(
        "UPDATE positions SET status = ?, exit_tx = ?, exit_time = ?, current_price = ?, pnl_pct = ? WHERE id = ?",
        [reason, result.txHash || "", Date.now(), result.price || pos.current_price, pos.pnl_pct, positionId]
      );
      this.log("executor", "success", `✅ SOLD ${pos.symbol} | ${reason} | PnL: ${pos.pnl_pct.toFixed(1)}% | TX: ${result.txHash?.slice(0, 16)}...`);
    } else {
      this.log("executor", "error", `❌ SELL FAILED ${pos.symbol}: ${result.error}`);
    }
  }

  // ============================================================
  // MANUAL TRADE API
  // ============================================================

  async manualBuy(tokenAddress: string, solAmount: number): Promise<TradeResult | null> {
    if (!this.wallet) {
      this.log("executor", "error", "No wallet configured");
      return null;
    }

    const token = await getTokenByAddress(tokenAddress);
    if (!token) {
      this.log("executor", "error", `Token not found: ${tokenAddress}`);
      return null;
    }

    this.log("executor", "cmd", `Manual BUY: ${token.symbol} | ${solAmount} SOL`);

    const result = await executeBuy(this.connection, this.wallet, tokenAddress, solAmount, this.config.slippageBps);

    this.db.run(
      `INSERT INTO trade_history (token_address, symbol, side, sol_amount, token_amount, price, tx_hash, success, error, timestamp)
       VALUES (?, ?, 'BUY', ?, ?, ?, ?, ?, ?, ?)`,
      [tokenAddress, token.symbol, solAmount, result.outputAmount || 0, result.price || 0, result.txHash || "", result.success ? 1 : 0, result.error || "", result.timestamp]
    );

    if (result.success) {
      this.db.run(
        `INSERT INTO positions (token_address, symbol, entry_price, entry_sol, token_amount, token_decimals, current_price, status, entry_tx, entry_time, score, narrative)
         VALUES (?, ?, ?, ?, ?, 6, ?, 'OPEN', ?, ?, 0, 'Manual')`,
        [tokenAddress, token.symbol, token.price, solAmount, result.outputAmount || 0, token.price, result.txHash || "", Date.now()]
      );
      this.log("executor", "success", `✅ Manual BUY: ${token.symbol} | TX: ${result.txHash}`);
    } else {
      this.log("executor", "error", `❌ Manual BUY FAILED: ${result.error}`);
    }

    return result;
  }

  async manualSell(positionId: number): Promise<TradeResult | null> {
    if (!this.wallet) {
      this.log("executor", "error", "No wallet configured");
      return null;
    }

    const pos = this.db.query("SELECT * FROM positions WHERE id = ? AND status = 'OPEN'").get(positionId) as any;
    if (!pos) {
      this.log("executor", "error", `Position ${positionId} not found or not open`);
      return null;
    }

    this.log("executor", "cmd", `Manual SELL: ${pos.symbol}`);
    await this.closePosition(positionId, "CLOSED");
    return { success: true, inputAmount: pos.token_amount, timestamp: Date.now() };
  }

  // Search tokens by query
  async searchToken(query: string): Promise<TokenInfo[]> {
    return searchTokens(query);
  }

  // Get wallet balance
  async getBalance(): Promise<{ sol: number; address: string } | null> {
    if (!this.wallet) return null;
    const bal = await this.connection.getBalance(this.wallet.publicKey);
    return { sol: bal / LAMPORTS_PER_SOL, address: this.wallet.publicKey.toBase58() };
  }
}
