import { resolve } from "node:path";

import { prepareGml } from "../archive/gml-cache";
import { R2ObjectStore, r2CredentialsFromEnvironment } from "../archive/object-store";
import { loadReleaseSources, selectReleases } from "../archive/releases";
import { loadToolchain } from "../archive/toolchain";
import { projectRoot } from "../platform/paths";

interface Options {
  archiveBucket: string;
  cacheBucket: string;
  source?: string;
  release?: string;
  outputRoot: string;
  jobs: number;
  dryRun: boolean;
}

function parseOptions(args: string[]): Options {
  const options: Options = {
    archiveBucket: "tenna-archive",
    cacheBucket: "tenna-cache",
    outputRoot: resolve(projectRoot, "local", "decompiled"),
    jobs: 2,
    dryRun: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const value = args[++index];
    if (value === undefined) throw new Error(`Missing value for ${option}`);
    if (option === "--archive-bucket") options.archiveBucket = value;
    else if (option === "--cache-bucket") options.cacheBucket = value;
    else if (option === "--source") options.source = value;
    else if (option === "--release") options.release = value;
    else if (option === "--output-root") options.outputRoot = resolve(value);
    else if (option === "--jobs") {
      options.jobs = Number(value);
      if (!Number.isSafeInteger(options.jobs) || options.jobs < 1) {
        throw new Error("--jobs must be a positive integer");
      }
    } else throw new Error(`Unknown option: ${option}`);
  }
  return options;
}

function utmtCli(): string {
  const configured = process.env.TENNA_UTMT_CLI;
  if (configured !== undefined && configured !== "") return resolve(configured);
  const detected = Bun.which("UndertaleModCli");
  if (detected === null) throw new Error("UndertaleModCli was not found; set TENNA_UTMT_CLI");
  return detected;
}

async function main(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const sources = (await loadReleaseSources()).filter(
    (source) => options.source === undefined || source.id === options.source,
  );
  if (sources.length === 0) throw new Error(`Unknown source: ${options.source}`);
  await prepareGml(
    new R2ObjectStore(options.archiveBucket, r2CredentialsFromEnvironment("TENNA_ARCHIVE")),
    new R2ObjectStore(options.cacheBucket, r2CredentialsFromEnvironment("TENNA_CACHE")),
    sources.map((source) => ({ source, releases: selectReleases(source, options.release) })),
    {
      archivePrefix: "tenna-raw",
      cachePrefix: "gml",
      outputRoot: options.outputRoot,
      utmtCli: utmtCli(),
      exportScript: resolve(projectRoot, "scripts", "ExportCodeFormatted.csx"),
      toolchain: await loadToolchain(),
      jobs: options.jobs,
      dryRun: options.dryRun,
    },
  );
}

if (import.meta.main) await main(Bun.argv.slice(2));
