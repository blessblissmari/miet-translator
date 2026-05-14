/**
 * Vision-LLM-based page parser.
 *
 * This is the PARSE stage of the Parse → Translate → Build pipeline. It runs
 * a vision-capable LLM against a rasterized page (handwritten notes, scans,
 * photos of notebooks, or printed PDFs where pdf.js failed to extract a
 * clean text layer) and produces a **source-language** Markdown representation
 * of the page — with math kept verbatim in LaTeX delimiters and figures
 * referenced by short markers. Translation is a separate step (`translate.ts`).
 *
 * Keeping parse and translate as two distinct LLM calls is the whole point of
 * the rewrite: one model focused on OCR/structure won't confuse itself by
 * also having to render fluent Russian on the same call.
 */

import { chat } from "./openrouter";
import { normalizeMath, stripCodeFences } from "./mathNormalize";

export interface VisionParseOpts {
  apiKey: string;
  model: string;
  signal?: AbortSignal;
  /** Where this page came from, used only for prompting (Page N). */
  pageIndex: number;
  /** Optional hint for the model about how the source likely looks. */
  hint?: "handwritten" | "scan" | "printed" | "mixed";
}

const PARSE_PROMPT = (hint: VisionParseOpts["hint"]) => `You are a meticulous OCR + structural parser for academic pages. You will be shown ONE image of a page. The page MAY be:
- a photo or scan of handwritten lecture notes,
- a scan of a printed page where the embedded text layer is unreliable,
- a clean printed page,
- a mix of handwriting and printed text.

${
  hint === "handwritten"
    ? "Hint: the user marked this source as handwritten — read carefully, do not give up on smudged characters."
    : hint === "scan"
    ? "Hint: the user marked this source as a scan — there may be skew, noise, or watermark artifacts."
    : ""
}

Your task: produce a faithful Markdown transcription of the page **in its original language**. DO NOT translate. The translation step is downstream.

OUTPUT RULES — strict:
- Output ONLY Markdown. No commentary, no code fences, no "Here is the transcription".
- Preserve the ORIGINAL language of the page (Russian stays Russian, English stays English).
- Use Markdown structure: \`#\` for the page top heading (only if the page has one), \`##\` / \`###\` for section/subsection headings, \`- item\` for bullets, \`1. item\` for ordered lists.
- For tables: use Markdown pipe tables (\`| col | col |\`).
- For ALL mathematics, use LaTeX delimiters: \`$ ... $\` for inline math, \`$$ ... $$\` on its own line for displayed equations. Multi-line environments (\`cases\`, \`align\`, \`matrix\`, …) MUST be wrapped in \`$$ ... $$\`. NEVER use \`\\(\\)\` / \`\\[\\]\`.
- Reproduce subscripts/superscripts/fractions/integrals/sums faithfully. \`I_C\` → \`$I_C$\`, \`\\frac{a}{b}\` stays, etc.
- For diagrams or sketches you cannot encode in text, leave EXACTLY ONE short marker \`(см. рис.)\` per figure where it appears in the reading order. Do NOT repeat the marker.
- For any region you genuinely cannot read (cut off, smudged), write \`[нечитаемо]\` inline. Do NOT invent text.
- Preserve identifiers, units, code, and proper names verbatim (BJT, MOSFET, V_T, Ohm, …).
- Preserve the original numbering of problems and sub-questions exactly (Question 3, Part (a), …).`;

/**
 * Parse one page image into source-language Markdown using a vision LLM.
 *
 * @returns Markdown string in the source language with LaTeX math and figure markers.
 */
export async function visionParsePage(
  imageDataUrl: string,
  opts: VisionParseOpts,
): Promise<string> {
  const raw = await chat({
    apiKey: opts.apiKey,
    model: opts.model,
    temperature: 0.1,
    maxTokens: 4096,
    signal: opts.signal,
    messages: [
      { role: "system", content: PARSE_PROMPT(opts.hint) },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Page ${opts.pageIndex + 1}. Transcribe everything you see into Markdown, preserving the original language. Output ONLY the Markdown.`,
          },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
  });
  return normalizeMath(stripCodeFences(raw));
}
