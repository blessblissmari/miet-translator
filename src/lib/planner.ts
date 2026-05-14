import { chat, parseJsonLoose } from "./openrouter";
import { normalizeMath, stripCodeFences } from "./mathNormalize";
import { visionParsePage } from "./visionParse";
import { translateMarkdown } from "./translate";
import type { SlidePlan, DocPlan, DocBlock, ExtractedDoc } from "./types";

export interface PlannerOpts {
  apiKey: string;
  model: string;
  visionCapable: boolean;
  /**
   * When true, the user has explicitly marked the source as handwritten /
   * scanned. The pipeline will then run a vision-LLM PARSE pass on every page
   * (regardless of whether pdf.js produced a text layer), then translate the
   * extracted Markdown in a separate text-only pass. This delivers far better
   * results on handwritten lecture notes than treating the OCR + translation
   * as a single LLM call. Requires a vision-capable model.
   */
  handwritten?: boolean;
  onLog?: (msg: string) => void;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * Threshold for auto-detecting that a PDF page's text layer is too sparse to
 * trust (scan / handwriting / image-only PDF). Below this many
 * non-whitespace characters we fall back to vision OCR.
 */
const SPARSE_TEXT_THRESHOLD = 30;

const TARGET_LANG = "Russian";

const SLIDE_LAYOUTS = [
  "section-title",
  "title-text",
  "title-text-image-right",
  "title-text-image-left",
  "title-image",
] as const;

const SLIDE_PROMPT = (lang: string, validLayouts: string) => `You convert one academic English slide into a localized slide for a MIET (Russian university) template.

Target language: ${lang}.

Output ONLY valid JSON (no commentary, no markdown fences) matching:
{ "title": string, "bullets": string[], "layout": one of [${validLayouts}], "isSectionTitle": boolean }

Rules:
- Translate slide content into ${lang}. Keep math formulas, code, identifiers, proper names verbatim.
- Inside bullets, keep math in LaTeX delimiters: $...$ (inline) and $$...$$ (display).
- Pick "section-title" only for pure chapter/section heading slides.
- Pick "title-image" if the slide is dominated by a figure with little text.
- Pick "title-text-image-right" if substantial text alongside a meaningful figure.
- Otherwise "title-text".
- Bullets concise (<= 12 items, <= 220 chars each). Preserve original order.
- Title is a short ${lang} phrase, NOT a sentence.
`;

/**
 * Translate one document page using the two-stage Parse → Translate pipeline.
 *
 * Stage 1 (Parse): produce source-language Markdown for the page. If the user
 *   marked the source as handwritten, OR the embedded text layer is too sparse
 *   to trust, we run a vision-LLM parse on the rasterized page. Otherwise we
 *   reuse the pdf.js text layer directly (no LLM call).
 *
 * Stage 2 (Translate): hand the source-language Markdown to a text-only LLM
 *   call that translates it into academic Russian Markdown, keeping every
 *   LaTeX formula and Markdown structure verbatim.
 *
 * Splitting parse from translate means a single LLM never has to do both OCR
 * and fluent Russian rendering on one call — which was the main source of
 * dropped formulas and garbled diagrams in the previous one-shot prompt.
 */
async function translateDocPage(
  page: { text: string; imageDataUrl: string; index: number; images?: { dataUrl: string; y: number; w: number; h: number }[] },
  opts: PlannerOpts,
): Promise<DocBlock[]> {
  const sourceMd = await parseDocPageToMarkdown(page, opts);
  if (!sourceMd.trim()) return [];

  const translated = await translateMarkdown(sourceMd, {
    apiKey: opts.apiKey,
    model: opts.model,
    signal: opts.signal,
    tone: "academic",
  });
  return parseMarkdownToBlocks(translated);
}

/**
 * Stage 1 of the pipeline: produce source-language Markdown for one page.
 *
 * Routes between three implementations:
 * - vision parse (LLM) when handwritten=true OR the text layer is sparse,
 * - pdf.js text layer (no LLM) for printed PDFs with a usable text layer,
 * - falls back to vision parse if the text-layer path produces empty output.
 */
async function parseDocPageToMarkdown(
  page: { text: string; imageDataUrl: string; index: number },
  opts: PlannerOpts,
): Promise<string> {
  const textLen = page.text.replace(/\s+/g, "").length;
  const sparseText = textLen < SPARSE_TEXT_THRESHOLD;
  const useVisionParse = opts.handwritten === true || sparseText;

  if (useVisionParse) {
    if (!opts.visionCapable) {
      const reason = opts.handwritten ? "помечена как рукопись/скан" : "без текстового слоя";
      throw new Error(
        `Страница ${page.index + 1} ${reason}. Переключи модель на vision-капабельную (Gemma 4 26B / Gemma 3 27B / 12B) в Настройках.`
      );
    }
    opts.onLog?.(
      `Стр. ${page.index + 1}: парсинг (vision-OCR${opts.handwritten ? ", рукопись" : ""})…`
    );
    const md = await visionParsePage(page.imageDataUrl, {
      apiKey: opts.apiKey,
      model: opts.model,
      signal: opts.signal,
      pageIndex: page.index,
      hint: opts.handwritten ? "handwritten" : "scan",
    });
    opts.onLog?.(`Стр. ${page.index + 1}: перевод…`);
    return md;
  }

  opts.onLog?.(`Стр. ${page.index + 1}: перевод текстового слоя…`);
  return textLayerToMarkdown(page.text);
}

/**
 * Convert raw pdf.js text-layer output into Markdown-ish source. Heuristic
 * only — we don't reconstruct headings/lists here; the translator preserves
 * paragraph breaks and any obvious structure already present in the text.
 */
function textLayerToMarkdown(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 12000);
}

