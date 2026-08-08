/**
 * Regenerate TypeScript types from the JSON Schemas (BUILD_PLAN §4).
 *
 * Run with `pnpm --filter @dolly/schema gen`. This writes `src/generated/types.ts`. The
 * hand-curated `src/types.ts` is the ergonomic public surface (discriminated unions,
 * `version: 1` literal); the generated file is a mechanical mirror used to prove the two
 * stay structurally aligned with the schema. CI runs this and fails on an uncommitted diff.
 */
import { compileFromFile } from "json-schema-to-typescript";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, "..", "schema");
const outDir = join(here, "..", "src", "generated");

const files: Array<[string, string]> = [
  ["cursor.schema.json", "cursor.ts"],
  ["recording.schema.json", "recording.ts"],
];

await mkdir(outDir, { recursive: true });
for (const [schema, out] of files) {
  const ts = await compileFromFile(join(schemaDir, schema), {
    bannerComment: "/* AUTO-GENERATED from schema/" + schema + " — do not edit by hand. */",
    additionalProperties: false,
    style: { singleQuote: false },
  });
  await writeFile(join(outDir, out), ts, "utf8");
  // eslint-disable-next-line no-console
  console.log("wrote src/generated/" + out);
}
