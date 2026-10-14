// CoverStorage — object-store port for book covers (spec 08 §4). Same
// pattern as KafkaLike in @book-shop/common: a minimal structural interface
// the domain service depends on, so unit tests inject a fake without module
// mocks. The production adapter is MinioCoverStorage (minio npm client —
// pure JS, portable Node/Bun).
//
// Error contract: adapters surface the underlying S3 error unchanged;
// CoversService maps `NoSuchKey`/HTTP-404-shaped errors to NOT_FOUND and
// everything else (connectivity, auth, policy) to UNAVAILABLE.

/** Result of presignedPostPolicy — url + multipart form fields for the browser. */
export interface PresignedPost {
  /** Browser-reachable endpoint (signed with the PUBLIC endpoint host). */
  url: string;
  /** POST-policy fields — sent as multipart/form-data parts before `file`. */
  fields: Record<string, string>;
}

/** A fetched cover object — raw bytes plus the stored content-type. */
export interface StoredCover {
  data: Buffer;
  contentType: string;
}

export interface CoverStorage {
  /**
   * Sign a POST policy for a single object `key`: the implementation must
   * constrain `key`, `contentType` (eq) and size (1..maxBytes) in the policy
   * so the store itself rejects violations. The URL is signed against the
   * public endpoint — hosts differ between signing and serving.
   */
  presignedPostPolicy(
    key: string,
    contentType: string,
    maxBytes: number,
    ttlSec: number
  ): Promise<PresignedPost>;

  /** Fetch the object at `key`. Throws a NoSuchKey-coded error when absent. */
  getObject(key: string): Promise<StoredCover>;
}
