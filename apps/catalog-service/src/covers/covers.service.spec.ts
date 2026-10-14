import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { status } from "@grpc/grpc-js";
import { UserRole } from "@book-shop/contracts";
import { caller, catchGrpcError, expectGrpcError } from "../../test/helpers";
import type { CoverStorage, PresignedPost, StoredCover } from "./cover-storage";
import { COVER_URL_PREFIX, CoversService } from "./covers.service";

// ---------------------------------------------------------------------------
// CoverStorage test double (same idea as the KafkaLike fakes in
// @book-shop/common — a structural double, no module mocks).
// ---------------------------------------------------------------------------

class FakeCoverStorage implements CoverStorage {
  presignCalls: {
    key: string;
    contentType: string;
    maxBytes: number;
    ttlSec: number;
  }[] = [];
  presignResult: PresignedPost = {
    url: "http://localhost:9000/book-covers",
    fields: { key: "", policy: "cG9saWN5", "x-amz-signature": "sig" }
  };
  presignError: unknown;
  objects = new Map<string, StoredCover>();
  getError: unknown;

  async presignedPostPolicy(
    key: string,
    contentType: string,
    maxBytes: number,
    ttlSec: number
  ): Promise<PresignedPost> {
    if (this.presignError) {
      throw this.presignError;
    }
    this.presignCalls.push({ key, contentType, maxBytes, ttlSec });
    return {
      ...this.presignResult,
      fields: { ...this.presignResult.fields, key }
    };
  }

  async getObject(key: string): Promise<StoredCover> {
    if (this.getError) {
      throw this.getError;
    }
    const object = this.objects.get(key);
    if (!object) {
      const error = new Error("NoSuchKey");
      (error as { code?: string }).code = "NoSuchKey";
      throw error;
    }
    return object;
  }
}

function harness(
  options: { maxUploadBytes?: number; uploadTtlSec?: number } = {}
) {
  const storage = new FakeCoverStorage();
  const service = new CoversService({
    storage,
    maxUploadBytes: options.maxUploadBytes ?? 2 * 1024 * 1024,
    uploadTtlSec: options.uploadTtlSec ?? 600
  });
  return { service, storage };
}

const ADMIN = caller(UserRole.Admin);
const EMPLOYER = caller(UserRole.Employer);

describe("CoversService.createCoverUpload", () => {
  it("returns a coherent presign: fields.key is the cover_url's key", async () => {
    const { service } = harness();
    const res = await service.createCoverUpload(
      { contentType: "image/png" },
      ADMIN
    );
    expect(res.uploadUrl).toBe("http://localhost:9000/book-covers");
    expect(res.coverUrl).toMatch(/^\/api\/v1\/covers\/[0-9a-f-]{36}\.png$/);
    const key = res.coverUrl.slice(COVER_URL_PREFIX.length);
    expect(res.fields.key).toBe(key);
  });

  it.each(["image/jpeg", "image/png", "image/webp"])(
    "accepts whitelisted mime %s",
    async (contentType) => {
      const { service } = harness();
      const res = await service.createCoverUpload({ contentType }, EMPLOYER);
      expect(res.coverUrl).toBeTruthy();
    }
  );

  it("maps image/jpeg to a .jpg key", async () => {
    const { service } = harness();
    const res = await service.createCoverUpload(
      { contentType: "image/jpeg" },
      ADMIN
    );
    expect(res.coverUrl).toMatch(/\.jpg$/);
  });

  it.each(["image/gif", "text/plain", "application/octet-stream", ""])(
    "rejects mime %s with INVALID_ARGUMENT",
    async (contentType) => {
      const { service } = harness();
      await expectGrpcError(
        service.createCoverUpload({ contentType }, ADMIN),
        status.INVALID_ARGUMENT
      );
    }
  );

  it("enforces the staff role matrix", async () => {
    const { service } = harness();
    await expectGrpcError(
      service.createCoverUpload({ contentType: "image/png" }, null),
      status.UNAUTHENTICATED
    );
    await expectGrpcError(
      service.createCoverUpload(
        { contentType: "image/png" },
        caller(UserRole.Customer)
      ),
      status.PERMISSION_DENIED
    );
  });

  it("forwards the size limit and TTL into the policy", async () => {
    const { service, storage } = harness({
      maxUploadBytes: 1024,
      uploadTtlSec: 60
    });
    await service.createCoverUpload({ contentType: "image/png" }, ADMIN);
    expect(storage.presignCalls[0]).toMatchObject({
      contentType: "image/png",
      maxBytes: 1024,
      ttlSec: 60
    });
  });

  it("maps a storage failure to UNAVAILABLE", async () => {
    const { service, storage } = harness();
    storage.presignError = new Error("connect ECONNREFUSED");
    await expectGrpcError(
      service.createCoverUpload({ contentType: "image/png" }, ADMIN),
      status.UNAVAILABLE
    );
  });
});

describe("CoversService.getBookCover", () => {
  const key = `${randomUUID()}.png`;

  it("returns object bytes and content-type", async () => {
    const { service, storage } = harness();
    storage.objects.set(key, {
      data: Buffer.from("png-bytes"),
      contentType: "image/png"
    });
    const res = await service.getBookCover({ key });
    expect(res.data).toEqual(Buffer.from("png-bytes"));
    expect(res.contentType).toBe("image/png");
  });

  it.each([
    "../etc/passwd",
    "not-a-key.png",
    `${randomUUID()}.gif`,
    `${randomUUID().toUpperCase()}.png`,
    `${randomUUID()}.png/extra`,
    ""
  ])("rejects malformed key %s with INVALID_ARGUMENT", async (badKey) => {
    const { service } = harness();
    await expectGrpcError(
      service.getBookCover({ key: badKey }),
      status.INVALID_ARGUMENT
    );
  });

  it("maps NoSuchKey to NOT_FOUND", async () => {
    const { service } = harness();
    await expectGrpcError(service.getBookCover({ key }), status.NOT_FOUND);
  });

  it("maps other storage failures to UNAVAILABLE", async () => {
    const { service, storage } = harness();
    storage.getError = new Error("connection reset");
    await expectGrpcError(service.getBookCover({ key }), status.UNAVAILABLE);
  });

  it("maps an HTTP-404-shaped error to NOT_FOUND", async () => {
    const { service, storage } = harness();
    storage.getError = Object.assign(new Error("not found"), {
      statusCode: 404
    });
    const error = await catchGrpcError(service.getBookCover({ key }));
    expect((error as { code?: number }).code).toBe(status.NOT_FOUND);
  });
});
