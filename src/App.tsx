import { useEffect, useRef, useState } from "react";
import { saveAs } from "file-saver";
import { FREE_MODELS, DEFAULT_MODEL, DEFAULT_API_KEY } from "./lib/openrouter";
import { expandInputs, type IntakeFile } from "./lib/intake";
import { PdfPreview, SlidesPreview, DocPreview } from "./components/Preview";
import { SwipeDeck } from "./components/SwipeDeck";
import { useObjectUrl } from "./lib/useObjectUrl";
import type { SlidePlan, DocPlan } from "./lib/types";
import "./App.css";

type Kind = "presentation" | "document";

interface QueueItem {
  id: string;
  path: string;
  blob: Blob;
  kind: Kind;
  status: "queued" | "extracting" | "translating" | "building" | "done" | "error";
  progress: { done: number; total: number } | null;
  error?: string;
  message?: string;
  slides?: SlidePlan[];
  doc?: DocPlan;
  resultBlob?: Blob;
  resultName?: string;
}

interface UnsortedItem extends IntakeFile { id: string }

function createId(path: string): string {
  return `${path}_${crypto.randomUUID()}`;
}

function useLocalStorage<T extends string>(key: string, def: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { return ((localStorage.getItem(key) as T | null) ?? def) || def; } catch { return def; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, v); } catch { /* ignore */ }
  }, [key, v]);
  return [v, setV];
}

