import { describe, it, expect } from "vitest";
import { errorResult } from "../src/utils/errors.js";

describe("errorResult", () => {
  it("returns content with isError flag", () => {
    const result = errorResult("something went wrong");
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("something went wrong");
  });
});
