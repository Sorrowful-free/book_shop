import { describe, expect, it } from "bun:test";
import {
  ArgumentsHost,
  BadRequestException,
  UnauthorizedException
} from "@nestjs/common";
import type { Response } from "express";
import { status } from "@grpc/grpc-js";
import { GatewayExceptionFilter, grpcToHttpStatus } from "./error.filter";

function fakeHost() {
  const captured: { statusCode: number; body: unknown } = {
    statusCode: 0,
    body: undefined
  };
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      captured.body = payload;
      return res;
    }
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => res as Response })
  } as unknown as ArgumentsHost;
  return { host, captured };
}

function grpcError(code: status, message = "boom"): Error {
  // The wire shape: numeric code + message string in `details`.
  return Object.assign(new Error(message), { code, details: message });
}

describe("gRPC → HTTP error mapping (spec §6)", () => {
  const cases: [status, number][] = [
    [status.INVALID_ARGUMENT, 400],
    [status.UNAUTHENTICATED, 401],
    [status.PERMISSION_DENIED, 403],
    [status.NOT_FOUND, 404],
    [status.ALREADY_EXISTS, 409],
    [status.FAILED_PRECONDITION, 422],
    [status.UNAVAILABLE, 503],
    [status.INTERNAL, 500],
    [status.UNIMPLEMENTED, 500]
  ];

  for (const [code, expected] of cases) {
    it(`maps ${status[code]} → ${expected}`, () => {
      expect(grpcToHttpStatus(code)).toBe(expected);
    });
  }

  it("wraps a wire error in the unified { statusCode, message, error } body", () => {
    const { host, captured } = fakeHost();
    new GatewayExceptionFilter().catch(
      grpcError(status.NOT_FOUND, "book x not found"),
      host
    );
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({
      statusCode: 404,
      message: "book x not found",
      error: "Not Found"
    });
  });

  it("keeps HttpException status and normalizes the body shape", () => {
    const { host, captured } = fakeHost();
    new GatewayExceptionFilter().catch(new UnauthorizedException(), host);
    expect(captured.statusCode).toBe(401);
    expect(captured.body).toEqual({
      statusCode: 401,
      message: "Unauthorized",
      error: "Unauthorized"
    });
  });

  it("preserves ValidationPipe-style messages", () => {
    const { host, captured } = fakeHost();
    new GatewayExceptionFilter().catch(
      new BadRequestException(["amount must be an integer"]),
      host
    );
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toMatchObject({
      statusCode: 400,
      message: ["amount must be an integer"],
      error: "Bad Request"
    });
  });

  it("hides internals for non-grpc failures → generic 500", () => {
    const { host, captured } = fakeHost();
    new GatewayExceptionFilter().catch(new Error("secret db detail"), host);
    expect(captured.statusCode).toBe(500);
    expect(captured.body).toEqual({
      statusCode: 500,
      message: "Internal server error",
      error: "Internal Server Error"
    });
  });

  it("treats a grpc error without a code as 500", () => {
    expect(grpcToHttpStatus(undefined)).toBe(500);
  });
});