export async function planSlides(extracted: ExtractedDoc, opts: PlannerOpts): Promise<SlidePlan[]> {
  const plans: SlidePlan[] = [];
  for (let i = 0; i < extracted.pages.length; i++) {
    const page = extracted.pages[i];
    opts.onLog?.(`Перевод слайда ${i + 1}/${extracted.pages.length}…`);
    const plan = await planSlideRobust(page, opts);
    plans.push(plan);
    opts.onProgress?.(i + 1, extracted.pages.length);
  }
  return plans;
}

async function planSlideRobust(
  page: { text: string; imageDataUrl: string; index: number; images?: { dataUrl: string; y: number; w: number; h: number }[] },
  opts: PlannerOpts,
): Promise<SlidePlan> {
  // Pick the best actual figure on this slide (largest by area among extracted images).
  // Falls back to the rasterized page only if NO real figures were extracted AND the slide is image-dominated.
  const realImages = (page.images || []).filter(im => im.w * im.h > 80 * 80);
  const bestImg = realImages.length > 0
    ? realImages.slice().sort((a, b) => (b.w * b.h) - (a.w * a.h))[0].dataUrl
    : null;

  const sparseText = page.text.replace(/\s+/g, "").length < SPARSE_TEXT_THRESHOLD;
  const isHandwritten = opts.handwritten === true || sparseText;
  if (isHandwritten && !opts.visionCapable) {
    const reason = opts.handwritten ? "помечен как рукопись/скан" : "без текста";
    throw new Error(
      `Слайд ${page.index + 1} ${reason}. Переключи модель на vision-капабельную (Gemma 4 26B / Gemma 3) в Настройках.`
    );
  }
  if (isHandwritten) {
    opts.onLog?.(`Слайд ${page.index + 1}: режим vision-OCR`);
    // For handwritten slides, get a translation directly from the image.
    const out = await chat({
      apiKey: opts.apiKey,
      model: opts.model,
      temperature: 0.2,
      maxTokens: 1024,
      signal: opts.signal,
      messages: [
        { role: "system", content: `Read the attached slide image (may be handwritten or scanned), then output a short ${TARGET_LANG} title on the first line, then up to 8 bullet lines starting with "- ". Keep math in $...$ or $$...$$. Output only Markdown.` },
        { role: "user", content: [
          { type: "text", text: `Slide ${page.index + 1} — read & translate.` },
          { type: "image_url", image_url: { url: page.imageDataUrl } },
        ] },
      ],
    });
    return parseSlideFromPlain(normalizeMath(stripCodeFences(out)), bestImg);
  }

  // Primary: structured JSON
  try {
    const userContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
      { type: "text", text: `Slide raw text:\n\n${page.text.slice(0, 6000)}\n\nThis slide has ${realImages.length} embedded figure(s).` },
    ];
    if (opts.visionCapable) userContent.push({ type: "image_url", image_url: { url: page.imageDataUrl } });
    const out = await chat({
      apiKey: opts.apiKey,
      model: opts.model,
      temperature: 0.2,
      maxTokens: 1024,
      responseJson: true,
      signal: opts.signal,
      messages: [
        { role: "system", content: SLIDE_PROMPT(TARGET_LANG, SLIDE_LAYOUTS.map(l => `"${l}"`).join(", ")) },
        { role: "user", content: userContent },
      ],
    });
    const parsed = parseJsonLoose<{ title?: string; bullets?: string[]; layout?: string; isSectionTitle?: boolean }>(out);
    let layout = (parsed.layout && (SLIDE_LAYOUTS as readonly string[]).includes(parsed.layout)
      ? parsed.layout
      : "title-text") as SlidePlan["layout"];
    if (parsed.isSectionTitle) layout = "section-title";
    // Coerce layout to match what we actually have: no image → no image-layout.
    if (!bestImg && (layout === "title-text-image-right" || layout === "title-text-image-left" || layout === "title-image")) {
      layout = "title-text";
    }
    if (bestImg && layout === "title-text") {
      layout = "title-text-image-right";
    }
    return {
      title: normalizeMath((parsed.title || "").trim()),
      bullets: (parsed.bullets || []).map(b => normalizeMath(b.trim())).filter(Boolean),
      layout,
      imageDataUrl: layout === "section-title" ? undefined : (bestImg ?? undefined),
    };
  } catch (e1) {
    opts.onLog?.(`Слайд ${page.index + 1}: JSON упал, делаю plain-перевод (${(e1 as Error).message.slice(0, 80)})`);
    const plain = await chat({
      apiKey: opts.apiKey,
      model: opts.model,
      temperature: 0.2,
      maxTokens: 1024,
      signal: opts.signal,
      messages: [
        { role: "system", content: `Translate the slide content into ${TARGET_LANG}. Output a short ${TARGET_LANG} title on the first line, then up to 8 bullet lines starting with "- ". Keep math in $...$ or $$...$$. No commentary.` },
        { role: "user", content: page.text.slice(0, 6000) },
      ],
    });
    return parseSlideFromPlain(normalizeMath(stripCodeFences(plain)), bestImg);
  }
}

