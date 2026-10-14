import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { Metadata } from "@grpc/grpc-js";
import { BadRequestException } from "@nestjs/common";
import type { catalogProto } from "@book-shop/contracts";
import { UserRole } from "@book-shop/contracts";
import type { CatalogClient } from "../clients";
import type { AuthedRequest } from "../request-context";
import { CoversController } from "./covers.controller";

// ---------------------------------------------------------------------------
// fakes — the controller is a plain class; guards run in Nest, so the spec
// exercises what the controller itself does: request forwarding, response
// shaping, header setting and key validation.
// ---------------------------------------------------------------------------

class FakeCatalogClient implements Pick<
  CatalogClient,
  "createCoverUpload" | "getBookCover"
> {
  uploads: {
    request: catalogProto.CreateCoverUploadRequest;
    metadata: Metadata;
  }[] = [];
  uploadResponse: catalogProto.CreateCoverUploadResponse = {
    uploadUrl: "http://localhost:9000/book-covers",
    fields: { key: "k", policy: "p" },
    coverUrl: "/api/v1/covers/k.png"
  };
  coverResponse: catalogProto.GetBookCoverResponse = {
    data: Buffer.from("cover-bytes"),
    contentType: "image/png"
  };

  async createCoverUpload(
    request: catalogProto.CreateCoverUploadRequest,
    metadata: Metadata
  ) {
    this.uploads.push({ request, metadata });
    return this.uploadResponse;
  }

  async getBookCover(_request: catalogProto.GetBookCoverRequest) {
    return this.coverResponse;
  }
}

function authedRequest(): AuthedRequest {
  return {
    headers: {},
    auth: {
      user: { userId: "u-1", userName: "u-1", role: UserRole.Employer },
      accessToken: "access.jwt"
    }
  } as unknown as AuthedRequest;
}

interface RecordedResponse {
  headers: Record<string, string>;
  body: unknown;
}

function fakeResponse(): RecordedResponse & {
  set(name: string, value: string): RecordedResponse;
  send(body: unknown): RecordedResponse;
} {
  const res: RecordedResponse = {
    headers: {},
    body: undefined
  } as RecordedResponse;
  (res as RecordedResponse & { set: unknown }).set = (
    name: string,
    value: string
  ) => {
    res.headers[name] = value;
    return res;
  };
  (res as RecordedResponse & { send: unknown }).send = (body: unknown) => {
    res.body = body;
    return res;
  };
  return res as RecordedResponse & {
    set(name: string, value: string): RecordedResponse;
    send(body: unknown): RecordedResponse;
  };
}

function harness() {
  const catalog = new FakeCatalogClient();
  const controller = new CoversController(catalog as unknown as CatalogClient);
  return { controller, catalog };
}

describe("CoversController.upload", () => {
  it("proxies the presign with the caller's authorization metadata", async () => {
    const { controller, catalog } = harness();
    const res = await controller.upload(
      { contentType: "image/png" },
      authedRequest()
    );
    expect(res).toEqual({
      uploadUrl: "http://localhost:9000/book-covers",
      fields: { key: "k", policy: "p" },
      coverUrl: "/api/v1/covers/k.png"
    });
    const [call] = catalog.uploads;
    expect(call.request).toEqual({ contentType: "image/png" });
    expect(String(call.metadata.get("authorization")[0])).toBe(
      "Bearer access.jwt"
    );
  });
});

describe("CoversController.get", () => {
  it("streams bytes with the stored mime and an immutable cache header", async () => {
    const { controller } = harness();
    const res = fakeResponse();
    const key = `${randomUUID()}.png`;
    await controller.get(key, res as never);
    expect(res.headers["Content-Type"]).toBe("image/png");
    expect(res.headers["Content-Length"]).toBe("11");
    expect(res.headers["Cache-Control"]).toBe(
      "public, max-age=31536000, immutable"
    );
    expect((res.body as Buffer).toString()).toBe("cover-bytes");
  });

  it.each([
    "../escape.png",
    `${randomUUID()}.gif`,
    "garbage",
    `${randomUUID()}.png/x`
  ])("rejects key %s with 400 before any upstream call", async (key) => {
    const { controller } = harness();
    await expect(
      controller.get(key, fakeResponse() as never)
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
