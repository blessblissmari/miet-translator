import { describe, it, expect } from "vitest";
import { parseMarkdownToBlocks, stripCodeFences } from "../../src/lib/planner";

describe("stripCodeFences", () => {
  it("strips ```json...``` fences", () => {
    const input = '```json\n{"title": "test"}\n```';
    expect(stripCodeFences(input)).toBe('{"title": "test"}');
  });

  it("strips ``` fences without language tag", () => {
    const input = "```\nhello\n```";
    expect(stripCodeFences(input)).toBe("hello");
  });

  it("returns unfenced content as-is", () => {
    expect(stripCodeFences("just text")).toBe("just text");
  });

  it("handles multiline content inside fences", () => {
    const input = "```\nline1\nline2\nline3\n```";
    expect(stripCodeFences(input)).toBe("line1\nline2\nline3");
  });
});

describe("parseMarkdownToBlocks", () => {
  it("parses headings", () => {
    const blocks = parseMarkdownToBlocks("# H1\n\n## H2\n\n### H3");
    expect(blocks).toEqual([
      { type: "h1", text: "H1" },
      { type: "h2", text: "H2" },
      { type: "h3", text: "H3" },
    ]);
  });

  it("parses paragraphs", () => {
    const blocks = parseMarkdownToBlocks("First paragraph.\n\nSecond paragraph.");
    expect(blocks).toEqual([
      { type: "para", text: "First paragraph." },
      { type: "para", text: "Second paragraph." },
    ]);
  });

  it("parses unordered lists", () => {
    const blocks = parseMarkdownToBlocks("- item 1\n- item 2\n- item 3");
    expect(blocks).toEqual([
      { type: "list", ordered: false, items: ["item 1", "item 2", "item 3"] },
    ]);
  });

  it("parses ordered lists", () => {
    const blocks = parseMarkdownToBlocks("1. first\n2. second\n3. third");
    expect(blocks).toEqual([
      { type: "list", ordered: true, items: ["first", "second", "third"] },
    ]);
  });

  it("parses display math (single-line)", () => {
    const blocks = parseMarkdownToBlocks("$$x = y + z$$");
    expect(blocks).toEqual([
      { type: "formula", latex: "x = y + z", display: true },
    ]);
  });

  it("parses display math (multi-line)", () => {
    const blocks = parseMarkdownToBlocks("$$\n\\frac{a}{b}\n$$");
    expect(blocks).toEqual([
      { type: "formula", latex: "\\frac{a}{b}", display: true },
    ]);
  });

  it("parses markdown tables", () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("table");
    if (blocks[0].type === "table") {
      expect(blocks[0].rows).toEqual([["A", "B"], ["1", "2"], ["3", "4"]]);
      expect(blocks[0].header).toBe(true);
    }
  });

  it("handles mixed content", () => {
    const md = "# Title\n\nSome text.\n\n$$E = mc^2$$\n\n- a\n- b";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks.map(b => b.type)).toEqual(["h1", "para", "formula", "list"]);
  });

  it("handles empty input", () => {
    expect(parseMarkdownToBlocks("")).toEqual([]);
    expect(parseMarkdownToBlocks("   \n\n  ")).toEqual([]);
  });
});
