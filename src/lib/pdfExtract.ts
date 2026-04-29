import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { ExtractedDoc, ExtractedPage, ExtractedImage } from "./types";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

interface TextItem { str: string; transform: number[]; height: number; width: number; }

/** Extract a PDF's pages with text + bounding boxes + embedded raster images. */
export async function extractPdf(
  file: File,
  onProgress?: (page: number, total: number) => void,
  renderScale = 1.5,
): Promise<ExtractedDoc> {
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages: ExtractedPage[] = [];
  const meta = await doc.getMetadata().catch(() => null);
  const info = (meta?.info ?? {}) as { Title?: string; Author?: string };

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: renderScale });
    const baseViewport = page.getViewport({ scale: 1 });
    const pageH = baseViewport.height;

    // Render full page → fallback PNG
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    const imageDataUrl = canvas.toDataURL("image/png");

    // Text content with positions
    const tc = await page.getTextContent();
    const items = tc.items as TextItem[];
    const lines: Array<{ text: string; x: number; y: number; w: number; h: number; fontSize: number }> = [];
    // PDF y is from bottom; convert to top-origin so it's intuitive
    const grouped: Array<{ y: number; items: TextItem[] }> = [];
    const TOL = 2;
    for (const it of items) {
      const yBottom = it.transform[5];
      const yTop = pageH - yBottom;
      let bucket = grouped.find(g => Math.abs(g.y - yTop) <= TOL);
      if (!bucket) { bucket = { y: yTop, items: [] }; grouped.push(bucket); }
      bucket.items.push(it);
    }
    grouped.sort((a, b) => a.y - b.y);
    for (const g of grouped) {
      g.items.sort((a, b) => a.transform[4] - b.transform[4]);
      const text = g.items.map(it => it.str).join(" ").replace(/\s+/g, " ").trim();
      if (!text) continue;
      const xs = g.items.map(it => it.transform[4]);
      const xMin = Math.min(...xs);
      const xMax = Math.max(...xs.map((x, idx) => x + g.items[idx].width));
      const fontSize = Math.max(...g.items.map(it => it.height || 10));
      lines.push({ text, x: xMin, y: g.y, w: xMax - xMin, h: fontSize, fontSize });
    }

    // Embedded raster images
    const images = await extractImages(page, pageH).catch(() => []);

    pages.push({
      index: i - 1,
      text: lines.map(l => l.text).join("\n"),
      imageDataUrl,
      width: baseViewport.width,
      height: pageH,
      lines,
      images,
    });
    onProgress?.(i, doc.numPages);
  }
  return { pages, meta: { title: info.Title, author: info.Author } };
}

interface PdfPageWithObjs {
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  commonObjs: { get(name: string, cb: (obj: unknown) => void): void; has(name: string): boolean };
  objs: { get(name: string, cb: (obj: unknown) => void): void; has(name: string): boolean };
  getViewport(opts: { scale: number }): { transform: number[] };
}

async function extractImages(page: unknown, pageH: number): Promise<ExtractedImage[]> {
  const p = page as PdfPageWithObjs;
  const ops = await p.getOperatorList();
  const OPS = pdfjsLib.OPS as unknown as Record<string, number>;
  const PAINT_IMG = OPS.paintImageXObject ?? 85;
  const PAINT_IMG_INLINE = OPS.paintInlineImageXObject ?? 86;
  const TRANSFORM = OPS.transform ?? 12;
  const SAVE = OPS.save ?? 10;
  const RESTORE = OPS.restore ?? 11;

  const out: ExtractedImage[] = [];
  // Track CTM stack
  const stack: number[][] = [[1, 0, 0, 1, 0, 0]];
  const cur = () => stack[stack.length - 1];
  const mul = (a: number[], b: number[]) => [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === SAVE) stack.push([...cur()]);
    else if (fn === RESTORE) { if (stack.length > 1) stack.pop(); }
    else if (fn === TRANSFORM) {
      stack[stack.length - 1] = mul(cur(), args as number[]);
    } else if (fn === PAINT_IMG || fn === PAINT_IMG_INLINE) {
      const name = args[0] as string;
      const ctm = cur();
      // CTM e/f is image origin in PDF space; image w in PDF space is sqrt(a^2+b^2), h is sqrt(c^2+d^2)
      const w = Math.hypot(ctm[0], ctm[1]);
      const h = Math.hypot(ctm[2], ctm[3]);
      const yPdf = ctm[5]; // bottom y in PDF coords (origin lower-left). Image extends from yPdf to yPdf+h.
      const yTop = pageH - (yPdf + h);

      const obj = await getObj(p, name);
      if (!obj) continue;
      const dataUrl = await imageObjectToDataUrl(obj);
      if (!dataUrl) continue;
      // Filter tiny artefacts (<24 px)
      const oo = obj as { width?: number; height?: number };
      if ((oo.width ?? 0) < 24 || (oo.height ?? 0) < 24) continue;
      out.push({ dataUrl, y: yTop, w, h });
    }
  }
  // Sort top-to-bottom
  out.sort((a, b) => a.y - b.y);
  return out;
}

function getObj(p: PdfPageWithObjs, name: string): Promise<unknown | null> {
  return new Promise((resolve) => {
    const try1 = () => {
      try {
        if (p.objs.has(name)) { p.objs.get(name, (o) => resolve(o)); return true; }
      } catch { /* ignore */ }
      return false;
    };
    const try2 = () => {
      try {
        if (p.commonObjs.has(name)) { p.commonObjs.get(name, (o) => resolve(o)); return true; }
      } catch { /* ignore */ }
      return false;
    };
    if (try1()) return;
    if (try2()) return;
    // Fallback: get without has — pdfjs callbacks resolve once available
    try { p.objs.get(name, (o) => resolve(o)); }
    catch { resolve(null); }
  });
}

interface PdfImageObject {
  width?: number;
  height?: number;
  bitmap?: ImageBitmap;
  data?: Uint8ClampedArray | Uint8Array;
  kind?: number;
}

async function imageObjectToDataUrl(obj: unknown): Promise<string | null> {
  const o = obj as PdfImageObject;
  if (!o) return null;
  const w = o.width ?? 0;
  const h = o.height ?? 0;
  if (!w || !h) return null;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  if (o.bitmap) {
    ctx.drawImage(o.bitmap, 0, 0);
    return canvas.toDataURL("image/png");
  }
  if (o.data) {
    const bytes = o.data;
    const id = ctx.createImageData(w, h);
    // pdfjs image kinds: 1 = GRAYSCALE 8bpc, 2 = RGB 8bpc, 3 = RGBA 8bpc
    const kind = o.kind ?? 2;
    let p = 0;
    if (kind === 1) {
      for (let i = 0; i < bytes.length; i++) {
        const v = bytes[i];
        id.data[p++] = v; id.data[p++] = v; id.data[p++] = v; id.data[p++] = 255;
      }
    } else if (kind === 2) {
      for (let i = 0; i < bytes.length; i += 3) {
        id.data[p++] = bytes[i]; id.data[p++] = bytes[i + 1]; id.data[p++] = bytes[i + 2]; id.data[p++] = 255;
      }
    } else {
      for (let i = 0; i < bytes.length; i++) id.data[p++] = bytes[i];
    }
    ctx.putImageData(id, 0, 0);
    return canvas.toDataURL("image/png");
  }
  return null;
}
