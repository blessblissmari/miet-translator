import { describe, it, expect } from "vitest";
import { dataUrlMime } from "../../src/lib/imageOps";

describe("dataUrlMime", () => {
  it("extracts image/png", () => {
    expect(dataUrlMime("data:image/png;base64,abc")).toBe("image/png");
  });

  it("extracts image/jpeg", () => {
    expect(dataUrlMime("data:image/jpeg;base64,abc")).toBe("image/jpeg");
  });

  it("extracts image/gif", () => {
    expect(dataUrlMime("data:image/gif;base64,abc")).toBe("image/gif");
  });

  it("returns application/octet-stream for malformed", () => {
    expect(dataUrlMime("not-a-data-url")).toBe("application/octet-stream");
  });

  it("handles data URLs without base64 marker", () => {
    expect(dataUrlMime("data:image/webp,rawdata")).toBe("image/webp");
  });
});

// Note: downsampleDataUrl requires browser canvas/Image APIs and cannot be
// unit-tested in Node. It's tested implicitly by E2E tests.