function parseSlideFromPlain(md: string, imageDataUrl: string | null): SlidePlan {
  const lines = md.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let title = lines.shift() || "";
  title = title.replace(/^#+\s*/, "");
  const bullets: string[] = [];
  for (const ln of lines) {
    const m = ln.match(/^[-*•]\s+(.*)$/);
    if (m) bullets.push(m[1].trim());
    else if (bullets.length === 0) {
      bullets.push(ln);
    } else {
      bullets[bullets.length - 1] += " " + ln;
    }
  }
  const layout: SlidePlan["layout"] = imageDataUrl ? "title-text-image-right" : "title-text";
  return { title, bullets: bullets.slice(0, 12), layout, imageDataUrl: imageDataUrl ?? undefined };
}

export async function planDoc(extracted: ExtractedDoc, opts: PlannerOpts): Promise<DocPlan> {
  const allBlocks: DocBlock[] = [];
  let title: string | undefined;
  const errors: string[] = [];

  for (let i = 0; i < extracted.pages.length; i++) {
    const page = extracted.pages[i];
    opts.onLog?.(`Перевод страницы ${i + 1}/${extracted.pages.length}…`);
    try {
      const blocks = await translateDocPage(page, opts);
      // Lift first h1 into title if doc has none yet
      if (!title && blocks.length > 0 && blocks[0].type === "h1") {
        const h1 = blocks.shift() as DocBlock;
        if (h1.type === "h1") title = h1.text;
      }
      if (blocks.length === 0) {
        // LLM returned empty — keep page raw text
        if (page.text.trim()) allBlocks.push({ type: "para", text: page.text.trim() });
      } else {
        allBlocks.push(...blocks);
      }
      // Append extracted images (real figures from the PDF) at the end of the page block group.
      // Skip whole-page-sized rasters: those are scans of the page, not real figures.
      const pageW = page.width || 1;
      const pageH = page.height || 1;
      const realFigs = (page.images || []).filter(im => {
        const coverage = (im.w * im.h) / (pageW * pageH);
        return coverage > 0 && coverage < 0.7;
      });
      for (let k = 0; k < realFigs.length; k++) {
        allBlocks.push({
          type: "figure",
          imageDataUrl: realFigs[k].dataUrl,
          caption: realFigs.length === 1
            ? `Рис. ${i + 1}`
            : `Рис. ${i + 1}.${k + 1}`,
        });
      }
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`Страница ${i + 1}: ${msg}`);
      opts.onLog?.(`Ошибка на странице ${i + 1}: ${msg.slice(0, 120)}`);
      // No image fallback — just put a clear marker so the user can re-run
      allBlocks.push({
        type: "para",
        text: `⚠ Страница ${i + 1}: не удалось перевести (${msg}). Исходный текст ниже.`,
      });
      if (page.text.trim()) allBlocks.push({ type: "para", text: page.text.trim() });
    }
    opts.onProgress?.(i + 1, extracted.pages.length);
  }

  if (errors.length === extracted.pages.length) {
    throw new Error(`Перевод не удался ни на одной странице: ${errors[0]}`);
  }

  return { title, blocks: allBlocks };
}

