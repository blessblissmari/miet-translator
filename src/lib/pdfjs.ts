interface PdfRenderTask {
  promise: Promise<void>;
  cancel(): void;
}

export interface PdfViewport {
  width: number;
  height: number;
}

export interface PdfPageProxy {
  getViewport(opts: { scale: number }): PdfViewport;
  getTextContent(): Promise<{ items: unknown[] }>;
  render(args: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }): PdfRenderTask;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  cleanup(): void;
}

export interface PdfDocumentProxy {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageProxy>;
  getMetadata(): Promise<{ info?: unknown }>;
  destroy(): Promise<void>;
}

export interface PdfJsLib {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(opts: { data: Uint8Array<ArrayBuffer> }): { promise: Promise<PdfDocumentProxy> };
  OPS: Record<string, number>;
}

let pdfjsPromise: Promise<PdfJsLib> | null = null;

export async function loadPdfJs(): Promise<PdfJsLib> {
  pdfjsPromise ??= Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]).then(([pdfjsLib, worker]) => {
    const lib = pdfjsLib as unknown as PdfJsLib;
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  });
  return pdfjsPromise;
}

export async function loadPdfDocument(blob: Blob): Promise<PdfDocumentProxy> {
  const pdfjsLib = await loadPdfJs();
  const data = new Uint8Array(await blob.arrayBuffer());
  return pdfjsLib.getDocument({ data }).promise;
}
