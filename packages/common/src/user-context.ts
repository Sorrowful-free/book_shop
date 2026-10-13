import { UserRole } from "@book-shop/contracts";

export interface UserContext {
  userId: string;
  userName: string;
  role: UserRole;
  jti?: string;
}

export const GRPC_METADATA_KEYS = {
  authorization: "authorization",
  traceId: "x-trace-id"
} as const;

/**
 * Trailing-metadata key carrying `JSON.stringify(details)` for structured
 * gRPC error details. grpc-js only forwards `code`, the `details` message
 * string and trailing metadata — a `details` OBJECT inside an RpcException
 * payload never reaches the wire (serverErrorToStatus reads `error.details`
 * only when it is a string). Emitters duplicate their payload `details`
 * into this trailer; readers parse it back. Wire contract shared by
 * catalog (unavailableBookIds/missingBookIds/reservationStatus) and
 * order-service (F-O4 pass-through).
 */
export const ERROR_DETAILS_METADATA_KEY = "error-details";

export function authorizationToMetadata(token: string): Record<string, string> {
  return { [GRPC_METADATA_KEYS.authorization]: token };
}

export function authorizationFromMetadata(
  metadata: Record<string, string | string[] | undefined>
): string | undefined {
  const value = metadata[GRPC_METADATA_KEYS.authorization];
  if (!value) {
    return undefined;
  }
  const raw = String(Array.isArray(value) ? value[0] : value);
  return raw.startsWith("Bearer ") ? raw.slice(7) : raw;
}

export function traceIdFromMetadata(
  metadata: Record<string, string | string[] | undefined>
): string | undefined {
  const value = metadata[GRPC_METADATA_KEYS.traceId];
  return value ? String(Array.isArray(value) ? value[0] : value) : undefined;
}
