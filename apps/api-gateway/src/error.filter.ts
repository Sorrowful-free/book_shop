// Error model (spec §6): every failure leaves the gateway in one shape —
// `{ statusCode, message, error }`. Upstream gRPC errors map by status code;
// Nest's own HttpExceptions (guard 401/403, ValidationPipe 400) keep their
// status; anything unrecognized is a 500 whose internals never leak.

import { STATUS_CODES } from "node:http";
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus
} from "@nestjs/common";
import type { Response } from "express";
import { status as grpcStatus } from "@grpc/grpc-js";
import { grpcErrorCode, grpcErrorMessage } from "./clients";

const GRPC_TO_HTTP: Partial<Record<grpcStatus, number>> = {
  [grpcStatus.INVALID_ARGUMENT]: HttpStatus.BAD_REQUEST,
  [grpcStatus.UNAUTHENTICATED]: HttpStatus.UNAUTHORIZED,
  [grpcStatus.PERMISSION_DENIED]: HttpStatus.FORBIDDEN,
  [grpcStatus.NOT_FOUND]: HttpStatus.NOT_FOUND,
  [grpcStatus.ALREADY_EXISTS]: HttpStatus.CONFLICT,
  [grpcStatus.FAILED_PRECONDITION]: HttpStatus.UNPROCESSABLE_ENTITY,
  [grpcStatus.UNAVAILABLE]: HttpStatus.SERVICE_UNAVAILABLE
};

export function grpcToHttpStatus(code: grpcStatus | undefined): number {
  if (code === undefined) {
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }
  return GRPC_TO_HTTP[code] ?? HttpStatus.INTERNAL_SERVER_ERROR;
}

function reasonPhrase(statusCode: number): string {
  return STATUS_CODES[statusCode] ?? "Error";
}

function httpExceptionBody(
  exception: HttpException,
  statusCode: number
): { statusCode: number; message: unknown; error: string } {
  const response = exception.getResponse();
  if (typeof response === "string") {
    return { statusCode, message: response, error: reasonPhrase(statusCode) };
  }
  const body = response as { message?: unknown; error?: unknown };
  return {
    statusCode,
    message: body.message ?? exception.message,
    error:
      typeof body.error === "string" ? body.error : reasonPhrase(statusCode)
  };
}

@Catch()
export class GatewayExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      res.status(statusCode).json(httpExceptionBody(exception, statusCode));
      return;
    }
    const code = grpcErrorCode(exception);
    if (code !== undefined) {
      const statusCode = grpcToHttpStatus(code);
      res.status(statusCode).json({
        statusCode,
        message: grpcErrorMessage(exception),
        error: reasonPhrase(statusCode)
      });
      return;
    }
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: "Internal server error",
      error: reasonPhrase(HttpStatus.INTERNAL_SERVER_ERROR)
    });
  }
}
