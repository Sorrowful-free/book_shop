import { readFileSync } from "node:fs";

/**
 * Resolve a secret env var with docker-secrets `<NAME>_FILE` support
 * (fixes spec F-A3).
 *
 * - When `<NAME>_FILE` is set to a non-empty (non-whitespace) path, the
 *   file is read as utf8 and its content — trailing whitespace/newline
 *   stripped — is returned. The FILE variant WINS over an inline `<NAME>`
 *   value when both are set.
 * - Otherwise the inline `process.env[<NAME>]` value is returned.
 * - Neither set (or inline empty) → throws an Error naming the variable,
 *   same contract as the app modules' `env()` helpers.
 * - An unreadable/missing file → throws an Error naming the env var and
 *   the path; the message NEVER includes file contents.
 */
export function resolveSecret(name: string): string {
  const filePath = process.env[`${name}_FILE`];
  if (filePath !== undefined && filePath.trim() !== "") {
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cannot read secret file for ${name} at "${filePath}": ${reason}`
      );
    }
    const secret = content.trimEnd();
    if (secret === "") {
      throw new Error(`Secret file for ${name} at "${filePath}" is empty`);
    }
    return secret;
  }
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}
