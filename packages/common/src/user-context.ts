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
