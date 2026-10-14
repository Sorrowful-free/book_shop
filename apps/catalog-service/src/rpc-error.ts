// Shared gRPC error constructor for this service — was local to
// catalog.service.ts, extracted so the covers module answers with the exact
// same envelope (C9 in docs/DEFERRED.md tracks lifting it to @book-shop/common
// once a third place needs it).

import { Metadata, status } from "@grpc/grpc-js";
import { RpcException } from "@nestjs/microservices";
import { ERROR_DETAILS_METADATA_KEY } from "@book-shop/common";

export function rpcError(
  code: status,
  message: string,
  details?: Record<string, unknown>
): RpcException {
  // Expose the grpc status on the exception itself too — some tests (and
  // grpc-js error mapping) read `error.code` directly, others read the
  // RpcException payload via `getError().code`. The top-level grpc-js
  // `details` slot stays the human-readable message string.
  const payload: Record<string, unknown> = { code, message };
  if (details) {
    // Machine-readable extra data (failing book ids, reservationStatus):
    // inside the payload for in-process readers AND duplicated into the
    // `error-details` trailer — the only channel that survives
    // serverErrorToStatus on the wire (F-C4/F-O4 interop).
    payload.details = details;
    const trailers = new Metadata();
    trailers.set(ERROR_DETAILS_METADATA_KEY, JSON.stringify(details));
    payload.metadata = trailers;
  }
  return Object.assign(new RpcException(payload), { code });
}