/** Convert Markdown (with $...$ / $$...$$ math) into DocBlock[]. */
export function parseMarkdownToBlocks(md: string): DocBlock[] {
  const lines = md.split(/\r?\n/);
  const blocks: DocBlock[] = [];
  let listItems: string[] = [];
  let listOrdered = false;
  let listActive = false;
  let inDisplayMath = false;
  let displayBuffer: string[] = [];
  const paraBuffer: string[] = [];

  const flushList = () => {
    if (listActive && listItems.length) blocks.push({ type: "list", ordered: listOrdered, items: listItems });
    listItems = [];
    listActive = false;
  };
  const flushPara = () => {
    const text = paraBuffer.join(" ").replace(/\s+/g, " ").trim();
    if (text) blocks.push({ type: "para", text });
    paraBuffer.length = 0;
  };
  const flushAll = () => { flushList(); flushPara(); };

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const line = raw.replace(/\s+$/, "");

    // Markdown table detection: look ahead for | header | + | --- | --- | rows
    if (!inDisplayMath && /\|/.test(line) && line.trim().startsWith("|") && line.trim().endsWith("|")) {
      const next = (lines[li + 1] || "").trim();
      if (/^\|?\s*:?-{2,}.*\|/.test(next)) {
        const rows: string[][] = [];
        const headerCells = line.split("|").slice(1, -1).map(c => c.trim());
        rows.push(headerCells);
        li += 1; // skip separator
        while (li + 1 < lines.length) {
          const nl = lines[li + 1].trim();
          if (!nl.startsWith("|") || !nl.endsWith("|")) break;
          li++;
          const cells = lines[li].split("|").slice(1, -1).map(c => c.trim());
          rows.push(cells);
        }
        flushAll();
        blocks.push({ type: "table", rows, header: true });
        continue;
      }
    }

    if (inDisplayMath) {
      const close = line.match(/^(.*)\$\$\s*$/);
      if (close) {
        if (close[1]) displayBuffer.push(close[1]);
        const latex = displayBuffer.join("\n").trim();
        if (latex) blocks.push({ type: "formula", latex, display: true });
        displayBuffer = [];
        inDisplayMath = false;
      } else {
        displayBuffer.push(line);
      }
      continue;
    }
    const trimmed = line.trim();
    // single-line $$...$$
    const oneLine = trimmed.match(/^\$\$([\s\S]+?)\$\$$/);
    if (oneLine) {
      flushAll();
      blocks.push({ type: "formula", latex: oneLine[1].trim(), display: true });
      continue;
    }
    // open display math
    if (/^\$\$/.test(trimmed)) {
      flushAll();
      inDisplayMath = true;
      const rest = trimmed.replace(/^\$\$/, "");
      if (rest) displayBuffer.push(rest);
      continue;
    }
    if (trimmed === "") { flushAll(); continue; }
    let m;
    if ((m = trimmed.match(/^#\s+(.+)/))) { flushAll(); blocks.push({ type: "h1", text: m[1].trim() }); continue; }
    if ((m = trimmed.match(/^##\s+(.+)/))) { flushAll(); blocks.push({ type: "h2", text: m[1].trim() }); continue; }
    if ((m = trimmed.match(/^###\s+(.+)/))) { flushAll(); blocks.push({ type: "h3", text: m[1].trim() }); continue; }
    if ((m = trimmed.match(/^[-*•]\s+(.+)/))) {
      flushPara();
      if (listActive && listOrdered) flushList();
      listActive = true; listOrdered = false;
      listItems.push(m[1].trim());
      continue;
    }
    if ((m = trimmed.match(/^\d+[.)]\s+(.+)/))) {
      flushPara();
      if (listActive && !listOrdered) flushList();
      listActive = true; listOrdered = true;
      listItems.push(m[1].trim());
      continue;
    }
    flushList();
    paraBuffer.push(trimmed);
  }
  flushAll();
  return blocks;
}
