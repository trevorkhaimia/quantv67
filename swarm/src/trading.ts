// src/trading.ts — DexScreener + Jupiter + Solana execution

import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";

// ============================================================
// TYPES
// ============================================================

export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  mcap: number;
  price: number;
  priceChange24h: number;
  priceChange1h: number;
  priceChange5m: number;
  volume24h: number;
  liquidity: number;
  pairAddress: string;
  dexId: string;
  createdAt: number;
  txns24h: { buys: number; sells: number };
  holders?: number;
  fdv: number;
  url: string;
}

export interface TradeResult {
  success: boolean;
  txHash?: string;
  error?: string;
  inputAmount: number;
  outputAmount?: number;
  price?: number;
  timestamp: number;
}

export interface WalletBalance {
  sol: number;
  tokens: Array<{ mint: string; amount: number; decimals: number; symbol?: string }>;
}

// ============================================================
// DEXSCREENER API
// ============================================================

const DEX_BASE = "https://api.dexscreener.com";

export async function searchTokens(query: string): Promise<TokenInfo[]> {
  try {
    const res = await fetch(`${DEX_BASE}/latest/dex/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.pairs || [])
      .filter((p: any) => p.chainId === "solana")
      .map(mapDexPair);
  } catch (e) {
    console.error("DexScreener search error:", e);
    return [];
  }
}

export async function getTrendingTokens(): Promise<TokenInfo[]> {
  try {
    const res = await fetch(`${DEX_BASE}/token-boosts/top/v1`);
    if (!res.ok) return [];
    const data = await res.json();
    const solTokens = (data || []).filter((t: any) => t.chainId === "solana");
    
    // Fetch pair data for each
    const results: TokenInfo[] = [];
    for (const t of solTokens.slice(0, 20)) {
      try {
        const pairRes = await fetch(`${DEX_BASE}/tokens/v1/solana/${t.tokenAddress}`);
        if (pairRes.ok) {
          const pairs = await pairRes.json();
          if (pairs?.[0]) results.push(mapDexPair(pairs[0]));
        }
      } catch { /* skip */ }
    }
    return results;
  } catch (e) {
    console.error("DexScreener trending error:", e);
    return [];
  }
}

export async function getNewPairs(minLiquidity = 5000): Promise<TokenInfo[]> {
  try {
    const res = await fetch(`${DEX_BASE}/token-profiles/latest/v1`);
    if (!res.ok) return [];
    const data = await res.json();
    const solTokens = (data || []).filter((t: any) => t.chainId === "solana").slice(0, 30);

    const results: TokenInfo[] = [];
    for (const t of solTokens) {
      try {
        const pairRes = await fetch(`${DEX_BASE}/tokens/v1/solana/${t.tokenAddress}`);
        if (pairRes.ok) {
          const pairs = await pairRes.json();
          if (pairs?.[0]) {
            const token = mapDexPair(pairs[0]);
            if (token.liquidity >= minLiquidity) results.push(token);
          }
        }
      } catch { /* skip */ }
      // Rate limit courtesy
      await new Promise(r => setTimeout(r, 200));
    }
    return results;
  } catch (e) {
    console.error("DexScreener new pairs error:", e);
    return [];
  }
}

export async function getTokenByAddress(address: string): Promise<TokenInfo | null> {
  try {
    const res = await fetch(`${DEX_BASE}/tokens/v1/solana/${address}`);
    if (!res.ok) return null;
    const pairs = await res.json();
    if (!pairs?.[0]) return null;
    return mapDexPair(pairs[0]);
  } catch {
    return null;
  }
}

function mapDexPair(p: any): TokenInfo {
  return {
    address: p.baseToken?.address || "",
    symbol: p.baseToken?.symbol || "???",
    name: p.baseToken?.name || "Unknown",
    mcap: p.marketCap || p.mcap || 0,
    price: parseFloat(p.priceUsd || "0"),
    priceChange24h: p.priceChange?.h24 || 0,
    priceChange1h: p.priceChange?.h1 || 0,
    priceChange5m: p.priceChange?.m5 || 0,
    volume24h: p.volume?.h24 || 0,
    liquidity: p.liquidity?.usd || 0,
    pairAddress: p.pairAddress || "",
    dexId: p.dexId || "",
    createdAt: p.pairCreatedAt || 0,
    txns24h: {
      buys: p.txns?.h24?.buys || 0,
      sells: p.txns?.h24?.sells || 0,
    },
    fdv: p.fdv || 0,
    url: p.url || `https://dexscreener.com/solana/${p.baseToken?.address}`,
  };
}

// ============================================================
// JUPITER SWAP API
// ============================================================

const JUP_BASE = "https://quote-api.jup.ag/v6";
const SOL_MINT = "So11111111111111111111111111111111111111112";

export async function getQuote(
  inputMint: string,
  outputMint: string,
  amountLamports: number,
  slippageBps = 500 // 5% default slippage for memecoins
): Promise<any> {
  const url = `${JUP_BASE}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}&onlyDirectRoutes=false`;
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Jupiter quote error: ${err}`);
  }
  return res.json();
}

export async function getSwapTransaction(
  quoteResponse: any,
  userPublicKey: string
): Promise<string> {
  const res = await fetch(`${JUP_BASE}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Jupiter swap error: ${err}`);
  }

  const data = await res.json();
  return data.swapTransaction;
}

// ============================================================
// SOLANA EXECUTION
// ============================================================

export function createWallet(privateKeyBase58: string): Keypair {
  const secretKey = bs58.decode(privateKeyBase58);
  return Keypair.fromSecretKey(secretKey);
}

export function getConnection(rpcUrl: string): Connection {
  return new Connection(rpcUrl, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60000,
  });
}

export async function getWalletBalance(
  connection: Connection,
  publicKey: PublicKey
): Promise<WalletBalance> {
  const solBalance = await connection.getBalance(publicKey);

  // Get token accounts
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(publicKey, {
    programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  });

  const tokens = tokenAccounts.value
    .map((ta) => {
      const info = ta.account.data.parsed.info;
      return {
        mint: info.mint,
        amount: parseFloat(info.tokenAmount.uiAmountString || "0"),
        decimals: info.tokenAmount.decimals,
      };
    })
    .filter((t) => t.amount > 0);

  return { sol: solBalance / LAMPORTS_PER_SOL, tokens };
}

export async function executeBuy(
  connection: Connection,
  wallet: Keypair,
  tokenAddress: string,
  solAmount: number,
  slippageBps = 500
): Promise<TradeResult> {
  const timestamp = Date.now();
  try {
    const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);

    // Get quote: SOL -> Token
    const quote = await getQuote(SOL_MINT, tokenAddress, lamports, slippageBps);

    // Get swap transaction
    const swapTxBase64 = await getSwapTransaction(quote, wallet.publicKey.toBase58());

    // Deserialize and sign
    const txBuf = Buffer.from(swapTxBase64, "base64");
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([wallet]);

    // Send
    const txHash = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });

    // Confirm
    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction(
      { signature: txHash, ...latestBlockhash },
      "confirmed"
    );

    const outAmount = parseFloat(quote.outAmount) / Math.pow(10, quote.outputDecimals || 6);

    return {
      success: true,
      txHash,
      inputAmount: solAmount,
      outputAmount: outAmount,
      price: solAmount / outAmount,
      timestamp,
    };
  } catch (e: any) {
    return {
      success: false,
      error: e.message || String(e),
      inputAmount: solAmount,
      timestamp,
    };
  }
}

export async function executeSell(
  connection: Connection,
  wallet: Keypair,
  tokenAddress: string,
  tokenAmount: number,
  tokenDecimals = 6,
  slippageBps = 500
): Promise<TradeResult> {
  const timestamp = Date.now();
  try {
    const rawAmount = Math.floor(tokenAmount * Math.pow(10, tokenDecimals));

    // Get quote: Token -> SOL
    const quote = await getQuote(tokenAddress, SOL_MINT, rawAmount, slippageBps);

    // Get swap transaction
    const swapTxBase64 = await getSwapTransaction(quote, wallet.publicKey.toBase58());

    // Deserialize and sign
    const txBuf = Buffer.from(swapTxBase64, "base64");
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([wallet]);

    // Send
    const txHash = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });

    // Confirm
    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction(
      { signature: txHash, ...latestBlockhash },
      "confirmed"
    );

    const outLamports = parseFloat(quote.outAmount);
    const outSol = outLamports / LAMPORTS_PER_SOL;

    return {
      success: true,
      txHash,
      inputAmount: tokenAmount,
      outputAmount: outSol,
      price: outSol / tokenAmount,
      timestamp,
    };
  } catch (e: any) {
    return {
      success: false,
      error: e.message || String(e),
      inputAmount: tokenAmount,
      timestamp,
    };
  }
}

// ============================================================
// HELPER: Format market cap
// ============================================================

export function formatMcap(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

export function formatAge(createdAt: number): string {
  const diff = Date.now() - createdAt;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
