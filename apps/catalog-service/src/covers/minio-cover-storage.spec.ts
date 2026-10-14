import { describe, expect, it } from "bun:test";
import type { PostPolicy } from "minio";
import type { MinioClientLike } from "./minio-cover-storage";
import { MinioCoverStorage, parseS3Endpoint } from "./minio-cover-storage";

class FakeMinioClient implements MinioClientLike {
  policies: PostPolicy[] = [];
  stats = new Map<string, { metaData: Record<string, unknown> }>();
  streams = new Map<string, Uint8Array[]>();

  async presignedPostPolicy(policy: PostPolicy) {
    this.policies.push(policy);
    return {
      postURL: "http://localhost:9000/book-covers",
      formData: { key: "k", policy: "cG9saWN5", "x-amz-signature": "sig" }
    };
  }

  async statObject(bucket: string, key: string) {
    const stat = this.stats.get(`${bucket}/${key}`);
    if (!stat) {
      const error = new Error("NoSuchKey");
      (error as { code?: string }).code = "NoSuchKey";
      throw error;
    }
    return stat;
  }

  async getObject(bucket: string, key: string) {
    const chunks = this.streams.get(`${bucket}/${key}`) ?? [];
    async function* source(): AsyncIterable<Uint8Array> {
      for (const chunk of chunks) {
        yield chunk;
      }
    }
    return source();
  }
}

const OPTIONS = {
  endpoint: "http://minio:9000",
  publicEndpoint: "http://localhost:9000",
  bucket: "book-covers",
  region: "us-east-1",
  accessKey: "minioadmin",
  secretKey: "minioadmin"
};

describe("parseS3Endpoint", () => {
  it("splits scheme/host/port for the minio client", () => {
    expect(parseS3Endpoint("http://minio:9000")).toEqual({
      endPoint: "minio",
      port: 9000,
      useSSL: false
    });
    expect(parseS3Endpoint("https://s3.example.com:9443")).toEqual({
      endPoint: "s3.example.com",
      port: 9443,
      useSSL: true
    });
  });

  it("leaves the default port unset", () => {
    expect(parseS3Endpoint("http://localhost")).toEqual({
      endPoint: "localhost",
      useSSL: false
    });
    expect(parseS3Endpoint("https://s3.amazonaws.com")).toEqual({
      endPoint: "s3.amazonaws.com",
      useSSL: true
    });
  });

  it("rejects a malformed endpoint", () => {
    expect(() => parseS3Endpoint("not a url")).toThrow();
  });
});

describe("MinioCoverStorage", () => {
  it("constrains the POST policy: eq key, eq Content-Type, length range", async () => {
    const signing = new FakeMinioClient();
    const storage = new MinioCoverStorage(OPTIONS, { signing });
    const post = await storage.presignedPostPolicy(
      "abc.png",
      "image/png",
      2_000_000,
      600
    );
    expect(post.url).toBe("http://localhost:9000/book-covers");
    expect(post.fields).toMatchObject({ key: "k", policy: "cG9saWN5" });

    const [policy] = signing.policies;
    expect(policy.policy.conditions).toContainEqual(["eq", "$key", "abc.png"]);
    expect(policy.policy.conditions).toContainEqual([
      "eq",
      "$Content-Type",
      "image/png"
    ]);
    expect(policy.policy.conditions).toContainEqual([
      "eq",
      "$bucket",
      "book-covers"
    ]);
    expect(policy.policy.conditions).toContainEqual([
      "content-length-range",
      1,
      2_000_000
    ]);
    // expiry ≈ now + ttlSec
    const expires = new Date(policy.policy.expiration!).getTime();
    expect(expires).toBeGreaterThan(Date.now());
    expect(expires).toBeLessThanOrEqual(Date.now() + 600_000);
  });

  it("getObject returns concatenated bytes with the stored mime", async () => {
    const ops = new FakeMinioClient();
    ops.stats.set("book-covers/k.png", {
      metaData: { "content-type": "image/png" }
    });
    ops.streams.set("book-covers/k.png", [
      Buffer.from("aa"),
      Buffer.from("bb")
    ]);
    const storage = new MinioCoverStorage(OPTIONS, { ops });
    const object = await storage.getObject("k.png");
    expect(object.data.toString()).toBe("aabb");
    expect(object.contentType).toBe("image/png");
  });

  it("getObject falls back to octet-stream without stored mime", async () => {
    const ops = new FakeMinioClient();
    ops.stats.set("book-covers/k.png", { metaData: {} });
    ops.streams.set("book-covers/k.png", [Buffer.from("x")]);
    const storage = new MinioCoverStorage(OPTIONS, { ops });
    const object = await storage.getObject("k.png");
    expect(object.contentType).toBe("application/octet-stream");
  });

  it("getObject surfaces NoSuchKey from statObject", async () => {
    const ops = new FakeMinioClient();
    const storage = new MinioCoverStorage(OPTIONS, { ops });
    await expect(storage.getObject("missing.png")).rejects.toMatchObject({
      code: "NoSuchKey"
    });
  });
});
