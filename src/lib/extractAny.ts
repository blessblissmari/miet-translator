import JSZip from "jszip";
import type { ExtractedDoc, ExtractedPage } from "./types";
import { extractPdf } from "./pdfExtract";

export type InputKind = "pdf" | "pptx" | "docx" | "image" | "text" | "unknown";

const PDF_EXT = /\.pdf$/i;
const PPTX_EXT = /\.pptx$/i;
const DOCX_EXT = /\.docx$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
const TEXT_EXT = /\.(txt|md|markdown|rst)$/i;

export function classifyInput(filename: string): InputKind {
  if (PDF_EXT.test(filename)) return "pdf";
  if (PPTX_EXT.test(filename)) return "pptx";
  if (DOCX_EXT.test(filename)) return "docx";
  if (IMAGE_EXT.test(filename)) return "image";
  if (TEXT_EXT.test(filename)) return "text";
  return "unknown";
}

/** Suggest auto kind based on input type. */
export async function suggestKind(filename: string, blob: Blob): Promise<"presentation" | "document"> {
  const k = classifyInput(filename);
  if (k === "pptx") return "presentation";
  if (k === "docx") return "document";
  if (k === "text") return "document";
  if (k === "image") return "document";
  if (k === "pdf") {
    // landscape → presentation
    try {
      const pdfjsLib = await import("pdfjs-dist");
      const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
      const buf = await blob.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data: buf }).promise;
      const page = await doc.getPage(1);
      const vp = page.getViewport({ scale: 1 });
      return vp.width / vp.height > 1.2 ? "presentation" : "document";
    } catch {
      return "document";
    }
  }
  return "document";
}

export async function extractAny(
  blob: Blob,
  filename: string,
  onProgress?: (page: number, total: number) => void,
): Promise<ExtractedDoc> {
  const k = classifyInput(filename);
  switch (k) {
    case "pdf": {
      const file = new File([blob], filename, { type: "application/pdf" });
      return extractPdf(file, onProgress);
    }
    case "pptx": return extractPptx(blob);
    case "docx": return extractDocx(blob);
    case "image": return extractImage(blob, filename);
    case "text":  return extractText(blob, filename);
    default:
      // try PDF parse as a last resort
      try {
        const file = new File([blob], filename, { type: "application/pdf" });
        return await extractPdf(file, onProgress);
      } catch {
        throw new Error(`Не понимаю формат файла: ${filename}`);
      }
  }
}

/* ─── PPTX ─────────────────────────────────────── */
async function extractPptx(blob: Blob): Promise<ExtractedDoc> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const slideFiles = Object.keys(zip.files)
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNum(a) - slideNum(b));

  // Map slide → list of media via rels
  const pages: ExtractedPage[] = [];
  for (let i = 0; i < slideFiles.length; i++) {
    const slidePath = slideFiles[i];
    const xml = await zip.files[slidePath].async("string");
    const text = collectText(xml);

    // Find first image in this slide via _rels
    const relsPath = slidePath.replace(/slide(\d+)\.xml$/, "_rels/slide$1.xml.rels");
    let imageDataUrl = "";
    let width = 1280, height = 720;
    if (zip.files[relsPath]) {
      const relsXml = await zip.files[relsPath].async("string");
      const m = relsXml.match(/Target="(\.\.\/media\/[^"]+)"/i);
      if (m) {
        const mediaPath = `ppt/media/${m[1].split("/").pop()}`;
        const f = zip.files[mediaPath];
        if (f) {
          const data = await f.async("base64");
          const ext = mediaPath.split(".").pop()?.toLowerCase() ?? "png";
          imageDataUrl = `data:image/${ext === "jpg" ? "jpeg" : ext};base64,${data}`;
        }
      }
    }
    if (!imageDataUrl) {
      // Render text-only slide preview to a canvas as fallback "graphic"
      imageDataUrl = await renderTextToImage(text || `Slide ${i + 1}`, 1280, 720);
    }
    pages.push({ index: i, text, imageDataUrl, width, height });
  }
  return { pages, meta: {} };
}
function slideNum(p: string): number {
  const m = p.match(/slide(\d+)\.xml$/); return m ? parseInt(m[1], 10) : 0;
}
function collectText(xml: string): string {
  const out: string[] = [];
  // <a:t>…</a:t>
  const re = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(decodeXmlEntities(m[1]));
  return out.join("\n").trim();
}
function decodeXmlEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

