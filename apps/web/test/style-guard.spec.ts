/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * spec 09 §6 — templates consume semantic tokens only; raw palette
 * utilities (`gray-200`, `indigo-600`, …) must not creep back into `app/`
 * sources. Filesystem lint, not a runtime test — conscious exceptions
 * are allowlisted by file below.
 */
const PALETTE_LITERAL =
  /\b(?:slate|gray|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|stone|neutral|zinc)-\d/;

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// spec-sanctioned palette literals — extend only deliberately.
const ALLOWLIST = new Set([
  "app/assets/css/main.css", // token aliases + .badge-neutral
  "app/components/BookCover.vue" // spec §4.1 placeholder gradient
]);

function* appSources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* appSources(path);
    } else if (
      /\.(vue|ts)$/.test(entry.name) &&
      !entry.name.endsWith(".spec.ts")
    ) {
      yield path;
    }
  }
}

describe("style guard", () => {
  it("finds no raw palette utilities in app/ sources (spec 09 §6)", () => {
    const offenders: string[] = [];
    for (const file of appSources(join(WEB_ROOT, "app"))) {
      if (ALLOWLIST.has(relative(WEB_ROOT, file))) {
        continue;
      }
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (PALETTE_LITERAL.test(line)) {
            offenders.push(`${relative(WEB_ROOT, file)}:${index + 1}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
