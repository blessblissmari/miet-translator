/**
 * Markdown → Markdown translation pass.
 *
 * This is the TRANSLATE stage of the Parse → Translate → Build pipeline. It
 * takes already-structured source-language Markdown (produced by `pdfExtract`
 * for text-layer PDFs, `visionParse` for handwritten/scanned pages, or
 * `mammoth` for DOCX) and renders it in academic Russian, keeping every
 * LaTeX formula and Markdown structure verbatim.
 *
 * Critically, this prompt does NOT do any OCR — it trusts the input. That's
 * the architectural change vs. the previous one-shot prompt.
 */

import { chat } from "./openrouter";
import { normalizeMath, stripCodeFences } from "./mathNormalize";

export interface TranslateOpts {
  apiKey: string;
  model: string;
  signal?: AbortSignal;
  /** Optional hint for the prompt — currently only "academic" is used. */
  tone?: "academic";
}

const TRANSLATE_PROMPT = `You are a senior technical translator specializing in academic and engineering literature for Russian universities (МИЭТ style).

Your INPUT is Markdown already in its source language (most often English; sometimes Russian that needs only light polishing). Your OUTPUT is Markdown translated to formal academic Russian.

STRICT RULES — output:
- Output ONLY the translated Markdown. No commentary. No code fences. No "Here is the translation".
- Preserve EVERY mathematical formula verbatim. Math is inside \`$ ... $\` (inline) or \`$$ ... $$\` (display). Do NOT rewrite, simplify, or "improve" formulas. Do NOT change delimiters. Multi-line environments stay wrapped in \`$$ ... $$\`.
- Preserve Markdown structure exactly: heading levels (\`#\`, \`##\`, \`###\`), bullets (\`- \`), ordered lists (\`1. \`), tables (\`|...|\`), blockquotes.
- Preserve figure markers like \`(см. рис.)\` and any \`[нечитаемо]\` markers as-is.
- Preserve identifiers, units, code, and proper names verbatim (BJT, MOSFET, V_T, Ohm, …).
- Preserve original problem / sub-problem numbering (Question 3 → Задача 3, Part (a) → Пункт (а), …).

STRICT RULES — Russian style:
- Use formal academic Russian. Prefer established Russian technical terminology over calques:
  - transistor → транзистор; small-signal model → модель для малого сигнала
  - cut-off frequency → частота среза
  - homework → домашнее задание; assignment → задание
  - Question N → Задача N; Solution → Решение
  - Part (a) → Часть (а) / Пункт (а)
  - Show that → Покажите, что; Find → Найдите; Compute → Вычислите; Derive → Выведите
- Translate the meaning, not word-by-word. It must read as if originally written by a Russian engineering professor.
- Do NOT prepend a generic heading like \`# Документ\`. Only emit headings the source has.
`;

/**
 * Translate a chunk of Markdown into academic Russian Markdown.
 *
 * Empty / whitespace-only inputs are returned as-is.
 */
export async function translateMarkdown(
  markdown: string,
  opts: TranslateOpts,
): Promise<string> {
  if (!markdown.trim()) return markdown;

  const raw = await chat({
    apiKey: opts.apiKey,
    model: opts.model,
    temperature: 0.2,
    maxTokens: 4096,
    signal: opts.signal,
    messages: [
      { role: "system", content: TRANSLATE_PROMPT },
      { role: "user", content: markdown.slice(0, 14000) },
    ],
  });
  return normalizeMath(stripCodeFences(raw));
}