/* ─── DOCX ─────────────────────────────────────── */
async function extractDocx(blob: Blob): Promise<ExtractedDoc> {
  const mammoth = await import("mammoth/mammoth.browser.js");
  const result = await (mammoth as unknown as { extractRawText: (o: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }> })
    .extractRawText({ arrayBuffer: await blob.arrayBuffer() });
  const text = (result.value || "").trim();

  // Split into pseudo-pages by ~3000-char chunks at paragraph breaks for batched processing
  const pages: ExtractedPage[] = [];
  const CHUNK = 3000;
  const paragraphs = text.split(/\n\s*\n/);
  let buf = "";
  let idx = 0;
  for (const p of paragraphs) {
    if (buf.length + p.length + 2 > CHUNK && buf) {
      pages.push({
        index: idx++, text: buf,
        imageDataUrl: await renderTextToImage(buf, 1024, 1400),
        width: 1024, height: 1400,
      });
      buf = "";
    }
    buf += (buf ? "\n\n" : "") + p;
  }
  if (buf) {
    pages.push({
      index: idx, text: buf,
      imageDataUrl: await renderTextToImage(buf, 1024, 1400),
      width: 1024, height: 1400,
    });
  }
  if (pages.length === 0) {
    pages.push({ index: 0, text: text || "(пусто)", imageDataUrl: await renderTextToImage(text, 1024, 1400), width: 1024, height: 1400 });
  }
  return { pages, meta: {} };
}

/* ─── Image ────────────────────────────────────── */
async function extractImage(blob: Blob, filename: string): Promise<ExtractedDoc> {
  const dataUrl = await blobToDataUrl(blob);
  const dims = await imageDims(dataUrl);
  // text = "" so that the planner triggers its vision-OCR / handwriting path.
  return {
    pages: [{ index: 0, text: "", imageDataUrl: dataUrl, width: dims.w, height: dims.h }],
    meta: { title: filename.replace(/\.[^.]+$/, "") },
  };
}

/* ─── Plain text ───────────────────────────────── */
async function extractText(blob: Blob, _filename: string): Promise<ExtractedDoc> {
  const text = await blob.text();
  return {
    pages: [{ index: 0, text, imageDataUrl: await renderTextToImage(text, 1024, 1400), width: 1024, height: 1400 }],
    meta: {},
  };
}

/* ─── helpers ──────────────────────────────────── */
async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}
async function imageDims(dataUrl: string): Promise<{ w: number; h: number }> {
  return new Promise<{ w: number; h: number }>((res) => {
    const img = new Image();
    img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => res({ w: 1024, h: 1024 });
    img.src = dataUrl;
  });
}
async function renderTextToImage(text: string, w: number, h: number): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#111"; ctx.font = "20px sans-serif";
  const lines = wrapText(ctx, text, w - 80);
  let y = 60;
  for (const line of lines) {
    if (y > h - 30) break;
    ctx.fillText(line, 40, y); y += 28;
  }
  return canvas.toDataURL("image/png");
}
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n/)) {
    const words = para.split(/\s+/);
    let line = "";
    for (const w of words) {
      const t = line ? line + " " + w : w;
      if (ctx.measureText(t).width > maxWidth && line) {
        out.push(line); line = w;
      } else line = t;
    }
    if (line) out.push(line);
    out.push("");
  }
  return out;
}
