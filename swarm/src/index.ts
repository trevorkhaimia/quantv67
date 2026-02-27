// src/index.ts — Main Bun Server with HTTP API + WebSocket + Static UI
// Run with: bun src/index.ts

import { Swarm, type SwarmConfig, type SwarmLog } from "./swarm";
import { readFileSync, existsSync, mkdirSync } from "fs";

// Ensure db directory exists
if (!existsSync("db")) mkdirSync("db");

const PORT = parseInt(process.env.PORT || "3000");

// ============================================================
// STATE
// ============================================================

let swarm: Swarm | null = null;
const wsClients = new Set<any>();
const logBuffer: SwarmLog[] = [];

function broadcast(type: string, data: any) {
  const msg = JSON.stringify({ type, data, timestamp: Date.now() });
  for (const ws of wsClients) {
    try {
      ws.send(msg);
    } catch {
      wsClients.delete(ws);
    }
  }
}

function onSwarmLog(log: SwarmLog) {
  logBuffer.push(log);
  if (logBuffer.length > 500) logBuffer.splice(0, 100);
  broadcast("log", log);
}

// ============================================================
// BUN SERVER
// ============================================================

const server = Bun.serve({
  port: PORT,

  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    // API Routes
    if (url.pathname.startsWith("/api/")) {
      return handleAPI(req, url);
    }

    // Serve static files
    return serveStatic(url.pathname);
  },

  websocket: {
    open(ws) {
      wsClients.add(ws);
      // Send current state
      ws.send(JSON.stringify({
        type: "init",
        data: {
          running: swarm !== null,
          logs: logBuffer.slice(-100),
          agents: swarm?.getAgentStatuses() || [],
        },
      }));
    },
    close(ws) {
      wsClients.delete(ws);
    },
    message(ws, message) {
      // Handle incoming WS messages if needed
    },
  },
});

console.log(`
╔══════════════════════════════════════════════╗
║          🐝 SWARM TRADER v1.0               ║
║   Agentic Memecoin Trading Swarm            ║
╠══════════════════════════════════════════════╣
║   Dashboard:  http://localhost:${PORT}           ║
║   API:        http://localhost:${PORT}/api       ║
║   WebSocket:  ws://localhost:${PORT}/ws          ║
╚══════════════════════════════════════════════╝
`);

// ============================================================
// API HANDLER
// ============================================================

async function handleAPI(req: Request, url: URL): Promise<Response> {
  const path = url.pathname.replace("/api", "");
  const method = req.method;

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  try {
    // ---- SWARM CONTROL ----
    if (path === "/start" && method === "POST") {
      const body = await req.json() as Partial<SwarmConfig>;

      const config: SwarmConfig = {
        openrouterKey: body.openrouterKey || process.env.OPENROUTER_API_KEY || "",
        model: body.model || process.env.LLM_MODEL || "deepseek/deepseek-chat",
        rpcUrl: body.rpcUrl || process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
        walletKey: body.walletKey || process.env.WALLET_PRIVATE_KEY || "",
        maxPositionSol: body.maxPositionSol ?? 0.05,
        stopLossPct: body.stopLossPct ?? 30,
        takeProfitPct: body.takeProfitPct ?? 100,
        maxConcurrentTrades: body.maxConcurrentTrades ?? 3,
        minScoreToTrade: body.minScoreToTrade ?? 80,
        scanIntervalMs: body.scanIntervalMs ?? 60000,
        slippageBps: body.slippageBps ?? 500,
      };

      if (swarm) swarm.stop();
      swarm = new Swarm(config, onSwarmLog);
      await swarm.start();

      broadcast("status", { running: true, agents: swarm.getAgentStatuses() });
      return Response.json({ ok: true, message: "Swarm started" }, { headers: cors });
    }

    if (path === "/stop" && method === "POST") {
      if (swarm) {
        swarm.stop();
        broadcast("status", { running: false });
      }
      return Response.json({ ok: true, message: "Swarm stopped" }, { headers: cors });
    }

    // ---- DATA ENDPOINTS ----
    if (path === "/status" && method === "GET") {
      return Response.json({
        running: swarm !== null,
        agents: swarm?.getAgentStatuses() || [],
      }, { headers: cors });
    }

    if (path === "/positions" && method === "GET") {
      return Response.json(swarm?.getPositions() || [], { headers: cors });
    }

    if (path === "/tokens" && method === "GET") {
      return Response.json(swarm?.getScannedTokens() || [], { headers: cors });
    }

    if (path === "/narratives" && method === "GET") {
      return Response.json(swarm?.getNarratives() || [], { headers: cors });
    }

    if (path === "/history" && method === "GET") {
      return Response.json(swarm?.getTradeHistory() || [], { headers: cors });
    }

    if (path === "/logs" && method === "GET") {
      return Response.json(logBuffer.slice(-200), { headers: cors });
    }

    if (path === "/balance" && method === "GET") {
      const bal = await swarm?.getBalance();
      return Response.json(bal || { sol: 0, address: "" }, { headers: cors });
    }

    // ---- TRADING ----
    if (path === "/buy" && method === "POST") {
      if (!swarm) return Response.json({ error: "Swarm not running" }, { status: 400, headers: cors });
      const { tokenAddress, solAmount } = await req.json();
      if (!tokenAddress || !solAmount) {
        return Response.json({ error: "tokenAddress and solAmount required" }, { status: 400, headers: cors });
      }
      const result = await swarm.manualBuy(tokenAddress, solAmount);
      broadcast("trade", result);
      return Response.json(result || { error: "Trade failed" }, { headers: cors });
    }

    if (path === "/sell" && method === "POST") {
      if (!swarm) return Response.json({ error: "Swarm not running" }, { status: 400, headers: cors });
      const { positionId } = await req.json();
      if (!positionId) {
        return Response.json({ error: "positionId required" }, { status: 400, headers: cors });
      }
      const result = await swarm.manualSell(positionId);
      broadcast("trade", result);
      return Response.json(result || { error: "Trade failed" }, { headers: cors });
    }

    if (path === "/search" && method === "GET") {
      if (!swarm) return Response.json({ error: "Swarm not running" }, { status: 400, headers: cors });
      const query = url.searchParams.get("q") || "";
      const results = await swarm.searchToken(query);
      return Response.json(results, { headers: cors });
    }

    return Response.json({ error: "Not found" }, { status: 404, headers: cors });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500, headers: cors });
  }
}

// ============================================================
// STATIC FILE SERVER
// ============================================================

function serveStatic(pathname: string): Response {
  if (pathname === "/" || pathname === "/index.html") {
    return new Response(DASHBOARD_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const filePath = `public${pathname}`;
  if (existsSync(filePath)) {
    const file = readFileSync(filePath);
    const ext = pathname.split(".").pop() || "";
    const types: Record<string, string> = {
      js: "application/javascript",
      css: "text/css",
      html: "text/html",
      json: "application/json",
      png: "image/png",
      svg: "image/svg+xml",
    };
    return new Response(file, {
      headers: { "Content-Type": types[ext] || "application/octet-stream" },
    });
  }

  // SPA fallback
  return new Response(DASHBOARD_HTML, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ============================================================
// INLINE DASHBOARD HTML (full React app via CDN)
// ============================================================

const DASHBOARD_HTML = readFileSync("./public/index.html", "utf-8");