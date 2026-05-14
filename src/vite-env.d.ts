/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** OpenRouter API key embedded at build time. See `.env.example`. */
  readonly VITE_OPENROUTER_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.pptx?url" {
  const src: string;
  export default src;
}

declare module "pdfjs-dist/build/pdf.worker.min.mjs?url" {
  const src: string;
  export default src;
}

declare module "temml" {
  interface TemmlOptions {
    displayMode?: boolean;
    throwOnError?: boolean;
    strict?: boolean;
    [k: string]: unknown;
  }
  function renderToString(latex: string, options?: TemmlOptions): string;
  const _default: { renderToString: typeof renderToString };
  export default _default;
}

declare module "libarchive.js" {
  export class Archive {
    static init(opts: { workerUrl?: string }): void;
    static open(file: File | Blob): Promise<{
      extractFiles(): Promise<Record<string, unknown>>;
    }>;
  }
}

declare module "mammoth/mammoth.browser.js" {
  export function extractRawText(opts: { arrayBuffer: ArrayBuffer }): Promise<{ value: string; messages: unknown[] }>;
  export function convertToHtml(opts: { arrayBuffer: ArrayBuffer }): Promise<{ value: string; messages: unknown[] }>;
  const _default: { extractRawText: typeof extractRawText; convertToHtml: typeof convertToHtml };
  export default _default;
}
