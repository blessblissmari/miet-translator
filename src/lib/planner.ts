import { chat, parseJsonLoose } from "./openrouter";
import type { SlidePlan, DocPlan, ExtractedDoc, TargetLang } from "./types";

const LANG_NAME: Record<TargetLang, string> = { ru: "Russian", en: "English" };

export interface PlannerOpts {
  apiKey: string;
  model: string;
  visionCapable: boolean;
  targetLang: TargetLang;
  onLog?: (msg: string) => void;
  onProgress?: (done: number, total: number) => void;
}

const SLIDE_LAYOUTS = [
  "section-title",
  "title-text",
  "title-text-image-right",
  "title-text-image-left",
  "title-image",
] as const;

const SLIDE_PROMPT = (lang: string, validLayouts: string) => `You are converting a single slide of an English academic presentation into a localized slide for a MIET (Russian university) template.

Target language: ${lang}.

Rules:
- Translate the slide's content into ${lang}. Keep mathematical formulas, code, and proper names as-is.
- Output ONLY valid JSON (no commentary, no markdown), matching this schema:
  { "title": string, "bullets": string[], "layout": one of [${validLayouts}], "isSectionTitle": boolean }
- Pick "section-title" only if the slide is purely a chapter/section heading.
- Pick "title-image" if the slide is dominated by a figure/diagram with little text.
- Pick "title-text-image-right" if the slide has substantial text alongside a meaningful figure.
- Otherwise use "title-text".
- Keep bullets concise (<= 12 bullets, <= 220 chars each). Preserve the ORDER of the original points.
- Title must be a short ${lang} phrase, NOT a sentence.
`;

const DOC_PROMPT = (lang: string) => `You are reformatting an English academic document (homework / lecture / problem set) into a structured JSON document, translated to ${lang}.

Rules:
- Translate prose into ${lang}. Keep math, code, identifiers, and proper names as-is.
- Output ONLY valid JSON, matching this schema:
  { "title": string, "blocks": Block[] }
  where Block is one of:
    { "type": "h1" | "h2" | "h3" | "para", "text": string }
    { "type": "list", "ordered": boolean, "items": string[] }
    { "type": "formula", "latex": string, "display": boolean }
- Use display formulas (display=true) for centered standalone equations; inline (display=false) for short formulas inside a sentence — but inline formulas must still be a separate "formula" block (the docx builder will inline-render them). For text containing inline math, split into: para text up to the formula → formula → para text after.
- Use "list" for enumerated/bulleted item lists.
- Preserve the original structure (problems, sub-questions). Use h2/h3 for section headers like "Question #1", "Part (a)", etc.
- Convert any LaTeX-able math (subscripts, fractions, sums, integrals) to LaTeX in "latex".
- Do NOT include figures here; they will be added separately. If the original mentions a figure, leave a short note like "(см. рис. ниже)" in the prose.
`;

async function planSlide(
  pageText: string,
  pageImage: string,
  lang: string,
  opts: PlannerOpts,
): Promise<SlidePlan> {
  const userContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
    { type: "text", text: `Slide raw text:\n\n${pageText.slice(0, 6000)}\n\n${opts.visionCapable ? "Slide image is also attached." : ""}` },
  ];
  if (opts.visionCapable) userContent.push({ type: "image_url", image_url: { url: pageImage } });

  const out = await chat({
    apiKey: opts.apiKey,
    model: opts.model,
    temperature: 0.2,
    maxTokens: 2048,
    responseJson: true,
    messages: [
      { role: "system", content: SLIDE_PROMPT(lang, SLIDE_LAYOUTS.map(l => `"${l}"`).join(", ")) },
      { role: "user", content: userContent },
    ],
  });
  const parsed = parseJsonLoose<{ title?: string; bullets?: string[]; layout?: string; isSectionTitle?: boolean }>(out);
  let layout = (parsed.layout && (SLIDE_LAYOUTS as readonly string[]).includes(parsed.layout)
    ? parsed.layout
    : "title-text") as SlidePlan["layout"];
  if (parsed.isSectionTitle) layout = "section-title";
  return {
    title: (parsed.title || "").trim(),
    bullets: (parsed.bullets || []).map(b => b.trim()).filter(Boolean),
    layout,
    imageDataUrl: layout === "section-title" ? undefined : pageImage,
  };
}

export async function planSlides(extracted: ExtractedDoc, opts: PlannerOpts): Promise<SlidePlan[]> {
  const lang = LANG_NAME[opts.targetLang];
  const plans: SlidePlan[] = [];
  for (let i = 0; i < extracted.pages.length; i++) {
    const page = extracted.pages[i];
    opts.onLog?.(`Перевод слайда ${i + 1}/${extracted.pages.length}…`);
    try {
      const plan = await planSlide(page.text, page.imageDataUrl, lang, opts);
      plans.push(plan);
    } catch (e) {
      opts.onLog?.(`Слайд ${i + 1}: ошибка LLM — оставляю исходник как картинку. (${(e as Error).message})`);
      plans.push({ title: "", bullets: [], layout: "title-image", imageDataUrl: page.imageDataUrl });
    }
    opts.onProgress?.(i + 1, extracted.pages.length);
  }
  return plans;
}

export async function planDoc(extracted: ExtractedDoc, opts: PlannerOpts): Promise<DocPlan> {
  const lang = LANG_NAME[opts.targetLang];
  // Process pages in batches to fit within free-tier rate limits.
  const BATCH = 4;
  const allBlocks: DocPlan["blocks"] = [];
  let title = extracted.meta.title || "";

  for (let i = 0; i < extracted.pages.length; i += BATCH) {
    const slice = extracted.pages.slice(i, i + BATCH);
    opts.onLog?.(`Перевод страниц ${i + 1}–${i + slice.length}/${extracted.pages.length}…`);
    const combinedText = slice.map((p, k) => `--- Page ${i + k + 1} ---\n${p.text}`).join("\n\n");

    const userContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
      { type: "text", text: `Document text (multi-page):\n\n${combinedText.slice(0, 12000)}` },
    ];
    if (opts.visionCapable) {
      // Attach first page image of the batch as visual context
      userContent.push({ type: "image_url", image_url: { url: slice[0].imageDataUrl } });
    }

    let parsed: { title?: string; blocks?: DocPlan["blocks"] };
    try {
      const out = await chat({
        apiKey: opts.apiKey,
        model: opts.model,
        temperature: 0.2,
        maxTokens: 4096,
        responseJson: true,
        messages: [
          { role: "system", content: DOC_PROMPT(lang) },
          { role: "user", content: userContent },
        ],
      });
      parsed = parseJsonLoose(out);
    } catch (e) {
      opts.onLog?.(`Батч ошибся, вставляю страницы как рисунки. (${(e as Error).message})`);
      parsed = {
        blocks: slice.map(p => ({ type: "figure" as const, imageDataUrl: p.imageDataUrl, caption: `Страница ${p.index + 1}` })),
      };
    }
    if (!title && parsed.title) title = parsed.title;
    if (parsed.blocks) allBlocks.push(...parsed.blocks);
    opts.onProgress?.(Math.min(i + BATCH, extracted.pages.length), extracted.pages.length);
  }

  return { title: title || (opts.targetLang === "ru" ? "Документ" : "Document"), blocks: allBlocks };
}
