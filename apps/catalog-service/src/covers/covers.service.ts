// Cover upload/serving logic (spec docs/specs/08-book-covers.md §4).
//
// CreateCoverUpload is EMPLOYER|ADMIN and purely presigns — it generates the
// object key (<uuid>.<ext>), builds a POST policy (eq key, eq content-type,
// content-length-range 1..maxBytes) and returns the browser upload URL plus
// the future `cover_url` (/api/v1/covers/<key>). Nothing is written to the
// DB: the book is created/updated by a separate CreateBook/UpdateBook call.
//
// GetBookCover is public: it validates the key shape (defense in depth —
// never forward arbitrary keys to the store) and proxies bytes+mime out of
// the private bucket.

import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { status } from "@grpc/grpc-js";
import { type UserContext } from "@book-shop/common";
import {
  COVER_CONTENT_TYPES,
  COVER_KEY_PATTERN,
  UserRole
} from "@book-shop/contracts";
import type {
  CreateCoverUploadRequest,
  CreateCoverUploadResponse,
  GetBookCoverRequest,
  GetBookCoverResponse
} from "@book-shop/contracts/gen/catalog";
import type { CoverStorage } from "./cover-storage";
import { requireRole } from "../require-role";
import { rpcError } from "../rpc-error";

/** cover_url handed back for later use in Book.cover_url. */
export const COVER_URL_PREFIX = "/api/v1/covers/";

export interface CoversServiceDeps {
  storage: CoverStorage;
  /** POST-policy content-length-range upper bound (COVER_UPLOAD_MAX_BYTES). */
  maxUploadBytes: number;
  /** Presigned policy lifetime (COVER_UPLOAD_TTL_SEC). */
  uploadTtlSec: number;
}

/** S3 "object absent" shapes — minio's S3Error.code and plain HTTP 404s. */
function isNotFoundError(error: unknown): boolean {
  const err = error as { code?: unknown; statusCode?: unknown };
  return (
    err?.code === "NoSuchKey" ||
    err?.code === "NotFound" ||
    err?.statusCode === 404
  );
}

@Injectable()
export class CoversService {
  private readonly storage: CoverStorage;
  private readonly maxUploadBytes: number;
  private readonly uploadTtlSec: number;

  constructor(deps: CoversServiceDeps) {
    // Defaults live in app.module's envInt fallbacks + .env.example —
    // the deps are required so there is a single source of truth.
    this.storage = deps.storage;
    this.maxUploadBytes = deps.maxUploadBytes;
    this.uploadTtlSec = deps.uploadTtlSec;
  }

  /**
   * Roles EMPLOYER|ADMIN (same matrix as CreateBook). INVALID_ARGUMENT on a
   * mime outside the whitelist; UNAVAILABLE when the store won't sign.
   */
  async createCoverUpload(
    request: CreateCoverUploadRequest,
    caller: UserContext | null
  ): Promise<CreateCoverUploadResponse> {
    requireRole(caller, [UserRole.Employer, UserRole.Admin]);
    const ext = COVER_CONTENT_TYPES[request.contentType];
    if (!ext) {
      throw rpcError(
        status.INVALID_ARGUMENT,
        `content_type must be one of ${Object.keys(COVER_CONTENT_TYPES).join(", ")}`
      );
    }
    const key = `${randomUUID()}.${ext}`;
    let post;
    try {
      post = await this.storage.presignedPostPolicy(
        key,
        request.contentType,
        this.maxUploadBytes,
        this.uploadTtlSec
      );
    } catch (error) {
      throw rpcError(
        status.UNAVAILABLE,
        `cover storage is unavailable: ${messageOf(error)}`
      );
    }
    return {
      uploadUrl: post.url,
      fields: post.fields,
      coverUrl: `${COVER_URL_PREFIX}${key}`
    };
  }

  /**
   * Public. INVALID_ARGUMENT on a malformed key; NOT_FOUND when the object
   * is absent; UNAVAILABLE when the store is unreachable.
   */
  async getBookCover(
    request: GetBookCoverRequest
  ): Promise<GetBookCoverResponse> {
    if (!COVER_KEY_PATTERN.test(request.key ?? "")) {
      throw rpcError(
        status.INVALID_ARGUMENT,
        `cover key must match ${COVER_KEY_PATTERN.source}`
      );
    }
    try {
      const object = await this.storage.getObject(request.key);
      return { data: object.data, contentType: object.contentType };
    } catch (error) {
      if (isNotFoundError(error)) {
        throw rpcError(status.NOT_FOUND, `cover ${request.key} not found`);
      }
      throw rpcError(
        status.UNAVAILABLE,
        `cover storage is unavailable: ${messageOf(error)}`
      );
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
