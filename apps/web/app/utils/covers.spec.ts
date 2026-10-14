/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import type { CoverUploadClient, CoverUploadInit } from "./covers";
import {
  COVER_ACCEPT,
  COVER_MAX_BYTES,
  uploadCover,
  validateCoverFile
} from "./covers";

function fakeClient(overrides: Partial<CoverUploadClient> = {}) {
  const calls = {
    uploadInits: [] as { contentType: string }[],
    posts: [] as { url: string; body: FormData }[]
  };
  const init: CoverUploadInit = {
    uploadUrl: "http://localhost:9000/book-covers",
    fields: {
      key: "abc.png",
      policy: "cG9saWN5",
      "x-amz-signature": "sig"
    },
    coverUrl: "/api/v1/covers/abc.png"
  };
  const client: CoverUploadClient = {
    requestUpload: async (body) => {
      calls.uploadInits.push(body);
      return init;
    },
    postFile: async (url, body) => {
      calls.posts.push({ url, body });
    },
    ...overrides
  };
  return { client, calls, init };
}

describe("validateCoverFile", () => {
  it.each(COVER_ACCEPT.split(","))("accepts %s", (type) => {
    expect(validateCoverFile({ type, size: 1024 })).toBeNull();
  });

  it("rejects a mime outside the whitelist before any request", () => {
    expect(validateCoverFile({ type: "image/gif", size: 1024 })).toBeTruthy();
    expect(validateCoverFile({ type: "text/plain", size: 1024 })).toBeTruthy();
  });

  it("rejects empty and oversized files", () => {
    expect(validateCoverFile({ type: "image/png", size: 0 })).toBeTruthy();
    expect(
      validateCoverFile({ type: "image/png", size: COVER_MAX_BYTES + 1 })
    ).toBeTruthy();
    expect(
      validateCoverFile({ type: "image/png", size: COVER_MAX_BYTES })
    ).toBeNull();
  });
});

describe("uploadCover", () => {
  const file = new File(["png-bytes"], "cover.png", { type: "image/png" });

  it("presigns through the BFF then posts fields+file to MinIO", async () => {
    const { client, calls, init } = fakeClient();
    const coverUrl = await uploadCover(file, client);

    expect(coverUrl).toBe(init.coverUrl);
    expect(calls.uploadInits).toEqual([{ contentType: "image/png" }]);
    expect(calls.posts).toHaveLength(1);
    const post = calls.posts[0]!;
    expect(post.url).toBe(init.uploadUrl);
    // policy fields precede the file part in the multipart body
    const names = [...post.body.keys()];
    expect(names.slice(0, 3)).toEqual(["key", "policy", "x-amz-signature"]);
    expect(names.at(-1)).toBe("file");
    expect(post.body.get("key")).toBe("abc.png");
  });

  it("propagates a presign failure without touching MinIO", async () => {
    const { client, calls } = fakeClient({
      requestUpload: async () => {
        throw new Error("403 Forbidden");
      }
    });
    await expect(uploadCover(file, client)).rejects.toThrow("403");
    expect(calls.posts).toHaveLength(0);
  });

  it("propagates a MinIO POST rejection", async () => {
    const { client } = fakeClient({
      postFile: async () => {
        throw new Error("cover upload rejected (403)");
      }
    });
    await expect(uploadCover(file, client)).rejects.toThrow("403");
  });
});
