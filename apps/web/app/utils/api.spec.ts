/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { apiErrorMessage } from "./api";

describe("apiErrorMessage", () => {
  it("returns a string message as is", () => {
    expect(
      apiErrorMessage({ data: { message: "book not found" } }, "fallback")
    ).toBe("book not found");
  });

  it("joins a validation message array with ', '", () => {
    expect(
      apiErrorMessage(
        { data: { message: ["price must be positive", "isbn is invalid"] } },
        "fallback"
      )
    ).toBe("price must be positive, isbn is invalid");
  });

  it("falls back when data/message is missing", () => {
    expect(apiErrorMessage({}, "fallback")).toBe("fallback");
    expect(apiErrorMessage({ data: {} }, "fallback")).toBe("fallback");
    expect(apiErrorMessage(new Error("network"), "fallback")).toBe("fallback");
    expect(apiErrorMessage(null, "fallback")).toBe("fallback");
  });
});
