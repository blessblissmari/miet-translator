import type { OpenRouterModel } from "./types";

export const FREE_MODELS: OpenRouterModel[] = [
  { id: "openai/gpt-oss-120b:free",              label: "GPT-OSS 120B — рекомендуется",     vision: false, context: 131072 },
  { id: "z-ai/glm-4.5-air:free",                 label: "GLM 4.5 Air",                      vision: false, context: 131072 },
  { id: "qwen/qwen3-next-80b-a3b-instruct:free", label: "Qwen3 Next 80B",                   vision: false, context: 262144 },
  { id: "google/gemma-3-27b-it:free",            label: "Gemma 3 27B (с распознаванием изображений)", vision: true, context: 131072 },
  { id: "google/gemma-3-12b-it:free",            label: "Gemma 3 12B (с распознаванием изображений)", vision: true, context: 32768 },
];

export const DEFAULT_MODEL = FREE_MODELS[0].id;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
}

export interface ChatOptions {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  responseJson?: boolean;
  signal?: AbortSignal;
}

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function chat(opts: ChatOptions): Promise<string> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 4096,
  };
  if (opts.responseJson) body.response_format = { type: "json_object" };

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
          "HTTP-Referer": typeof window !== "undefined" ? window.location.origin : "",
          "X-Title": "MIET Translator",
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });

      if (res.status === 429 || res.status === 503) {
        const wait = Math.min(60_000, 2000 * Math.pow(2, attempt));
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 500)}`);
      }
      const data = await res.json();
      const content: string | undefined = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error(`Empty completion: ${JSON.stringify(data).slice(0, 500)}`);
      return content;
    } catch (e) {
      lastErr = e;
      if ((e as { name?: string })?.name === "AbortError") throw e;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error(`OpenRouter request failed after retries: ${(lastErr as Error)?.message ?? lastErr}`);
}

/** Extract a JSON object from a possibly-fenced LLM response. */
export function parseJsonLoose<T>(raw: string): T {
  let s = raw.trim();
  // Strip ``` fences
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // Find first { ... last }
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  return JSON.parse(s) as T;
}
