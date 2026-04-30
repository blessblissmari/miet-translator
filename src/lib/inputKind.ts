export type InputKind = "pdf" | "pptx" | "docx" | "image" | "text" | "unknown";

const PDF_EXT = /\.pdf$/i;
const PPTX_EXT = /\.pptx$/i;
const DOCX_EXT = /\.docx$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
const TEXT_EXT = /\.(txt|md|markdown|rst)$/i;

export function classifyInput(filename: string): InputKind {
  if (PDF_EXT.test(filename)) return "pdf";
  if (PPTX_EXT.test(filename)) return "pptx";
  if (DOCX_EXT.test(filename)) return "docx";
  if (IMAGE_EXT.test(filename)) return "image";
  if (TEXT_EXT.test(filename)) return "text";
  return "unknown";
}
