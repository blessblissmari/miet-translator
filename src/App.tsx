import { useEffect, useMemo, useState } from "react";
import { saveAs } from "file-saver";
import { extractPdf } from "./lib/pdfExtract";
import { planSlides, planDoc } from "./lib/planner";
import { buildPptx } from "./lib/pptxBuild";
import { buildDocx } from "./lib/docxBuild";
import { FREE_MODELS, DEFAULT_MODEL } from "./lib/openrouter";
import type { TargetLang } from "./lib/types";
import "./App.css";

type Mode = "presentation" | "document";

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
  const [apiKey, setApiKey] = useLocalStorage<string>("openrouter_key", "");
  const [model, setModel] = useLocalStorage<string>("openrouter_model", DEFAULT_MODEL);
  const [mode, setMode] = useLocalStorage<Mode>("mode", "presentation");
  const [lang, setLang] = useLocalStorage<TargetLang>("lang", "ru");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultName, setResultName] = useState<string>("");

  const visionCapable = useMemo(() => FREE_MODELS.find(m => m.id === model)?.vision ?? false, [model]);

  const log = (m: string) => setLogs(prev => [...prev, m]);

  async function run() {
    if (!apiKey) { alert("Введи ключ OpenRouter"); return; }
    if (!file) { alert("Выбери файл"); return; }
    setBusy(true);
    setLogs([]);
    setResultUrl(null);
    try {
      log(`Извлечение содержимого из ${file.name}…`);
      const ext = file.name.toLowerCase().split(".").pop();
      if (ext !== "pdf") {
        log("Пока поддержан только PDF на входе.");
        setBusy(false);
        return;
      }
      const extracted = await extractPdf(file, (p, t) => setProgress({ done: p, total: t }));
      log(`Извлечено страниц: ${extracted.pages.length}`);
      setProgress(null);

      if (mode === "presentation") {
        const slides = await planSlides(extracted, {
          apiKey, model, visionCapable, targetLang: lang,
          onLog: log,
          onProgress: (d, t) => setProgress({ done: d, total: t }),
        });
        log("Сборка PPTX из шаблона MIET…");
        const blob = await buildPptx(slides);
        const name = file.name.replace(/\.pdf$/i, "") + `_MIET_${lang}.pptx`;
        const url = URL.createObjectURL(blob);
        setResultUrl(url);
        setResultName(name);
        log(`Готово: ${name}`);
      } else {
        const docPlan = await planDoc(extracted, {
          apiKey, model, visionCapable, targetLang: lang,
          onLog: log,
          onProgress: (d, t) => setProgress({ done: d, total: t }),
        });
        log("Сборка DOCX…");
        const blob = await buildDocx(docPlan);
        const name = file.name.replace(/\.pdf$/i, "") + `_${lang}.docx`;
        const url = URL.createObjectURL(blob);
        setResultUrl(url);
        setResultName(name);
        log(`Готово: ${name}`);
      }
    } catch (e) {
      console.error(e);
      log(`Ошибка: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  function downloadResult() {
    if (!resultUrl) return;
    fetch(resultUrl).then(r => r.blob()).then(b => saveAs(b, resultName));
  }

  return (
    <div className="page">
      <header>
        <h1>MIET Translator</h1>
        <p className="muted">Перевод и конвертация презентаций / документов в шаблон МИЭТ. Всё в браузере, без бэкенда.</p>
      </header>

      <section className="card">
        <h2>1. OpenRouter</h2>
        <label>
          API key{" "}
          <input
            type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
            placeholder="sk-or-v1-…" autoComplete="off" spellCheck={false}
          />
        </label>
        <label>
          Модель{" "}
          <select value={model} onChange={e => setModel(e.target.value)}>
            {FREE_MODELS.map(m => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </label>
        <p className="muted small">
          Получить ключ:{" "}
          <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer">openrouter.ai/settings/keys</a>
          {" — "} ключ хранится только в твоём localStorage.
        </p>
      </section>

      <section className="card">
        <h2>2. Что переводим</h2>
        <div className="row">
          <label>
            <input type="radio" name="mode" checked={mode === "presentation"} onChange={() => setMode("presentation")} />
            Презентация → MIET PPTX
          </label>
          <label>
            <input type="radio" name="mode" checked={mode === "document"} onChange={() => setMode("document")} />
            Документ / PDF → DOCX
          </label>
        </div>
        <label>
          Целевой язык{" "}
          <select value={lang} onChange={e => setLang(e.target.value as TargetLang)}>
            <option value="ru">Русский</option>
            <option value="en">English</option>
          </select>
        </label>
      </section>

      <section className="card">
        <h2>3. Файл</h2>
        <input type="file" accept=".pdf" onChange={e => setFile(e.target.files?.[0] ?? null)} />
        {file && <p className="muted small">{file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB</p>}
      </section>

      <section className="card">
        <button className="primary" disabled={busy} onClick={run}>
          {busy ? "Обрабатывается…" : "Запустить"}
        </button>
        {progress && (
          <div className="progress">
            <div className="bar" style={{ width: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }} />
            <span className="small">{progress.done}/{progress.total}</span>
          </div>
        )}
        {resultUrl && (
          <p>
            <button className="primary" onClick={downloadResult}>Скачать «{resultName}»</button>
          </p>
        )}
        {logs.length > 0 && (
          <pre className="log">{logs.join("\n")}</pre>
        )}
      </section>

      <footer className="muted small">
        <p>Перенос графиков из PDF: рендер каждой страницы как картинка → вставка в макет «Заголовок и картинка». Для пиксель-в-пиксель переноса лучше скармливать исходные .pptx.</p>
        <p>Бесплатные модели OpenRouter имеют rate-limit (~20 req/min, 50 req/day без $10 баланса). Тулза автоматически делает retry с задержкой.</p>
      </footer>
    </div>
  );
}
