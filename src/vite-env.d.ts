/// <reference types="vite/client" />

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
