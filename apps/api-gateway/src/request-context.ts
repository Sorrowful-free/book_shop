// Per-request auth context (spec §3): where the incoming credentials live
// (cookie `access_token` / `Authorization: Bearer`, `refresh_token` cookie or
// body, guest `cart_id` cookie) and what gets forwarded downstream —
// `authorization` (raw JWT — services re-verify; `x-user-*` is NEVER
// propagated) plus `x-trace-id` for observability.

import { randomUUID } from "node:crypto";
import { Metadata } from "@grpc/grpc-js";
import { GRPC_METADATA_KEYS, type UserContext } from "@book-shop/common";
import type { Request } from "express";
import type { JwtVerifier } from "@book-shop/common";
import { COOKIE_NAMES } from "./cookies";

/** What a successful local JWT verification attaches to the request. */
export interface RequestAuth {
  user: UserContext;
  /** The raw JWT — forwarded verbatim as `authorization` metadata. */
  accessToken: string;
}

/** Express request after AuthGuard (or optional resolution) ran. */
export type AuthedRequest = Request & { auth?: RequestAuth };

/**
 * Bearer header wins over the cookie — an explicit credential beats ambient
 * state when both are present.
 */
export function extractAccessToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (
    typeof header === "string" &&
    header.toLowerCase().startsWith("bearer ")
  ) {
    const token = header.slice(7).trim();
    if (token !== "") {
      return token;
    }
  }
  const cookie = (req.cookies as Record<string, unknown> | undefined)?.[
    COOKIE_NAMES.accessToken
  ];
  return typeof cookie === "string" && cookie !== "" ? cookie : undefined;
}

/** refresh_token cookie OR request body field (spec §2). */
export function extractRefreshToken(
  req: Request,
  body?: { refreshToken?: string }
): string | undefined {
  if (typeof body?.refreshToken === "string" && body.refreshToken !== "") {
    return body.refreshToken;
  }
  const cookie = (req.cookies as Record<string, unknown> | undefined)?.[
    COOKIE_NAMES.refreshToken
  ];
  return typeof cookie === "string" && cookie !== "" ? cookie : undefined;
}

/** Guest cart handle from the cart_id cookie (absent → undefined). */
export function extractCartId(req: Request): string | undefined {
  const cookie = (req.cookies as Record<string, unknown> | undefined)?.[
    COOKIE_NAMES.cartId
  ];
  return typeof cookie === "string" && cookie !== "" ? cookie : undefined;
}

/**
 * Verify the request's JWT locally (signature + denylist via JwtVerifier).
 * Returns the attached RequestAuth or null — callers decide whether null
 * means 401 (guarded routes) or guest mode (cart).
 */
export async function authenticate(
  verifier: JwtVerifier,
  req: Request
): Promise<RequestAuth | null> {
  const accessToken = extractAccessToken(req);
  if (accessToken === undefined) {
    return null;
  }
  const user = await verifier.verify(accessToken);
  return user ? { user, accessToken } : null;
}

/**
 * Fresh outbound metadata for upstream calls: `authorization` (raw JWT,
 * `x-user-*` is never sent — spec §3) and `x-trace-id` (incoming header or a
 * generated uuid per request).
 */
export function outgoingMetadata(req: Request, accessToken?: string): Metadata {
  const metadata = new Metadata();
  if (accessToken !== undefined) {
    metadata.add(GRPC_METADATA_KEYS.authorization, `Bearer ${accessToken}`);
  }
  const incoming = req.headers[GRPC_METADATA_KEYS.traceId];
  const traceId =
    typeof incoming === "string" && incoming !== ""
      ? incoming
      : Array.isArray(incoming) && incoming[0]
        ? incoming[0]
        : randomUUID();
  metadata.add(GRPC_METADATA_KEYS.traceId, traceId);
  return metadata;
}

// ---------------------------------------------------------------------------
// cart owner resolution (spec §2): a verified JWT selects user-cart mode and
// the cart_id cookie is IGNORED; otherwise the request is a guest and the
// cookie is the cart handle.
// ---------------------------------------------------------------------------

export type CartOwner =
  | { kind: "user"; auth: RequestAuth; metadata: Metadata }
  | { kind: "guest"; cartId: string | undefined; metadata: Metadata };

export async function resolveCartOwner(
  verifier: JwtVerifier,
  req: Request
): Promise<CartOwner> {
  const auth = await authenticate(verifier, req);
  if (auth) {
    return {
      kind: "user",
      auth,
      metadata: outgoingMetadata(req, auth.accessToken)
    };
  }
  return {
    kind: "guest",
    cartId: extractCartId(req),
    metadata: outgoingMetadata(req)
  };
}
