import { describe, expect, it } from "bun:test";
import {
  authorizationFromMetadata,
  authorizationToMetadata,
  traceIdFromMetadata
} from "./user-context";

describe("gRPC metadata helpers", () => {
  it("round-trips authorization token", () => {
    const metadata = authorizationToMetadata("jwt-token");
    expect(authorizationFromMetadata(metadata)).toBe("jwt-token");
  });

  it("strips Bearer prefix", () => {
    expect(
      authorizationFromMetadata({ authorization: "Bearer jwt-token" })
    ).toBe("jwt-token");
  });

  it("returns undefined when authorization is missing", () => {
    expect(authorizationFromMetadata({})).toBeUndefined();
  });

  it("reads trace id", () => {
    expect(traceIdFromMetadata({ "x-trace-id": "t-1" })).toBe("t-1");
    expect(traceIdFromMetadata({})).toBeUndefined();
  });
});
