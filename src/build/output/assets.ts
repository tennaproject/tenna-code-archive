import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";

export type AssetManifest = Record<string, string>;

const ASSET_DIRECTORY = "assets";
const ASSET_URL_PREFIX = `/static/${ASSET_DIRECTORY}`;
const HASH_LENGTH = 12;

const VENDORED_STYLESHEET = ["@highlightjs", "cdn-assets", "styles", "github-dark.min.css"];

const BROWSER_ENTRYPOINTS = [
  "chapter.ts",
  "compare.ts",
  "diff-worker.ts",
  "script-highlighter.ts",
  "script.ts",
  "search.ts",
  "search-worker.ts",
  "source.ts",
  "timeline.ts",
];

function isFingerprinted(path: string): boolean {
  return path.endsWith(".css") || path.endsWith(".js");
}

function fingerprint(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex").slice(0, HASH_LENGTH);
}

async function fingerprintFile(
  source: string,
  assetDirectory: string,
  manifest: AssetManifest,
): Promise<void> {
  const name = basename(source);
  const extension = name.slice(name.lastIndexOf("."));
  const stem = name.slice(0, name.length - extension.length);
  const contents = await readFile(source);
  const filename = `${stem}-${fingerprint(contents)}${extension}`;
  await copyFile(source, join(assetDirectory, filename));
  manifest[name] = `${ASSET_URL_PREFIX}/${filename}`;
}

function collectBundleOutputs(
  outputs: Array<{ path: string; kind: string }>,
  manifest: AssetManifest,
): void {
  // Match longest first so "search-worker" is not claimed by "search".
  const stems = BROWSER_ENTRYPOINTS.map((entry) => entry.replace(/\.ts$/, "")).sort(
    (left, right) => right.length - left.length,
  );
  for (const output of outputs) {
    if (output.kind !== "entry-point") continue;
    const filename = basename(output.path);
    const stem = stems.find((candidate) => filename.startsWith(`${candidate}-`));
    if (stem === undefined) {
      throw new Error(`Unrecognized bundle output: ${filename}`);
    }
    manifest[`${stem}.js`] = `${ASSET_URL_PREFIX}/${filename}`;
  }
}

export async function copyRuntimeAssets(
  root: string,
  outputDirectory: string,
): Promise<AssetManifest> {
  const staticSource = join(root, "static");
  const staticOutput = join(outputDirectory, "static");
  const assetOutput = join(staticOutput, ASSET_DIRECTORY);

  await rm(staticOutput, { recursive: true, force: true });
  await cp(staticSource, staticOutput, {
    recursive: true,
    filter: (source) => basename(source) !== ".DS_Store" && !isFingerprinted(source),
  });
  await mkdir(assetOutput, { recursive: true });

  const manifest: AssetManifest = {};
  const loose = (await readdir(staticSource, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && isFingerprinted(entry.name))
    .map((entry) => entry.name);

  await Promise.all([
    ...loose.map((name) => fingerprintFile(join(staticSource, name), assetOutput, manifest)),
    fingerprintFile(join(root, "node_modules", ...VENDORED_STYLESHEET), assetOutput, manifest),
    copyFile(join(root, "_headers"), join(outputDirectory, "_headers")),
  ]);

  const browserBuild = await Bun.build({
    entrypoints: BROWSER_ENTRYPOINTS.map((name) => join(root, "src", "browser", name)),
    outdir: assetOutput,
    target: "browser",
    format: "esm",
    minify: true,
    naming: "[name]-[hash].[ext]",
  });
  if (!browserBuild.success) {
    throw new AggregateError(browserBuild.logs, "Failed to build browser assets");
  }
  collectBundleOutputs(browserBuild.outputs, manifest);

  return manifest;
}
