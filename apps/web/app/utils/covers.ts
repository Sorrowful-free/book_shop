/**
 * Cover-upload helpers for BookFormModal (spec 08 §6.2). Kept free of Vue/
 * Nuxt imports so `bun test` exercises the flow with injected fakes — no
 * module mocks.
 */

// The `/covers` subpath exports plain constants only — the package root
// would drag proto stubs + grpc deps into the client bundle.
import { COVER_ACCEPT } from "@book-shop/contracts/covers";

export { COVER_ACCEPT };

/** Client-side checks mirror the server POST-policy (2 MiB, jpeg/png/webp). */
export const COVER_MAX_BYTES = 2 * 1024 * 1024;
const COVER_MIME_TYPES = new Set(COVER_ACCEPT.split(","));

export interface CoverUploadInit {
  uploadUrl: string;
  fields: Record<string, string>;
  coverUrl: string;
}

/**
 * Both network hops are injectable: `requestUpload` hits the BFF
 * (`POST /api/covers/upload`), `postFile` goes straight to MinIO. The
 * component uses the defaults ($fetch / fetch); tests substitute spies.
 */
export interface CoverUploadClient {
  requestUpload(body: { contentType: string }): Promise<CoverUploadInit>;
  postFile(url: string, body: FormData): Promise<void>;
}

const defaultClient: CoverUploadClient = {
  requestUpload: (body) =>
    $fetch<CoverUploadInit>("/api/covers/upload", {
      method: "POST",
      body
    }),
  postFile: async (url, body) => {
    const res = await fetch(url, { method: "POST", body });
    if (!res.ok) {
      throw new Error(`cover upload rejected (${res.status})`);
    }
  }
};

/**
 * Client-side validation — returns a message to show in the form, or null
 * when the file can be uploaded. No request is made on a failure.
 */
export function validateCoverFile(file: {
  type: string;
  size: number;
}): string | null {
  if (!COVER_MIME_TYPES.has(file.type)) {
    return "Cover must be a JPEG, PNG or WebP image";
  }
  if (file.size < 1 || file.size > COVER_MAX_BYTES) {
    return "Cover image must be 2 MB or smaller";
  }
  return null;
}

/**
 * Two-hop upload: presign via the gateway → multipart POST straight to
 * MinIO. Resolves with the `coverUrl` to store on the book. Throws (with a
 * displayable message) on any step — the caller leaves form.coverUrl alone.
 */
export async function uploadCover(
  file: File,
  client: CoverUploadClient = defaultClient
): Promise<string> {
  const init = await client.requestUpload({ contentType: file.type });
  const body = new FormData();
  for (const [name, value] of Object.entries(init.fields)) {
    body.append(name, value);
  }
  body.append("file", file, file.name);
  await client.postFile(init.uploadUrl, body);
  return init.coverUrl;
}
