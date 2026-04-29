import {
  Document, Packer, Paragraph, HeadingLevel, TextRun, ImageRun, AlignmentType,
} from "docx";
import { latexToOmml } from "./latexOmml";
import type { DocPlan, DocBlock } from "./types";

function dataUrlToUint8(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1];
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

async function imageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.width, height: img.height });
    img.onerror = () => resolve({ width: 480, height: 360 });
    img.src = dataUrl;
  });
}

/**
 * Workaround: docx@9 doesn't expose a public OMML element, but Paragraph accepts
 * a ConcreteHierarchyElement-like child via constructor.children. We use a small
 * "raw" wrapper that emits arbitrary XML via the docx import-export hook below.
 *
 * Simpler alternative used here: render formulas as italicized monospace text
 * carrying the LaTeX source AND a hidden OMML run is appended via post-processing
 * on the packed file.
 *
 * For now, we render formulas as text in a distinctive style; OMML embedding is
 * applied post-pack on the .docx file by direct XML injection.
 */

interface FormulaMarker { id: string; latex: string; display: boolean; }

export async function buildDocx(plan: DocPlan): Promise<Blob> {
  const formulaMarkers: FormulaMarker[] = [];
  const children: Paragraph[] = [];

  if (plan.title?.trim()) {
    children.push(new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: plan.title, bold: true, size: 36 })],
    }));
  }

  for (const block of plan.blocks) {
    children.push(...(await blockToParagraphs(block, formulaMarkers)));
  }

  const doc = new Document({
    creator: "MIET Translator",
    title: plan.title || "Document",
    styles: {
      default: { document: { run: { font: "Calibri", size: 24 } } },
    },
    sections: [{ children }],
  });

  const blob = await Packer.toBlob(doc);
  if (formulaMarkers.length === 0) return blob;
  return injectOmmlIntoDocx(blob, formulaMarkers);
}

async function blockToParagraphs(block: DocBlock, formulas: FormulaMarker[]): Promise<Paragraph[]> {
  switch (block.type) {
    case "h1":
      return [new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: block.text, bold: true })] })];
    case "h2":
      return [new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: block.text, bold: true })] })];
    case "h3":
      return [new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text: block.text, bold: true })] })];
    case "para":
      return [new Paragraph({ children: [new TextRun(block.text)] })];
    case "list":
      return block.items.map((it) => new Paragraph({
        bullet: block.ordered ? undefined : { level: 0 },
        numbering: block.ordered ? { reference: "ordered", level: 0 } : undefined,
        children: [new TextRun(it)],
      }));
    case "formula": {
      const id = `OMMLMARK_${formulas.length.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      formulas.push({ id, latex: block.latex, display: !!block.display });
      return [new Paragraph({
        alignment: block.display ? AlignmentType.CENTER : AlignmentType.LEFT,
        children: [new TextRun({ text: id, font: "Cambria Math" })],
      })];
    }
    case "figure": {
      const bytes = dataUrlToUint8(block.imageDataUrl);
      const dims = await imageDimensions(block.imageDataUrl);
      const maxW = 480;
      const scale = dims.width > maxW ? maxW / dims.width : 1;
      const out: Paragraph[] = [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new ImageRun({
            data: bytes,
            type: "png",
            transformation: { width: dims.width * scale, height: dims.height * scale },
          })],
        }),
      ];
      if (block.caption) {
        out.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: block.caption, italics: true, size: 20 })],
        }));
      }
      return out;
    }
  }
}

/** After docx is packed, replace each text marker `OMMLMARK_xxx` in
 *  word/document.xml with an actual <m:oMath> block.
 */
async function injectOmmlIntoDocx(blob: Blob, markers: FormulaMarker[]): Promise<Blob> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const docXmlFile = zip.file("word/document.xml");
  if (!docXmlFile) return blob;
  let xml = await docXmlFile.async("string");

  for (const m of markers) {
    const omml = latexToOmml(m.latex, m.display);
    // Replace the entire <w:r> ... text=ID ... </w:r> block with the oMath element
    const re = new RegExp(`<w:r\\b[^>]*>(?:(?!</w:r>)[\\s\\S])*?${m.id}[\\s\\S]*?</w:r>`, "g");
    xml = xml.replace(re, omml);
  }

  zip.file("word/document.xml", xml);
  return zip.generateAsync({ type: "blob" });
}
