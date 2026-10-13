import { status } from "@grpc/grpc-js";
import { ValidationPipe } from "@nestjs/common";
import { RpcException } from "@nestjs/microservices";
import type { ValidationError } from "class-validator";

// Nested errors (@ValidateNested on items) land in `children` — flatten.
function constraintMessages(errors: ValidationError[]): string[] {
  return errors.flatMap((error) => [
    ...Object.values(error.constraints ?? {}),
    ...(error.children?.length ? constraintMessages(error.children) : [])
  ]);
}

/**
 * Shared boundary-validation pipe for the gRPC surface of every service:
 * class-validator DTOs bound via `@Payload(requestValidationPipe)` are checked
 * (and transformed) before any domain logic runs; a violation maps to
 * RpcException INVALID_ARGUMENT with the constraint messages joined.
 *
 * The top-level `code` mirrors the `rpcError` convention: grpc-js reads
 * `error.code` for the wire status when the exception escapes raw, bypassing
 * the RpcException serializer — without it the client would see UNKNOWN.
 */
export const requestValidationPipe = new ValidationPipe({
  transform: true,
  exceptionFactory: (errors: ValidationError[]) => {
    const message = constraintMessages(errors).join("; ") || "invalid request";
    return Object.assign(
      new RpcException({ code: status.INVALID_ARGUMENT, message }),
      { code: status.INVALID_ARGUMENT }
    );
  }
});
