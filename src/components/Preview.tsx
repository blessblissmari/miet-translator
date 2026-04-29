import { useEffect, useRef } from "react";
import temml from "temml";
import type { SlidePlan, DocPlan, DocBlock } from "../lib/types";

/* ──────────────────────────────────────────────
 * Original PDF preview (canvas pages, vertical)
 * ────────────────────────────────────────────── */
export function PdfPreview({ blob }: { blob: Blob }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!ref.current) return;
      ref.current.innerHTML = "";
      const pdfjsLib = await import("pdfjs-dist");
      const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
      const buf = await blob.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data: buf }).promise;
      for (let i = 1; i <= doc.numPages; i++) {
        if (cancelled) return;
        const page = await doc.getPage(i);
        const viewport = page.getViewport({ scale: 1 });
        const canvas = document.createElement("canvas");
        const targetW = 360;
        const scale = targetW / viewport.width;
        const vp = page.getViewport({ scale });
        canvas.width = vp.width;
        canvas.height = vp.height;
        canvas.className = "pdf-page";
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
        ref.current.appendChild(canvas);
      }
    })().catch(console.error);
    return () => { cancelled = true; };
  }, [blob]);

  return <div className="preview-pane" ref={ref} />;
}

/* ──────────────────────────────────────────────
 * Generated PPTX preview — render SlidePlan as HTML slides
 * ────────────────────────────────────────────── */
export function SlidesPreview({ slides }: { slides: SlidePlan[] }) {
  return (
    <div className="preview-pane">
      {slides.map((s, i) => <SlideHTML key={i} slide={s} index={i + 1} />)}
    </div>
  );
}

function SlideHTML({ slide, index }: { slide: SlidePlan; index: number }) {
  const layoutClass = `slide slide-${slide.layout}`;
  return (
    <div className={layoutClass}>
      <div className="slide-num">{index}</div>
      {slide.layout === "section-title" ? (
        <div className="section-title">{slide.title}</div>
      ) : (
        <>
          <div className="slide-title">{slide.title}</div>
          <div className="slide-body">
            <div className="slide-bullets">
              {slide.bullets.map((b, i) => <div key={i} className="bullet">• {b}</div>)}
            </div>
            {slide.imageDataUrl && (
              <img src={slide.imageDataUrl} alt={`slide ${index}`} className="slide-img" />
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────
 * Generated DOCX preview — render DocPlan blocks as HTML
 * ────────────────────────────────────────────── */
export function DocPreview({ doc }: { doc: DocPlan }) {
  return (
    <div className="preview-pane doc-preview">
      {doc.title && <h1>{doc.title}</h1>}
      {doc.blocks.map((b, i) => <DocBlockEl key={i} block={b} />)}
    </div>
  );
}

function DocBlockEl({ block }: { block: DocBlock }) {
  switch (block.type) {
    case "h1": return <h1>{block.text}</h1>;
    case "h2": return <h2>{block.text}</h2>;
    case "h3": return <h3>{block.text}</h3>;
    case "para": return <p>{block.text}</p>;
    case "list": {
      if (block.ordered) return <ol>{block.items.map((it, i) => <li key={i}>{it}</li>)}</ol>;
      return <ul>{block.items.map((it, i) => <li key={i}>{it}</li>)}</ul>;
    }
    case "formula": {
      let html: string;
      try {
        html = temml.renderToString(block.latex, { displayMode: !!block.display, throwOnError: false });
      } catch {
        html = `<code>${block.latex}</code>`;
      }
      const Tag = block.display ? "div" : "span";
      return <Tag className={block.display ? "formula-display" : "formula-inline"} dangerouslySetInnerHTML={{ __html: html }} />;
    }
    case "figure":
      return (
        <figure>
          <img src={block.imageDataUrl} alt={block.caption || "figure"} />
          {block.caption && <figcaption>{block.caption}</figcaption>}
        </figure>
      );
  }
}
