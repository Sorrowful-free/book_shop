// Unit tests for the pure helpers in clients.ts: error-shape readers and
// authorization forwarding. The grpc-js client factories need a live
// server, so they are exercised by test/order.e2e.spec.ts instead.

import { describe, expect, it } from "bun:test";
import { Metadata, status } from "@grpc/grpc-js";
import {
  ERROR_DETAILS_METADATA_KEY,
  forwardedAuthMetadata,
  grpcErrorCode,
  grpcErrorDetails,
  grpcErrorMessage,
  isTransportError
} from "./clients";

function wireError(
  code: status,
  message: string,
  details?: Record<string, unknown>
): Error {
  const error = Object.assign(new Error(message), {
    code,
    details: message
  });
  if (details) {
    const metadata = new Metadata();
    metadata.set(ERROR_DETAILS_METADATA_KEY, JSON.stringify(details));
    Object.assign(error, { metadata });
  }
  return error;
}

describe("forwardedAuthMetadata", () => {
  it("copies the authorization value verbatim and nothing else", () => {
    const source = new Metadata();
    source.add("authorization", "Bearer token-123");
    source.add("x-user-id", "mallory");
    source.add("x-user-role", "ADMIN");

    const forwarded = forwardedAuthMetadata(source);
    expect(forwarded.get("authorization")).toEqual(["Bearer token-123"]);
    expect(forwarded.get("x-user-id")).toHaveLength(0);
    expect(forwarded.get("x-user-role")).toHaveLength(0);
  });

  it("returns empty metadata for absent source / missing authorization", () => {
    expect(forwardedAuthMetadata(undefined).getMap()).toEqual({});
    expect(
      forwardedAuthMetadata(new Metadata()).get("authorization")
    ).toHaveLength(0);
  });
});

describe("grpcErrorCode / grpcErrorMessage", () => {
  it("reads a wire-shaped ServiceError", () => {
    const error = wireError(status.NOT_FOUND, "books not found: b-1");
    expect(grpcErrorCode(error)).toBe(status.NOT_FOUND);
    expect(grpcErrorMessage(error)).toBe("books not found: b-1");
  });

  it("reads an RpcException payload shape (getError)", () => {
    const error = Object.assign(new Error("nope"), {
      code: status.FAILED_PRECONDITION,
      getError: () => ({
        code: status.FAILED_PRECONDITION,
        message: "payload message",
        details: { foo: 1 }
      })
    });
    expect(grpcErrorCode(error)).toBe(status.FAILED_PRECONDITION);
    expect(grpcErrorMessage(error)).toBe("payload message");
    expect(grpcErrorDetails(error)).toEqual({ foo: 1 });
  });
});

describe("grpcErrorDetails", () => {
  it("reads details from trailing metadata (the wire channel)", () => {
    const error = wireError(status.FAILED_PRECONDITION, "cannot be released", {
      reservationStatus: "COMMITTED"
    });
    expect(grpcErrorDetails(error)?.reservationStatus).toBe("COMMITTED");
  });

  it("reads a JSON envelope serialized into the details string", () => {
    const error = Object.assign(new Error("x"), {
      code: status.NOT_FOUND,
      details: JSON.stringify({
        code: status.NOT_FOUND,
        message: "books not found: b-9",
        details: { missingBookIds: ["b-9"] }
      })
    });
    expect(grpcErrorDetails(error)).toEqual({ missingBookIds: ["b-9"] });
  });

  it("returns undefined for a plain message — it is not JSON details", () => {
    const error = wireError(status.NOT_FOUND, "reservation xyz not found");
    expect(grpcErrorDetails(error)).toBeUndefined();
  });
});

describe("isTransportError", () => {
  it("UNAVAILABLE and DEADLINE_EXCEEDED are transport failures", () => {
    expect(
      isTransportError(wireError(status.UNAVAILABLE, "connection refused"))
    ).toBe(true);
    expect(
      isTransportError(wireError(status.DEADLINE_EXCEEDED, "deadline"))
    ).toBe(true);
    expect(isTransportError(new Error("socket hangup"))).toBe(true);
  });

  it("domain answers are not transport failures", () => {
    for (const code of [
      status.NOT_FOUND,
      status.FAILED_PRECONDITION,
      status.INVALID_ARGUMENT,
      status.UNAUTHENTICATED,
      status.PERMISSION_DENIED,
      status.INTERNAL
    ]) {
      expect(isTransportError(wireError(code, "domain"))).toBe(false);
    }
  });
});
