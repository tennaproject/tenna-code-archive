import { resolve } from "node:path";

import { R2ObjectStore, r2CredentialsFromEnvironment } from "../archive/object-store";
import { restoreDepots } from "../archive/restore";
import { loadReleaseSources, selectReleases } from "../archive/releases";
import { projectRoot } from "../platform/paths";

interface Options {
  bucket: string;
  prefix: string;
  root: string;
  source?: string;
  release?: string;
  dryRun: boolean;
}

function parseOptions(args: string[]): Options {
  const options: Options = {
    bucket: "",
    prefix: "tenna-raw",
    root: resolve(projectRoot, "local", "depots"),
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
    if (option === "--bucket") options.bucket = value;
    else if (option === "--source") options.source = value;
    else if (option === "--release") options.release = value;
    else if (option === "--root") options.root = resolve(value);
    else if (option === "--prefix") options.prefix = value.replace(/^\/+|\/+$/g, "");
    else throw new Error(`Unknown option: ${option}`);
  }
  if (options.bucket === "") throw new Error("--bucket is required");
  return options;
}

async function main(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const sources = (await loadReleaseSources()).filter(
    (source) => options.source === undefined || source.id === options.source,
  );
  if (sources.length === 0) throw new Error(`Unknown source: ${options.source}`);
  await restoreDepots(
    new R2ObjectStore(options.bucket, r2CredentialsFromEnvironment("TENNA_ARCHIVE")),
    sources.map((source) => ({ source, releases: selectReleases(source, options.release) })),
    options,
  );
}

if (import.meta.main) await main(Bun.argv.slice(2));
