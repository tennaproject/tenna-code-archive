import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { inputsForDepot } from "../archive/depot-inputs";
import { projectRoot } from "../platform/paths";
import { decompiledRoot, depotRoot, loadReleaseSource, selectReleases } from "../archive/releases";
import { run } from "../platform/spawn";
import { loadToolchain, sha256File, type Toolchain } from "../archive/toolchain";

interface Options {
  release?: string;
  depotParent?: string;
  outputParent?: string;
  source: string;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

// The depot and output roots are configured separately, so they might sit on different volumes (they probably won't)
export async function moveExtractedDirectory(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
    return;
  } catch (error) {
    if (errorCode(error) !== "EXDEV") throw error;
  }
  await cp(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });
  await rm(source, { recursive: true, force: true });
}

// Staging always exists next to the destination, so this rename stays on one filesystem
export async function publishExtractedDirectory(
  source: string,
  destination: string,
): Promise<void> {
  const backup = join(dirname(destination), `.${basename(destination)}-previous-${randomUUID()}`);
  let movedPrevious = false;
  try {
    await rename(destination, backup);
    movedPrevious = true;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  try {
    await rename(source, destination);
  } catch (error) {
    if (movedPrevious) await rename(backup, destination);
    throw error;
  }

  if (movedPrevious) await rm(backup, { recursive: true, force: true });
}

function localPath(value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(projectRoot, value);
}

function parseOptions(arguments_: string[]): Options {
  const options: Options = { source: "deltarune" };
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (option === undefined || value === undefined) {
      throw new Error(`Missing value for ${String(option)}`);
    }
    if (option === "--release" || option === "--manifest") {
      options.release = value;
    } else if (option === "--source") {
      options.source = value;
    } else if (option === "--depot-root") {
      options.depotParent = localPath(value);
    } else if (option === "--output-root") {
      options.outputParent = localPath(value);
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }
  return options;
}

function cliPath(): string {
  const configured = process.env.TENNA_UTMT_CLI;
  if (configured !== undefined && configured !== "") return resolve(configured);
  const detected = Bun.which("UndertaleModCli");
  if (detected !== null) return detected;
  throw new Error("UndertaleModCli was not found; set TENNA_UTMT_CLI to its executable");
}

interface ExtractionInputMarker {
  chapter: string;
  bytes: number;
  sha256: string;
}

interface ExtractionMarker {
  schemaVersion: 1;
  source: string;
  release: string;
  toolchain: Toolchain;
  inputs: ExtractionInputMarker[];
  layout: string[];
}

async function extractionMarker(
  source: string,
  release: string,
  inputs: { chapter: string; dataFile: string }[],
  toolchain: Toolchain,
): Promise<ExtractionMarker> {
  return {
    schemaVersion: 1,
    source,
    release,
    toolchain,
    inputs: await Promise.all(
      inputs.map(async ({ chapter, dataFile }) => ({
        chapter,
        bytes: (await stat(dataFile)).size,
        sha256: await sha256File(dataFile),
      })),
    ),
    layout: inputs.map(({ chapter }) => chapter),
  };
}

async function markerMatches(file: string, expected: ExtractionMarker): Promise<boolean> {
  try {
    return JSON.stringify(JSON.parse(await readFile(file, "utf8"))) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

async function main(arguments_: string[]): Promise<void> {
  const options = parseOptions(arguments_);
  const source = await loadReleaseSource(options.source);
  const releases = selectReleases(source, options.release);
  const depots = depotRoot(source, options.depotParent);
  const outputRoot = decompiledRoot(source, options.outputParent);

  const cli = cliPath();
  const exportScript = resolve(projectRoot, "scripts", "ExportCodeFormatted.csx");
  const toolchain = await loadToolchain();
  await mkdir(outputRoot, { recursive: true });

  for (const release of releases) {
    const depot = resolve(depots, release.id);
    const downloadMarker = resolve(depot, ".complete.json");
    if (!(await Bun.file(downloadMarker).exists())) {
      throw new Error(`${source.id} ${release.id} has not finished downloading`);
    }
    const destination = resolve(outputRoot, release.id);
    const marker = resolve(destination, ".complete.json");
    const inputs = await inputsForDepot(depot, release.singleChapter ?? source.singleChapter);
    const expectedMarker = await extractionMarker(source.id, release.id, inputs, toolchain);
    if (await markerMatches(marker, expectedMarker)) {
      console.log(`Already extracted ${release.label}`);
      continue;
    }

    const staging = await mkdtemp(join(outputRoot, `.${release.id}-`));
    try {
      for (const { chapter, dataFile } of inputs) {
        const generated = resolve(dataFile, "..", "Export_Code");
        await rm(generated, { recursive: true, force: true });
        console.log(`Extracting ${release.label} / ${chapter}`);
        await run(cli, ["load", dataFile, "--scripts", exportScript]);
        await moveExtractedDirectory(generated, resolve(staging, chapter));
      }

      await writeFile(
        resolve(staging, ".complete.json"),
        `${JSON.stringify(expectedMarker, undefined, 2)}\n`,
        "utf8",
      );
      await publishExtractedDirectory(staging, destination);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) await main(Bun.argv.slice(2));
