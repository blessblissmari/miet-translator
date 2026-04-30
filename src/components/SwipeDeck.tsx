import { useCallback, useEffect, useRef, useState } from "react";
import { classifyInput } from "../lib/inputKind";
import type { IntakeFile } from "../lib/intake";
import { loadPdfDocument } from "../lib/pdfjs";
import { useObjectUrl } from "../lib/useObjectUrl";

export type Kind = "presentation" | "document";

interface DeckItem extends IntakeFile {
  id: string;
}

interface Props {
  items: DeckItem[];
  /** Called once user picks (or undoes) for an item. */
  onDecide: (id: string, kind: Kind) => void;
  onUndo: (id: string) => void;
  onAutoSortAll: () => void;
  onSkip: (id: string) => void;
}

export function SwipeDeck({ items, onDecide, onUndo, onAutoSortAll, onSkip }: Props) {
  const [history, setHistory] = useState<{ id: string; kind: Kind }[]>([]);

  const commit = useCallback((kind: Kind) => {
    const next = items[0];
    if (!next) return;
    onDecide(next.id, kind);
    setHistory(h => [...h, { id: next.id, kind }]);
  }, [items, onDecide]);

  const undo = useCallback(() => {
    setHistory(h => {
      const last = h[h.length - 1];
      if (last) onUndo(last.id);
      return last ? h.slice(0, -1) : h;
    });
  }, [onUndo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "ArrowRight") { e.preventDefault(); commit("presentation"); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); commit("document"); }
      else if (e.key === "Backspace" || e.key === "Escape") { e.preventDefault(); undo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commit, undo]);

  const top = items[0];

  return (
    <div className="deck-root">
      <div className="deck-header">
        <div>
          <strong>Рассортируй файлы</strong>
          <span className="muted small"> · {items.length} осталось</span>
        </div>
        <div className="deck-actions">
          <button className="ghost" onClick={undo} disabled={history.length === 0}>↩ Отмена</button>
          <button className="ghost" onClick={onAutoSortAll}>⚡ Авто-сортировка всех</button>
        </div>
      </div>

      <div className="deck-stage">
        {/* Render up to 3 stacked cards for depth */}
        {items.slice(0, 3).reverse().map((it, idx, arr) => {
          const isTop = idx === arr.length - 1;
          return (
            <Card key={it.id} item={it}
              isTop={isTop}
              depth={arr.length - 1 - idx}
              onDecide={kind => isTop && commit(kind)}
              onSkip={() => isTop && onSkip(it.id)}
            />
          );
        })}
      </div>

      <div className="deck-footer">
        <button className="big-action big-doc"  onClick={() => commit("document")}      disabled={!top}>← DOCX</button>
        <button className="ghost" onClick={() => top && onSkip(top.id)} disabled={!top}>пропустить</button>
        <button className="big-action big-ppt"  onClick={() => commit("presentation")}  disabled={!top}>PPT →</button>
      </div>
      <p className="muted small deck-hint">←/→ стрелки на клавиатуре · Backspace — отмена</p>
    </div>
  );
}

function Card({ item, isTop, depth, onDecide, onSkip }: {
  item: DeckItem; isTop: boolean; depth: number;
  onDecide: (kind: Kind) => void; onSkip: () => void;
}) {
  const [drag, setDrag] = useState<{ x: number; startX: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Pointer drag
  useEffect(() => {
    if (!isTop) return;
    const el = ref.current;
    if (!el) return;
    let startX = 0;
    let active = false;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "BUTTON" || t.tagName === "INPUT" || t.closest("button")) return;
      active = true; startX = e.clientX;
      setDrag({ x: 0, startX });
      el.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!active) return;
      setDrag({ x: e.clientX - startX, startX });
    };
    const onUp = (e: PointerEvent) => {
      if (!active) return;
      active = false;
      const dx = e.clientX - startX;
      const TH = 100;
      if (dx > TH) {
        // Animate out and decide
        setDrag({ x: 800, startX });
        setTimeout(() => { onDecide("presentation"); setDrag(null); }, 160);
      } else if (dx < -TH) {
        setDrag({ x: -800, startX });
        setTimeout(() => { onDecide("document"); setDrag(null); }, 160);
      } else {
        setDrag(null);
      }
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
  }, [isTop, onDecide]);

  const dx = drag?.x ?? 0;
  const rot = dx / 18;
  const stackY = depth * -8;
  const stackS = 1 - depth * 0.04;
  const transform = `translate(${dx}px, ${stackY}px) rotate(${rot}deg) scale(${stackS})`;
  const transition = drag ? "none" : "transform 0.18s ease-out";
  const dirHint = dx > 30 ? "ppt" : dx < -30 ? "doc" : "";

  return (
    <div className={`deck-card ${isTop ? "top" : ""} ${dirHint}`}
         ref={ref} style={{ transform, transition }}>
      <CardThumb item={item} />
      <div className="card-meta">
        <div className="card-name" title={item.path}>{item.path.split("/").pop()}</div>
        <div className="muted small">{item.path}</div>
      </div>
      <div className="card-hint card-hint-doc">DOCX</div>
      <div className="card-hint card-hint-ppt">PPT</div>
      {isTop && <button className="card-skip ghost" onClick={onSkip}>пропустить</button>}
    </div>
  );
}

function CardThumb({ item }: { item: DeckItem }) {
  const kind = classifyInput(item.path);
  const url = useObjectUrl(item.blob);
  if (kind === "image") {
    return <div className="card-thumb image"><img src={url} alt="" /></div>;
  }
  if (kind === "pdf") {
    return <PdfThumb blob={item.blob} />;
  }
  if (kind === "pptx") {
    return <div className="card-thumb pptx"><div className="badge">PPTX</div></div>;
  }
  if (kind === "docx") {
    return <div className="card-thumb docx"><div className="badge">DOCX</div></div>;
  }
  if (kind === "text") {
    return <div className="card-thumb text"><div className="badge">TXT</div></div>;
  }
  return <div className="card-thumb unknown"><div className="badge">?</div></div>;
}

function PdfThumb({ blob }: { blob: Blob }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let doc;
      try {
        doc = await loadPdfDocument(blob);
        const page = await doc.getPage(1);
        const viewport = page.getViewport({ scale: 1 });
        const canvas = ref.current;
        if (!canvas || cancelled) return;
        const targetW = 400;
        const scale = targetW / viewport.width;
        const vp = page.getViewport({ scale });
        canvas.width = vp.width; canvas.height = vp.height;
        canvas.style.width = "100%"; canvas.style.height = "auto";
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        page.cleanup();
      } catch (e) {
        setErr((e as Error).message || "render failed");
      } finally {
        await doc?.destroy().catch(() => undefined);
      }
    })();
    return () => { cancelled = true; };
  }, [blob]);
  return <div className="card-thumb pdf">
    {err ? <div className="badge">PDF</div> : <canvas ref={ref} />}
  </div>;
}