export default function App() {
  const [overrideKey, setOverrideKey] = useLocalStorage<string>("openrouter_key", "");
  const apiKey = overrideKey.trim() || DEFAULT_API_KEY;
  const hasKey = !!apiKey;
  const [model, setModel] = useLocalStorage<string>("openrouter_model", DEFAULT_MODEL);
  const [showSettings, setShowSettings] = useState(!apiKey);

  const [unsorted, setUnsorted] = useState<UnsortedItem[]>([]);
  const [items, setItems] = useState<QueueItem[]>([]);
  const [running, setRunning] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const visionCapable = FREE_MODELS.find(m => m.id === model)?.vision ?? false;

  const updateItem = (id: string, patch: Partial<QueueItem>) =>
    setItems(prev => prev.map(it => it.id === id ? { ...it, ...patch } : it));

  async function handleFiles(files: FileList | File[]) {
    const arr = Array.from(files);
    const inputs = await expandInputs(arr);
    if (inputs.length === 0) {
      alert("В выбранных файлах не нашлось поддерживаемых документов.");
      return;
    }
    const newItems: UnsortedItem[] = inputs.map(p => ({
      ...p,
      id: createId(p.path),
    }));
    setUnsorted(prev => [...prev, ...newItems]);
  }

  function commitToQueue(unsortedItem: UnsortedItem, kind: Kind) {
    setUnsorted(prev => prev.filter(u => u.id !== unsortedItem.id));
    const queueItem: QueueItem = {
      id: unsortedItem.id,
      path: unsortedItem.path,
      blob: unsortedItem.blob,
      kind,
      status: "queued",
      progress: null,
    };
    setItems(prev => [...prev, queueItem]);
    if (!selectedId) setSelectedId(queueItem.id);
  }

  function undoFromQueue(id: string) {
    const it = items.find(x => x.id === id);
    if (!it) return;
    setItems(prev => prev.filter(x => x.id !== id));
    setUnsorted(prev => [{ id: it.id, path: it.path, blob: it.blob }, ...prev]);
  }

  function skipUnsorted(id: string) {
    setUnsorted(prev => prev.filter(u => u.id !== id));
  }

  async function autoSortAll() {
    const todo = [...unsorted];
    const { suggestKind } = await import("./lib/extractAny");
    for (const u of todo) {
      const k = await suggestKind(u.path, u.blob);
      commitToQueue(u, k);
    }
  }

  async function processItem(it: QueueItem) {
    const signal = abortRef.current?.signal;
    try {
      updateItem(it.id, { status: "extracting", message: "Извлечение содержимого…", progress: null });
      const { extractAny } = await import("./lib/extractAny");
      const extracted = await extractAny(it.blob, it.path.split("/").pop() || it.path,
        (p, t) => updateItem(it.id, { progress: { done: p, total: t } }));
      if (signal?.aborted) throw new Error("aborted");

      updateItem(it.id, {
        status: "translating",
        message: `Перевод (${it.kind === "presentation" ? "презентация" : "документ"})…`,
        progress: { done: 0, total: extracted.pages.length },
      });

      const opts = {
        apiKey, model, visionCapable, signal,
        onLog: (m: string) => updateItem(it.id, { message: m }),
        onProgress: (d: number, t: number) => updateItem(it.id, { progress: { done: d, total: t } }),
      };

      if (it.kind === "presentation") {
        const [{ planSlides }, { buildPptx }] = await Promise.all([
          import("./lib/planner"),
          import("./lib/pptxBuild"),
        ]);
        const slides = await planSlides(extracted, opts);
        if (signal?.aborted) throw new Error("aborted");
        updateItem(it.id, { status: "building", message: "Сборка PPTX…", slides });
        const blob = await buildPptx(slides);
        const name = (it.path.replace(/\.[^./]+$/, "").split("/").pop() || "result") + "_MIET_ru.pptx";
        updateItem(it.id, { status: "done", message: `Готово: ${name}`, resultBlob: blob, resultName: name, progress: null });
      } else {
        const [{ planDoc }, { buildDocx }] = await Promise.all([
          import("./lib/planner"),
          import("./lib/docxBuild"),
        ]);
        const doc = await planDoc(extracted, opts);
        if (signal?.aborted) throw new Error("aborted");
        updateItem(it.id, { status: "building", message: "Сборка DOCX…", doc });
        const blob = await buildDocx(doc);
        const name = (it.path.replace(/\.[^./]+$/, "").split("/").pop() || "result") + "_ru.docx";
        updateItem(it.id, { status: "done", message: `Готово: ${name}`, resultBlob: blob, resultName: name, progress: null });
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "aborted") {
        updateItem(it.id, { status: "queued", message: "Отменено", progress: null });
      } else {
        console.error(e);
        updateItem(it.id, { status: "error", error: msg, message: `Ошибка: ${msg}`, progress: null });
      }
    }
  }

  async function runAll() {
    if (running) return;
    abortRef.current = new AbortController();
    setRunning(true);
    try {
      const queue = items.filter(it => it.status === "queued" || it.status === "error");
      for (const it of queue) {
        if (abortRef.current?.signal.aborted) break;
        await processItem(it);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function cancelAll() {
    abortRef.current?.abort();
  }

  function clearAll() {
    if (running) return;
    setItems([]); setUnsorted([]); setSelectedId(null);
  }

  async function downloadAll() {
    const done = items.filter(it => it.status === "done" && it.resultBlob && it.resultName);
    if (done.length === 0) return;
    if (done.length === 1) { saveAs(done[0].resultBlob!, done[0].resultName!); return; }
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const it of done) zip.file(it.resultName!, it.resultBlob!);
    const blob = await zip.generateAsync({ type: "blob" });
    saveAs(blob, "miet-translator-results.zip");
  }

  function downloadOne(it: QueueItem) {
    if (it.resultBlob && it.resultName) saveAs(it.resultBlob, it.resultName);
  }

  function removeItem(id: string) {
    setItems(prev => prev.filter(it => it.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  function changeKind(id: string, kind: Kind) {
    updateItem(id, { kind });
  }

  // Drag-drop on body
  const dropRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = dropRef.current;
    if (!el) return;
    const onDragOver = (e: DragEvent) => { e.preventDefault(); el.classList.add("drag-over"); };
    const onDragLeave = () => el.classList.remove("drag-over");
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      el.classList.remove("drag-over");
      const dt = e.dataTransfer;
      if (!dt) return;
      const items = Array.from(dt.items || []);
      const entries = items.map(it => it.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
      if (entries.length > 0 && entries.some(en => en.isDirectory)) {
        readEntries(entries).then(files => handleFiles(files));
      } else {
        handleFiles(dt.files);
      }
    };
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("dragleave", onDragLeave);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("dragleave", onDragLeave);
      el.removeEventListener("drop", onDrop);
    };
  }, []);

  const selected = items.find(it => it.id === selectedId) || null;
  const totalQueued = items.filter(i => i.status === "queued" || i.status === "error").length;

  return (
    <div className="app">
      <header className="topbar">
        <h1>MIET Translator</h1>
        <div className="topbar-right">
          {!hasKey && <span className="key-warning" onClick={() => setShowSettings(true)}>⚠ Нужен ключ OpenRouter</span>}
          <button className="ghost" onClick={() => setShowSettings(s => !s)}>
            {showSettings ? "Скрыть настройки" : "Настройки"}
          </button>
        </div>
      </header>

      {showSettings && (
        <section className="settings">
          <div className={`key-row ${hasKey ? "key-ok" : "key-missing"}`}>
            <label>
              <strong>OpenRouter API key</strong>
              <input type="password" value={overrideKey} onChange={e => setOverrideKey(e.target.value)}
                placeholder="sk-or-v1-…" autoComplete="off" spellCheck={false} />
            </label>
            <p className="muted small">
              {hasKey ? "Ключ сохранён в браузере (localStorage). Ни на GitHub, ни куда-то ещё он не уходит — только прямо в openrouter.ai."
                     : <>Без ключа перевод работать не будет. Бесплатный ключ можно получить на <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">openrouter.ai/keys</a>. Он хранится только в этом браузере.</>}
            </p>
          </div>
          <label>
            Модель{" "}
            <select value={model} onChange={e => setModel(e.target.value)}>
              {FREE_MODELS.map(m => (<option key={m.id} value={m.id}>{m.label}</option>))}
            </select>
          </label>
        </section>
      )}

      <div className="main">
        <aside className="sidebar">
          <div className="dropzone" ref={dropRef}>
            <p>Брось <b>файлы</b>, <b>папку</b> или <b>.zip / .rar / .7z</b></p>
            <p className="muted small">PDF · PPTX · DOCX · картинки · txt</p>
            <div className="dropzone-actions">
              <label className="ghost">
                Файлы…
                <input type="file" multiple accept=".pdf,.pptx,.docx,.png,.jpg,.jpeg,.webp,.gif,.bmp,.txt,.md,.zip,.rar,.7z,.tar,.gz,.tgz"
                  onChange={e => e.target.files && handleFiles(e.target.files)} hidden />
              </label>
              <label className="ghost">
                Папка…
                <input type="file" {...{ webkitdirectory: "" } as React.InputHTMLAttributes<HTMLInputElement>}
                  onChange={e => e.target.files && handleFiles(e.target.files)} hidden />
              </label>
            </div>
          </div>

          <div className="queue-controls">
            <button className="primary" onClick={runAll} disabled={running || totalQueued === 0 || !hasKey}
                    title={!hasKey ? "Добавь OpenRouter ключ в Настройках" : ""}>
              {running ? "Обработка…" : `Запустить (${totalQueued})`}
            </button>
            {running && <button className="ghost" onClick={cancelAll}>Стоп</button>}
            <button className="ghost" onClick={downloadAll} disabled={!items.some(i => i.status === "done")}>
              ⬇ Скачать всё
            </button>
            <button className="ghost" onClick={clearAll} disabled={running}>Очистить</button>
          </div>

          <ul className="queue">
            {items.map(it => (
              <li key={it.id}
                  className={`q-item q-${it.status} ${selectedId === it.id ? "selected" : ""}`}
                  onClick={() => setSelectedId(it.id)}>
                <div className="q-top">
                  <span className="q-name" title={it.path}>{it.path.split("/").pop()}</span>
                  <select className={`q-kind kind-${it.kind}`} value={it.kind}
                          onClick={e => e.stopPropagation()}
                          onChange={e => changeKind(it.id, e.target.value as Kind)}>
                    <option value="presentation">PPT</option>
                    <option value="document">DOC</option>
                  </select>
                  <button className="q-remove" title="удалить" onClick={e => { e.stopPropagation(); removeItem(it.id); }}>×</button>
                </div>
                <div className="q-status">{it.message ?? statusLabel(it.status)}</div>
                {it.progress && (
                  <div className="progress small">
                    <div className="bar" style={{ width: `${(it.progress.done / Math.max(it.progress.total, 1)) * 100}%` }} />
                  </div>
                )}
                {it.status === "done" && (
                  <button className="ghost q-download" onClick={e => { e.stopPropagation(); downloadOne(it); }}>
                    ⬇ {it.resultName}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </aside>

        <section className="viewer">
          {unsorted.length > 0 ? (
            <SwipeDeck
              items={unsorted}
              onDecide={(id, kind) => {
                const u = unsorted.find(x => x.id === id);
                if (u) commitToQueue(u, kind);
              }}
              onUndo={(id) => undoFromQueue(id)}
              onAutoSortAll={autoSortAll}
              onSkip={skipUnsorted}
            />
          ) : !selected ? (
            <div className="empty">
              <p>Выбери файл слева, чтобы увидеть оригинал и результат рядом.</p>
            </div>
          ) : (
            <div className="side-by-side">
              <div className="pane">
                <div className="pane-header">Оригинал · {selected.path.split("/").pop()}</div>
                <OriginalPreview blob={selected.blob} path={selected.path} />
              </div>
              <div className="pane">
                <div className="pane-header">
                  Результат · {selected.kind === "presentation" ? "PPTX (MIET)" : "DOCX"}
                </div>
                {selected.slides ? <SlidesPreview slides={selected.slides} />
                  : selected.doc ? <DocPreview doc={selected.doc} />
                  : <div className="preview-pane empty">{selected.message || "Ещё не обработано"}</div>}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function OriginalPreview({ blob, path }: { blob: Blob; path: string }) {
  const ext = path.toLowerCase().split(".").pop();
  if (ext === "pdf") return <PdfPreview blob={blob} />;
  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp" || ext === "gif" || ext === "bmp") {
    return <ImageOnly blob={blob} />;
  }
  return <RawTextPreview blob={blob} path={path} />;
}

function ImageOnly({ blob }: { blob: Blob }) {
  const url = useObjectUrl(blob);
  return <div className="preview-pane"><img src={url} alt="" style={{ maxWidth: "100%" }} /></div>;
}

function RawTextPreview({ blob, path }: { blob: Blob; path: string }) {
  const [text, setText] = useState("Загрузка…");
  useEffect(() => {
    (async () => {
      const ext = path.toLowerCase().split(".").pop();
      try {
        if (ext === "docx") {
          const { extractRawText } = await import("mammoth/mammoth.browser.js");
          const r = await extractRawText({ arrayBuffer: await blob.arrayBuffer() });
          setText(r.value || "(пусто)");
        } else if (ext === "pptx") {
          const JSZipMod = (await import("jszip")).default;
          const zip = await JSZipMod.loadAsync(await blob.arrayBuffer());
          const slides = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort();
          const out: string[] = [];
          for (let i = 0; i < slides.length; i++) {
            const xml = await zip.files[slides[i]].async("string");
            const txt: string[] = [];
            const re = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(xml))) txt.push(m[1]);
            out.push(`--- Слайд ${i + 1} ---\n` + txt.join("\n"));
          }
          setText(out.join("\n\n"));
        } else {
          setText(await blob.text());
        }
      } catch (e) {
        setText("Не удалось прочитать: " + (e as Error).message);
      }
    })();
  }, [blob, path]);
  return <div className="preview-pane"><pre className="raw-text">{text}</pre></div>;
}

function statusLabel(s: QueueItem["status"]): string {
  switch (s) {
    case "queued": return "В очереди";
    case "extracting": return "Чтение…";
    case "translating": return "Перевод…";
    case "building": return "Сборка…";
    case "done": return "Готово";
    case "error": return "Ошибка";
  }
}

async function readEntries(entries: FileSystemEntry[]): Promise<File[]> {
  const out: File[] = [];
  async function walk(entry: FileSystemEntry, prefix: string) {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      Object.defineProperty(file, "webkitRelativePath", { value: prefix + entry.name, configurable: true });
      out.push(file);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const children: FileSystemEntry[] = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const c of children) await walk(c, prefix + entry.name + "/");
    }
  }
  for (const e of entries) await walk(e, "");
  return out;
}
