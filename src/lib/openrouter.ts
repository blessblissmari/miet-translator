import type { OpenRouterModel } from "./types";

/** No API key is embedded. Users must provide their own OpenRouter key in the
 *  UI. The key is stored in localStorage of the user's browser only — never
 *  sent to the repo or to any server other than openrouter.ai. */
export const DEFAULT_API_KEY = "";

export const FREE_MODELS: OpenRouterModel[] = [
  { id: "google/gemma-3-27b-it:free",            label: "Gemma 3 27B — vision (рекомендуется для рукописи/сканов)", vision: true,  context: 131072 },
  { id: "google/gemma-3-12b-it:free",            label: "Gemma 3 12B — vision (быстрее)",                            vision: true,  context: 32768  },
  { id: "openai/gpt-oss-120b:free",              label: "GPT-OSS 120B — только текст, для печатных PDF",             vision: false, context: 131072 },
  { id: "z-ai/glm-4.5-air:free",                 label: "GLM 4.5 Air — только текст",                                 vision: false, context: 131072 },
  { id: "qwen/qwen3-next-80b-a3b-instruct:free", label: "Qwen3 Next 80B — только текст, длинный контекст",            vision: false, context: 262144 },
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

/** Error class so we can surface fatal HTTP statuses (no point retrying 401/403/400). */
export class OpenRouterError extends Error {
  status: number;
  fatal: boolean;
  bodyExcerpt: string;
  constructor(status: number, bodyExcerpt: string, fatal: boolean) {
    const friendly =
      status === 401 ? "ключ OpenRouter недействителен (401). Проверь его на https://openrouter.ai/keys" :
      status === 402 ? "у ключа OpenRouter нет квоты/баланса (402). Создай новый бесплатный ключ или пополни." :
      status === 403 ? "доступ запрещён (403). Возможно модель недоступна для этого ключа." :
      status === 404 ? "модель не найдена (404). Выбери другую в Настройках." :
      status === 400 ? `неверный запрос (400): ${bodyExcerpt}` :
      status === 429 ? `слишком много запросов (429): ${bodyExcerpt}` :
      status >= 500 ? `сервер OpenRouter (${status}): ${bodyExcerpt}` :
      `HTTP ${status}: ${bodyExcerpt}`;
    super(friendly);
    this.name = "OpenRouterError";
    this.status = status;
    this.fatal = fatal;
    this.bodyExcerpt = bodyExcerpt;
  }
}

function describeError(e: unknown): string {
  if (!e) return "неизвестная ошибка (no error object)";
  if (e instanceof Error) return e.message || e.name || String(e);
  if (typeof e === "string") return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

export async function chat(opts: ChatOptions): Promise<string> {
  if (!opts.apiKey) throw new Error("Нет ключа OpenRouter. Открой Настройки и вставь ключ с https://openrouter.ai/keys");

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 4096,
  };
  if (opts.responseJson) body.response_format = { type: "json_object" };

  let lastErr: unknown = new Error("no attempts made");
  for (let attempt = 0; attempt < 4; attempt++) {
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

      // Read body once, regardless of status, so we always have something to surface.
      const rawText = await res.text().catch(() => "");

      if (!res.ok) {
        // Fatal statuses: don't retry, surface immediately.
        const fatal = res.status === 400 || res.status === 401 || res.status === 402 ||
                      res.status === 403 || res.status === 404;
        const err = new OpenRouterError(res.status, rawText.slice(0, 400), fatal);
        if (fatal) throw err;
        // Retryable (429 / 5xx)
        lastErr = err;
        const wait = Math.min(60_000, 2000 * Math.pow(2, attempt));
        await sleep(wait);
        continue;
      }

      let data: unknown;
      try { data = JSON.parse(rawText); }
      catch { throw new Error(`OpenRouter ответил не-JSON: ${rawText.slice(0, 200)}`); }

      const d = data as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
      if (d?.error?.message) throw new Error(`OpenRouter API: ${d.error.message}`);
      const content: string | undefined = d?.choices?.[0]?.message?.content;
      if (!content) throw new Error(`Пустой ответ от модели: ${rawText.slice(0, 200)}`);
      return content;
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") throw e;
      if (e instanceof OpenRouterError && e.fatal) throw e;
      lastErr = e;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error(`OpenRouter не ответил после ретраев: ${describeError(lastErr)}`);
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
