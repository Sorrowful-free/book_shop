// Book-cover boundary constants (spec docs/specs/08-book-covers.md §3).
//
// The same key shape and mime whitelist are enforced at three seams —
// catalog-service (boundary DTO + CoversService), api-gateway (boundary
// DTO + route check) and the web file input's `accept` attribute — so the
// definitions live here once. Plain TS only: this file is consumed by
// every workspace, including the browser bundle (no imports at all).

/**
 * Declared mime → object extension. The whitelist is also enforced by the
 * boundary DTOs (@IsIn) and — at the store — by the POST policy itself.
 */
export const COVER_CONTENT_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp"
};

/**
 * Flat `<uuid>.<ext>` object keys — anything else is INVALID_ARGUMENT.
 * `jpeg` stays accepted although uploads only ever mint `jpg`/`png`/`webp`
 * (COVER_CONTENT_TYPES): GetBookCover is a read-only public lookup, so a
 * never-minted alias just answers NOT_FOUND instead of INVALID_ARGUMENT.
 */
export const COVER_KEY_PATTERN = /^[0-9a-f-]{36}\.(jpe?g|png|webp)$/;

/** <input accept> value / client-side whitelist — same mimes as above. */
export const COVER_ACCEPT = Object.keys(COVER_CONTENT_TYPES).join(",");
