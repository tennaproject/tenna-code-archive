import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { projectRoot } from "../platform/paths";

export interface Toolchain {
  utmtCommit: string;
  extractionSchema: number;
  exporterHash: string;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = Bun.file(file).stream();
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

export async function loadToolchain(root = projectRoot): Promise<Toolchain> {
  const file = resolve(root, "data", "toolchain.json");
  const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  if (typeof parsed.utmtCommit !== "string" || !/^[a-f0-9]{40}$/.test(parsed.utmtCommit)) {
    throw new Error(`${file}: utmtCommit must be a full lowercase Git SHA`);
  }
  if (
    typeof parsed.extractionSchema !== "number" ||
    !Number.isSafeInteger(parsed.extractionSchema) ||
    parsed.extractionSchema < 1
  ) {
    throw new Error(`${file}: extractionSchema must be a positive integer`);
  }
  return {
    utmtCommit: parsed.utmtCommit,
    extractionSchema: parsed.extractionSchema,
    exporterHash: await sha256File(resolve(root, "scripts", "ExportCodeFormatted.csx")),
  };
}

export function extractionIdentity(toolchain: Toolchain, rawHash: string): string {
  if (!/^[a-f0-9]{64}$/.test(rawHash)) throw new Error(`Invalid raw SHA-256: ${rawHash}`);
  return `v${toolchain.extractionSchema}/${toolchain.utmtCommit}/${toolchain.exporterHash}/${rawHash}`;
}
