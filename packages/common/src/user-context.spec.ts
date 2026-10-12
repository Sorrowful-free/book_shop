import { describe, expect, it } from "bun:test";
import { UserRole } from "@book-shop/contracts";
import { userContextFromMetadata, userContextToMetadata } from "./user-context";

describe("user context metadata", () => {
  it("round-trips through metadata", () => {
    const ctx = { userId: "42", userName: "vasya", role: UserRole.Customer };
    const metadata = userContextToMetadata(ctx);
    expect(userContextFromMetadata(metadata)).toEqual(ctx);
  });

  it("returns undefined when required keys are missing", () => {
    expect(userContextFromMetadata({})).toBeUndefined();
  });
});
