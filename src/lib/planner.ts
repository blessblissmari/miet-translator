import { chat, parseJsonLoose } from "./openrouter";
import { normalizeMath } from "./mathNormalize";
import type { SlidePlan, DocPlan, DocBlock, ExtractedDoc } from "./types";

export interface PlannerOpts {
  apiKey: string;
  model: string;
  visionCapable: boolean;
  onLog?: (msg: string) => void;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

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

const DOC_TRANSLATE_PROMPT = (lang: string) => `You are a senior technical translator specializing in academic and engineering literature for Russian universities.

Task: translate the academic page below into ${lang} ("русский"), with the tone and terminology used in formal Russian university coursework (МИЭТ-style).

STYLE rules:
- Use formal, academic ${lang}. Prefer established Russian technical terminology over literal/calque translations. Examples:
  - "transistor" → «транзистор»
  - "small-signal model" → «модель для малого сигнала»
  - "cut-off frequency" → «частота среза»
  - "homework" → «домашнее задание»
  - "Question N" → «Задача N»
  - "Solution" → «Решение»
  - "Part (a)" → «Часть (а)» or «Пункт (а)»
  - "Show that" → «Покажите, что»
  - "Find" → «Найдите»
- Do NOT translate code, identifiers, variable names, units, or proper names (Ohm, Faraday, MOSFET, etc.).
- Preserve abbreviations: BJT, MOSFET, DC, AC, SI, etc.
- Translate the meaning, not word-by-word. Output must read as if originally written by a Russian engineering professor.

STRUCTURE rules:
- Output ONLY the translated Markdown. No commentary. No code fences. No "Here is the translation".
- Preserve EVERY mathematical formula. Use LaTeX inside $...$ for inline math and $$...$$ on its own line for displayed equations. NEVER omit a formula. If the page is heavy with formulas, EVERY formula must appear in the output.
- Use Markdown structure:
  - "# Title" for top-level title (only if the page is a cover/title page).
  - "## Heading" / "### Subheading" for section/sub-section headings.
  - "- item" for unordered lists, "1. item" for ordered lists.
  - Plain paragraphs for prose.
- Preserve numbering of problems and sub-questions exactly.
- If the page mentions a figure that you cannot reproduce in text, mention it AT MOST ONCE with a short marker "(см. рис.)". Do NOT repeat the same marker multiple times in a row.
- For tables: render as Markdown tables with | separators. The downstream pipeline will rebuild them as native DOCX tables.
- Use ONLY the dollar-sign math delimiters: $...$ for inline and $$...$$ for display equations. Do NOT use \\( \\) or \\[ \\]. Multi-line environments like \\begin{cases} ... \\end{cases} MUST be wrapped in $$ ... $$.
- Do NOT prepend the document with a generic heading like "# Документ" or "# Domácí úkol". Only emit a heading if the page itself shows one.
`;

async function translateDocPage(
  page: { text: string; imageDataUrl: string; index: number; images?: { dataUrl: string; y: number; w: number; h: number }[] },
  opts: PlannerOpts,
): Promise<DocBlock[]> {
  const isHandwritten = page.text.replace(/\s+/g, "").length < 30;

  if (isHandwritten && !opts.visionCapable) {
    throw new Error(
      `Страница ${page.index + 1} без текстового слоя (рукопись/скан). Переключи модель на vision-капабельную (Gemma 3 27B / 12B) в Настройках.`
    );
  }

  const sysPrompt = isHandwritten
    ? VISION_OCR_PROMPT(TARGET_LANG)
    : DOC_TRANSLATE_PROMPT(TARGET_LANG);

  const userContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = isHandwritten
    ? [
        { type: "text", text: `Page ${page.index + 1}. The page may contain handwriting, sketches, or scanned printed text. Carefully transcribe everything you can see, then translate to ${TARGET_LANG} as Markdown per the rules.` },
        { type: "image_url", image_url: { url: page.imageDataUrl } },
      ]
    : [
        { type: "text", text: `Translate the following page (page ${page.index + 1}) into ${TARGET_LANG}. Use Markdown as instructed.\n\n${page.text.slice(0, 12000)}` },
        ...(opts.visionCapable && page.imageDataUrl ? [{ type: "image_url" as const, image_url: { url: page.imageDataUrl } }] : []),
      ];

  if (isHandwritten) opts.onLog?.(`Стр. ${page.index + 1}: режим vision-OCR (рукопись/скан)`);

  const out = await chat({
    apiKey: opts.apiKey,
    model: opts.model,
    temperature: 0.2,
    maxTokens: 4096,
    signal: opts.signal,
    messages: [
      { role: "system", content: sysPrompt },
      { role: "user", content: userContent },
    ],
  });
  return parseMarkdownToBlocks(normalizeMath(stripCodeFences(out)));
}

const VISION_OCR_PROMPT = (lang: string) => `You are a senior technical translator and OCR expert for academic notes, including HANDWRITTEN material.

Task: look at the attached image of a page (it may be handwritten lecture notes, a scanned printed page, or a photo of someone's notebook). Carefully read the contents — including handwriting, formulas, sketches, and any printed text. Then translate everything into ${lang} ("русский") in academic МИЭТ-style.

CRITICAL rules:
- Output ONLY translated Markdown. No commentary. No code fences.
- Read the page exhaustively. Do NOT skip handwritten margin notes, sub-questions, or formulas.
- For mathematical content, use LaTeX in $...$ (inline) and $$...$$ (display). Reproduce subscripts, superscripts, fractions, integrals, sums faithfully. Multi-line environments (cases, align, matrix) MUST be wrapped in $$ ... $$. Never use \\( \\) or \\[ \\].
- Use Markdown structure: # for top heading, ##/### for sections, "- item" for bullets, "1." for ordered lists.
- For diagrams/sketches you cannot transcribe, leave AT MOST ONE short marker "(см. рис.)" — never repeat it.
- If you cannot read part of the page (smudged, cut off), write "[нечитаемо]" inline — do NOT invent content.
- Use formal Russian academic terminology (Задача, Решение, Часть, Найдите, Покажите, что …).
- Do NOT translate identifiers, units, code, or proper names (BJT, MOSFET, V_T, …).
`;

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

  const isHandwritten = page.text.replace(/\s+/g, "").length < 30;
  if (isHandwritten && !opts.visionCapable) {
    throw new Error(
      `Слайд ${page.index + 1} без текста (скан/рукопись). Переключи модель на vision (Gemma 3 27B/12B).`
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

/** Strip ```...``` fences if a model returns them despite instructions. */
export function stripCodeFences(s: string): string {
  const t = s.trim();
  const m = t.match(/^```(?:\w+)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : t;
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
