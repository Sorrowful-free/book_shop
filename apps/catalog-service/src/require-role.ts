// Caller guards shared by CatalogService and CoversService — extracted from
// catalog.service.ts so both answer with identical codes/messages
// (UNAUTHENTICATED for a missing caller, PERMISSION_DENIED for a role
// outside the whitelist) instead of drifting copies.

import { status } from "@grpc/grpc-js";
import { type UserContext } from "@book-shop/common";
import { UserRole } from "@book-shop/contracts";
import { rpcError } from "./rpc-error";

/** Any verified JWT context — null (no/invalid token) → UNAUTHENTICATED. */
export function requireCaller(caller: UserContext | null): UserContext {
  if (!caller) {
    throw rpcError(
      status.UNAUTHENTICATED,
      "missing or invalid authentication token"
    );
  }
  return caller;
}

/** requireCaller + a role whitelist — mismatch → PERMISSION_DENIED. */
export function requireRole(
  caller: UserContext | null,
  roles: UserRole[]
): UserContext {
  const user = requireCaller(caller);
  if (!roles.includes(user.role)) {
    throw rpcError(
      status.PERMISSION_DENIED,
      `role ${user.role} is not allowed to perform this operation`
    );
  }
  return user;
}
