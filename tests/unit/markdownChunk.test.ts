import { describe, it, expect } from "vitest";
import { chunkMarkdown, tokenizeMarkdown, chunkBlocks } from "../../src/lib/markdownChunk";

describe("tokenizeMarkdown", () => {
  it("splits headings, paragraphs, and blank lines", () => {
    const md = "# Title\n\nParagraph one.\n\nParagraph two.";
    const blocks = tokenizeMarkdown(md);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].text).toBe("# Title");
    expect(blocks[0].isHeading).toBe(true);
    expect(blocks[1].text).toBe("Paragraph one.");
    expect(blocks[2].text).toBe("Paragraph two.");
  });

  it("keeps display math $$..$$ as a single block", () => {
    const md = "Before\n\n$$\n\\frac{a}{b}\n$$\n\nAfter";
    const blocks = tokenizeMarkdown(md);
    expect(blocks).toHaveLength(3);
    expect(blocks[1].text).toContain("$$");
    expect(blocks[1].text).toContain("\\frac{a}{b}");
  });

  it("keeps single-line $$...$$ as a single block", () => {
    const md = "$$x = y$$";
    const blocks = tokenizeMarkdown(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("$$x = y$$");
  });

  it("keeps markdown tables as a single block", () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |";
    const blocks = tokenizeMarkdown(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text.split("\n")).toHaveLength(4);
  });

  it("keeps fenced code blocks intact", () => {
    const md = "```python\ndef foo():\n  pass\n```";
    const blocks = tokenizeMarkdown(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain("def foo():");
  });

  it("keeps list blocks together", () => {
    const md = "- item 1\n- item 2\n- item 3";
    const blocks = tokenizeMarkdown(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain("- item 3");
  });

  it("keeps ordered list blocks together", () => {
    const md = "1. first\n2. second\n3. third";
    const blocks = tokenizeMarkdown(md);
    expect(blocks).toHaveLength(1);
  });
});

describe("chunkMarkdown", () => {
  it("never splits a math block across chunks", () => {
    const mathBlock = "$$\n\\begin{cases}\na = 1 \\\\\nb = 2\n\\end{cases}\n$$";
    const md = `Paragraph.\n\n${mathBlock}\n\nAnother paragraph.`;
    const chunks = chunkMarkdown(md, 50); // Very small maxChars
    // The math block should be in ONE chunk, even though it exceeds 50 chars
    const mathChunk = chunks.find(c => c.includes("\\begin{cases}"));
    expect(mathChunk).toBeDefined();
    // Count $$ occurrences — must be even (paired)
    const dollarCount = (mathChunk!.match(/\$\$/g) || []).length;
    expect(dollarCount % 2).toBe(0);
  });

  it("never splits a table across chunks", () => {
    const table = "| H1 | H2 |\n| --- | --- |\n| A | B |\n| C | D |";
    const md = `Para.\n\n${table}\n\nPara2.`;
    const chunks = chunkMarkdown(md, 40);
    const tableChunk = chunks.find(c => c.includes("| H1 |"));
    expect(tableChunk).toBeDefined();
    expect(tableChunk!).toContain("| C | D |");
  });

  it("respects maxChars for normal paragraphs", () => {
    const paras = Array.from({ length: 10 }, (_, i) => `Paragraph number ${i + 1} with some text.`).join("\n\n");
    const chunks = chunkMarkdown(paras, 200);
    expect(chunks.length).toBeGreaterThan(1);
    // Most chunks should be <= 200 chars (except single blocks that exceed it)
    for (const c of chunks) {
      if (!c.includes("Paragraph number")) continue;
      // Allow some slack for the joining "\n\n"
      expect(c.length).toBeLessThanOrEqual(250);
    }
  });

  it("handles empty input", () => {
    expect(chunkMarkdown("", 100)).toEqual([]);
    expect(chunkMarkdown("   \n\n  ", 100)).toEqual([]);
  });
});

describe("chunkBlocks", () => {
  it("does not orphan headings at end of chunk", () => {
    const blocks = [
      { text: "A".repeat(300), isHeading: false },
      { text: "# Heading", isHeading: true },
      { text: "B".repeat(100), isHeading: false },
    ];
    const chunks = chunkBlocks(blocks, 350);
    // Heading should NOT be at the end of the first chunk alone
    const firstChunk = chunks[0];
    expect(firstChunk).not.toContain("# Heading");
  });
});
