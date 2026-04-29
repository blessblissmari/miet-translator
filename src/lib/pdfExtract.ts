import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { ExtractedDoc, ExtractedPage } from "./types";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

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

    // Render to canvas → PNG data URL
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d")!;
    // White background to avoid transparent renders that look wrong in slides
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    const imageDataUrl = canvas.toDataURL("image/png");

    // Extract text
    const tc = await page.getTextContent();
    const lines: string[] = [];
    let lastY: number | null = null;
    let buffer = "";
    for (const item of tc.items as Array<{ str: string; transform: number[] }>) {
      const y = item.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        if (buffer.trim()) lines.push(buffer.trimEnd());
        buffer = "";
      }
      buffer += item.str + " ";
      lastY = y;
    }
    if (buffer.trim()) lines.push(buffer.trimEnd());

    pages.push({
      index: i - 1,
      text: lines.join("\n"),
      imageDataUrl,
      width: viewport.width,
      height: viewport.height,
    });
    onProgress?.(i, doc.numPages);
  }
  return { pages, meta: { title: info.Title, author: info.Author } };
}
