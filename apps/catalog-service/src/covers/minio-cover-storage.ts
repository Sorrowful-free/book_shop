// MinioCoverStorage — CoverStorage adapter over the `minio` npm client
// (pure JS — no Bun/Node-specific APIs, spec 08 §4/§12).
//
// Two client instances are REQUIRED (spec §4): `presignedPostPolicy` signs
// over the endpoint host — a signature computed for the internal
// `S3_ENDPOINT` (http://minio:9000) is worthless to a browser, so the
// signing client is built from `S3_PUBLIC_ENDPOINT`. `getObject`/`statObject`
// run on the ops client (internal endpoint).
//
// The client never connects eagerly — the service boots while MinIO is down
// and errors surface per-call as UNAVAILABLE (same laziness as
// KafkaEventPublisher). Constructor accepts an injectable client factory so
// unit tests substitute fakes without module mocks (KafkaLike pattern).

import { Client, PostPolicy } from "minio";
import type { CoverStorage, PresignedPost, StoredCover } from "./cover-storage";

/** Minimal surface of the minio Client this adapter uses (fakeable). */
export interface MinioClientLike {
  presignedPostPolicy(policy: PostPolicy): Promise<{
    postURL: string;
    formData: Record<string, unknown>;
  }>;
  statObject(
    bucket: string,
    key: string
  ): Promise<{ metaData: Record<string, unknown> }>;
  getObject(bucket: string, key: string): Promise<AsyncIterable<Uint8Array>>;
}

export interface MinioCoverStorageOptions {
  /** Internal endpoint for ops calls — e.g. `http://minio:9000`. */
  endpoint: string;
  /** Browser-reachable endpoint for signing — e.g. `http://localhost:9000`. */
  publicEndpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
}

interface ClientInit {
  endPoint: string;
  port?: number;
  useSSL: boolean;
}

/** `http://host:9000` → `{endPoint, port, useSSL}` for the minio Client. */
export function parseS3Endpoint(endpoint: string): ClientInit {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`invalid S3 endpoint URL: "${endpoint}"`);
  }
  const useSSL = url.protocol === "https:";
  const init: ClientInit = { endPoint: url.hostname, useSSL };
  if (url.port !== "") {
    init.port = Number(url.port);
  }
  return init;
}

export class MinioCoverStorage implements CoverStorage {
  private readonly bucket: string;
  private readonly opsClient: MinioClientLike;
  private readonly signingClient: MinioClientLike;

  constructor(
    options: MinioCoverStorageOptions,
    clients?: { ops?: MinioClientLike; signing?: MinioClientLike }
  ) {
    this.bucket = options.bucket;
    const base = {
      region: options.region,
      accessKey: options.accessKey,
      secretKey: options.secretKey
    };
    this.opsClient =
      clients?.ops ??
      new Client({ ...base, ...parseS3Endpoint(options.endpoint) });
    this.signingClient =
      clients?.signing ??
      new Client({ ...base, ...parseS3Endpoint(options.publicEndpoint) });
  }

  async presignedPostPolicy(
    key: string,
    contentType: string,
    maxBytes: number,
    ttlSec: number
  ): Promise<PresignedPost> {
    const policy = new PostPolicy();
    policy.setExpires(new Date(Date.now() + ttlSec * 1000));
    policy.setBucket(this.bucket);
    policy.setKey(key);
    policy.setContentType(contentType);
    policy.setContentLengthRange(1, maxBytes);
    const result = await this.signingClient.presignedPostPolicy(policy);
    const fields: Record<string, string> = {};
    for (const [name, value] of Object.entries(result.formData)) {
      fields[name] = String(value);
    }
    return { url: result.postURL, fields };
  }

  /** statObject first — answers NoSuchKey before any bytes are streamed. */
  async getObject(key: string): Promise<StoredCover> {
    const stat = await this.opsClient.statObject(this.bucket, key);
    const chunks: Buffer[] = [];
    for await (const chunk of await this.opsClient.getObject(
      this.bucket,
      key
    )) {
      chunks.push(Buffer.from(chunk));
    }
    const meta = stat.metaData as Record<string, unknown>;
    const contentType = meta["content-type"];
    return {
      data: Buffer.concat(chunks),
      contentType:
        typeof contentType === "string" && contentType !== ""
          ? contentType
          : "application/octet-stream"
    };
  }
}
