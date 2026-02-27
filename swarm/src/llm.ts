// src/llm.ts — OpenRouter LLM Client

export interface LLMConfig {
  apiKey: string;
  model: string;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function llmChat(
  config: LLMConfig,
  messages: LLMMessage[],
  options?: { temperature?: number; maxTokens?: number; jsonMode?: boolean }
): Promise<string> {
  const body: any = {
    model: config.model,
    messages,
    max_tokens: options?.maxTokens ?? 2048,
    temperature: options?.temperature ?? 0.3,
  };

  if (options?.jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://swarm-trader.local",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

export async function llmScore(
  config: LLMConfig,
  prompt: string
): Promise<{ score: number; reasoning: string; signal: string }> {
  const messages: LLMMessage[] = [
    {
      role: "system",
      content: `You are a memecoin trading analyst. You score tokens 0-100 based on their potential.
Respond ONLY with valid JSON: {"score": number, "reasoning": "brief reason", "signal": "BUY"|"WATCH"|"SKIP"|"RISKY"}
Score guide: 90+ = strong buy setup, 75-89 = promising watch, 60-74 = neutral, <60 = skip.
Consider: narrative strength, holder distribution, liquidity depth, dev wallet %, social momentum, smart money flow.`,
    },
    { role: "user", content: prompt },
  ];

  const raw = await llmChat(config, messages, { jsonMode: true, temperature: 0.2 });

  try {
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return { score: 0, reasoning: "Failed to parse LLM response", signal: "SKIP" };
  }
}

export async function llmNarrativeAnalysis(
  config: LLMConfig,
  tokenData: string
): Promise<{ narratives: Array<{ name: string; score: number; tokens: string[]; trend: string }> }> {
  const messages: LLMMessage[] = [
    {
      role: "system",
      content: `You analyze memecoin market data to identify trending narratives.
Respond ONLY with valid JSON: {"narratives": [{"name": "narrative name", "score": 0-100, "tokens": ["$TICKER1"], "trend": "rising"|"stable"|"falling"}]}
Look for: AI agents, animal metas, DeFi narratives, cultural moments, influencer-driven pumps, Solana ecosystem plays.
Max 8 narratives, ranked by score.`,
    },
    { role: "user", content: tokenData },
  ];

  const raw = await llmChat(config, messages, { jsonMode: true, temperature: 0.3 });

  try {
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return { narratives: [] };
  }
}
