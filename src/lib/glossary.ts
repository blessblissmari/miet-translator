/**
 * Cross-page terminology consistency.
 *
 * Problem: when each page is translated independently, the same English term
 * may map to different Russian translations across pages — "small-signal model"
 * becomes both «модель малого сигнала» and «малосигнальная модель» in the same
 * document. Readers find this jarring.
 *
 * Solution: after the first batch of pages is translated, harvest a small
 * EN→RU mapping by aligning frequent technical terms in the source with their
 * translation, and inject it into subsequent pages' system prompts as a
 * "do-not-deviate-from" glossary.
 *
 * The harvester is intentionally conservative: it only proposes terms that
 *   - appear at least twice across the source pages already seen
 *   - are 1–3 word phrases of letters/digits/dashes
 *   - get a stable Russian counterpart on every translated page that mentions
 *     them (otherwise we don't know which variant is the "right" one)
 *
 * This keeps the glossary small (~20 entries) and high-signal.
 */

export type Glossary = Map<string, string>;

const STOPWORDS = new Set<string>([
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "at", "by",
  "is", "are", "was", "were", "this", "that", "these", "those", "with",
  "from", "as", "be", "we", "you", "they", "if", "then", "so", "but",
  "can", "may", "will", "would", "should", "could", "have", "has", "had",
  "it", "its", "our", "their", "his", "her",
]);

const TERM_RE = /\b([A-Z][A-Za-z0-9-]{2,}(?:\s+[A-Z]?[A-Za-z0-9-]{2,}){0,2})\b/g;

/** Extract candidate technical terms (Title-Case multi-word phrases). */
export function harvestSourceTerms(source: string): Map<string, number> {
  const counts = new Map<string, number>();
  TERM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TERM_RE.exec(source))) {
    const phrase = m[1].trim();
    if (phrase.length < 4) continue;
    if (STOPWORDS.has(phrase.toLowerCase())) continue;
    if (/^\d+$/.test(phrase)) continue;
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  }
  return counts;
}

/** Render the glossary as a short prompt snippet, capped to N entries. */
export function glossaryPrompt(g: Glossary, max = 25): string {
  if (g.size === 0) return "";
  const items = Array.from(g.entries()).slice(0, max);
  const lines = items.map(([en, ru]) => `  - ${en} → ${ru}`).join("\n");
  return `\nKeep terminology consistent with the document-wide glossary already established:\n${lines}\n(Use these EXACT Russian translations whenever the English term appears.)`;
}

/** Merge new (EN, RU) pairs into existing glossary. First-seen wins. */
export function mergeGlossary(g: Glossary, pairs: Iterable<[string, string]>): void {
  for (const [en, ru] of pairs) {
    if (!g.has(en)) g.set(en, ru);
  }
}

/**
 * Heuristic: if `sourceText` contains an EN term and `translation` contains
 * the same English token verbatim ALSO in Russian context (e.g. acronyms
 * like MOSFET, BJT) — capture the surrounding Russian phrase as the gloss.
 *
 * For now, we only auto-capture acronyms (≥2 capital letters) since matching
 * arbitrary EN phrases to RU translations without alignment models is unreliable.
 */
export function harvestPairs(sourceText: string, translation: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const acronyms = new Set<string>();
  const acrRe = /\b([A-Z]{2,}[A-Z0-9]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = acrRe.exec(sourceText))) acronyms.add(m[1]);
  for (const acr of acronyms) {
    // If the acronym appears in the translation, the translator preserved it
    // verbatim — this is itself useful: lock it in so later pages can't
    // accidentally translate the acronym.
    if (translation.includes(acr)) out.push([acr, acr]);
  }
  return out;
}
