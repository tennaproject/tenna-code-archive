import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadToolchain, sha256File } from "../archive/toolchain";
import { projectRoot } from "../platform/paths";

const output = resolve(Bun.argv[2] ?? resolve(projectRoot, "out", "deltarune"));
const toolchain = await loadToolchain();
const catalog = resolve(projectRoot, "data", "releases.json");
const provenance = {
  schemaVersion: 1,
  repositorySha: process.env.GITHUB_SHA ?? "local",
  utmtSha: toolchain.utmtCommit,
  exporterSha256: toolchain.exporterHash,
  extractionSchema: toolchain.extractionSchema,
  releaseCatalogSha256: await sha256File(catalog),
};
await mkdir(resolve(output, "data"), { recursive: true });
await writeFile(
  resolve(output, "data", "build-provenance.json"),
  `${JSON.stringify(provenance, undefined, 2)}\n`,
);
