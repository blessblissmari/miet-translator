import { describe, it, expect } from "vitest";
import { harvestPairs, mergeGlossary, glossaryPrompt, harvestSourceTerms, type Glossary } from "../../src/lib/glossary";

describe("harvestPairs", () => {
  it("captures acronyms preserved in translation", () => {
    const source = "The MOSFET transistor operates in saturation. BJT is also used.";
    const translation = "Транзистор MOSFET работает в насыщении. Также используется BJT.";
    const pairs = harvestPairs(source, translation);
    expect(pairs).toContainEqual(["MOSFET", "MOSFET"]);
    expect(pairs).toContainEqual(["BJT", "BJT"]);
  });

  it("does not capture acronyms missing from translation", () => {
    const source = "The FPGA design uses VHDL.";
    const translation = "Проект ПЛИС использует язык описания аппаратуры.";
    const pairs = harvestPairs(source, translation);
    // FPGA not in translation, VHDL not in translation
    expect(pairs.find(p => p[0] === "FPGA")).toBeUndefined();
    expect(pairs.find(p => p[0] === "VHDL")).toBeUndefined();
  });

  it("returns empty array for text without acronyms", () => {
    const pairs = harvestPairs("Hello world", "Привет мир");
    expect(pairs).toEqual([]);
  });
});

describe("mergeGlossary", () => {
  it("adds new pairs, first-seen wins", () => {
    const g: Glossary = new Map();
    mergeGlossary(g, [["MOSFET", "MOSFET"], ["BJT", "БТ"]]);
    expect(g.get("MOSFET")).toBe("MOSFET");
    expect(g.get("BJT")).toBe("БТ");
    // Second merge should NOT overwrite
    mergeGlossary(g, [["BJT", "биполярный транзистор"]]);
    expect(g.get("BJT")).toBe("БТ");
  });
});

describe("glossaryPrompt", () => {
  it("returns empty string for empty glossary", () => {
    expect(glossaryPrompt(new Map())).toBe("");
  });

  it("returns formatted list for non-empty glossary", () => {
    const g: Glossary = new Map([["MOSFET", "MOSFET"], ["DC", "постоянный ток"]]);
    const result = glossaryPrompt(g);
    expect(result).toContain("MOSFET");
    expect(result).toContain("постоянный ток");
    expect(result).toContain("glossary");
  });

  it("respects max limit", () => {
    const g: Glossary = new Map(
      Array.from({ length: 50 }, (_, i) => [`TERM${i}`, `перевод${i}`] as [string, string])
    );
    const result = glossaryPrompt(g, 5);
    // Should only contain 5 items
    const lines = result.split("\n").filter(l => l.trim().startsWith("-"));
    expect(lines).toHaveLength(5);
  });
});

describe("harvestSourceTerms", () => {
  it("finds title-case terms with trailing words (regex captures up to 3 words)", () => {
    const text = "The Frequency Response of the circuit is measured.";
    const counts = harvestSourceTerms(text);
    // The regex captures "The Frequency Response" (starts with T, 3 words)
    const keys = [...counts.keys()];
    const hasFreq = keys.some(k => k.includes("Frequency"));
    expect(hasFreq).toBe(true);
  });

  it("skips terms where first word is < 3 chars after the leading upper letter", () => {
    // "Go" = 2 chars total, doesn't meet [A-Z][A-Za-z0-9-]{2,} (needs 3+ after first char)
    const text = "Go fast. Ab test.";
    const counts = harvestSourceTerms(text);
    expect(counts.has("Go")).toBe(false);
    expect(counts.has("Ab")).toBe(false);
  });

  it("captures multi-word phrases starting with uppercase >=4 chars", () => {
    const text = "Bipolar Junction Transistor is common.";
    const counts = harvestSourceTerms(text);
    const keys = [...counts.keys()];
    expect(keys.some(k => k.includes("Bipolar"))).toBe(true);
  });
});
