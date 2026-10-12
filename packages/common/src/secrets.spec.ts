import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSecret } from "./secrets";

const NAME = "RESOLVE_SECRET_TEST_KEY";
const FILE_NAME = `${NAME}_FILE`;

const tempDirs: string[] = [];
const savedEnv = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) {
    savedEnv.set(name, process.env[name]);
  }
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function tempFile(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "resolve-secret-"));
  tempDirs.push(dir);
  const file = path.join(dir, "secret.pem");
  writeFileSync(file, content, "utf8");
  return file;
}

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  savedEnv.clear();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveSecret", () => {
  it("returns the inline env value when no *_FILE is set", () => {
    setEnv(NAME, "inline-secret");
    setEnv(FILE_NAME, undefined);
    expect(resolveSecret(NAME)).toBe("inline-secret");
  });

  it("reads the secret from *_FILE and strips the trailing newline", () => {
    setEnv(NAME, undefined);
    setEnv(FILE_NAME, tempFile("file-secret\n"));
    expect(resolveSecret(NAME)).toBe("file-secret");
  });

  it("gives *_FILE priority over an inline value when both are set", () => {
    setEnv(NAME, "inline-secret");
    setEnv(FILE_NAME, tempFile("file-secret\n"));
    expect(resolveSecret(NAME)).toBe("file-secret");
  });

  it.each(["", "   "])(
    "treats a %j *_FILE as unset and falls back to inline",
    (fileEnv) => {
      setEnv(NAME, "inline-secret");
      setEnv(FILE_NAME, fileEnv);
      expect(resolveSecret(NAME)).toBe("inline-secret");
    }
  );

  it("throws an Error naming the variable when neither is set", () => {
    setEnv(NAME, undefined);
    setEnv(FILE_NAME, undefined);
    expect(() => resolveSecret(NAME)).toThrow(
      `Missing required environment variable ${NAME}`
    );
  });

  it("throws when the inline value is empty and no *_FILE is set", () => {
    setEnv(NAME, "");
    setEnv(FILE_NAME, undefined);
    expect(() => resolveSecret(NAME)).toThrow(
      `Missing required environment variable ${NAME}`
    );
  });

  it("throws an Error naming the variable and path for an unreadable file", () => {
    const missing = path.join(tmpdir(), "no-such-secret-file.pem");
    setEnv(NAME, "inline-secret");
    setEnv(FILE_NAME, missing);
    let thrown: unknown;
    try {
      resolveSecret(NAME);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain(NAME);
    expect(message).toContain(missing);
  });
});
