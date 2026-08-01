import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  depotRoot,
  loadReleaseSource,
  provenanceManifestId,
  selectReleases,
  type Release,
  type ReleaseSource,
} from "../archive/releases";
import { projectRoot } from "../platform/paths";
import { run } from "../platform/spawn";

interface Options {
  dryRun: boolean;
  release?: string;
  qr: boolean;
  root?: string;
  source: string;
}

function parseOptions(arguments_: string[]): Options {
  const options: Options = { dryRun: false, qr: false, source: "deltarune" };
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (option === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (option === "--qr") {
      options.qr = true;
      continue;
    }
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${option}`);
    index += 1;
    if (option === "--release" || option === "--manifest") {
      options.release = value;
    } else if (option === "--source") {
      options.source = value;
    } else if (option === "--root") {
      options.root = isAbsolute(value) ? resolve(value) : resolve(projectRoot, value);
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }
  return options;
}

function downloaderPath(): string {
  const configured = process.env.TENNA_DEPOT_DOWNLOADER;
  if (configured !== undefined && configured !== "") return resolve(configured);
  const detected = Bun.which("DepotDownloader") ?? Bun.which("depotdownloader");
  if (detected === null) {
    throw new Error(
      "DepotDownloader was not found. On macOS, install it with: brew tap steamre/tools && brew install depotdownloader",
    );
  }
  return detected;
}

type SteamDownloadReference =
  { branchHead: true; manifest?: string } | { branchHead: false; manifest: string };

function hasSteamDownloadReference(
  release: Pick<Release, "branchHead" | "manifest">,
): release is Pick<Release, "branchHead" | "manifest"> & SteamDownloadReference {
  return release.branchHead || release.manifest !== undefined;
}

function downloadCompletionMarker(
  source: Pick<ReleaseSource, "id" | "appId" | "depotId">,
  release: Release,
  completedAt: string,
) {
  const manifestId = provenanceManifestId(release);
  return {
    source: source.id,
    release: release.id,
    date: release.date,
    label: release.label,
    appId: source.appId,
    depotId: source.depotId,
    ...(manifestId === undefined ? {} : { manifestId }),
    branch: release.branch,
    completedAt,
  };
}

async function main(arguments_: string[]): Promise<void> {
  const options = parseOptions(arguments_);
  const source = await loadReleaseSource(options.source);
  const releases = selectReleases(source, options.release);
  const root = depotRoot(source, options.root);

  const downloader = options.dryRun ? "DepotDownloader" : downloaderPath();
  const username = process.env.STEAM_USERNAME;
  const password = process.env.STEAM_PASSWORD;
  let qrPending = options.qr;
  for (const release of releases) {
    if (source.appId === undefined || !hasSteamDownloadReference(release)) {
      console.log(`Skipping ${release.label}: not on Steam, so its files come from elsewhere`);
      continue;
    }
    const appId = source.appId;

    const destination = resolve(root, release.id);
    const marker = resolve(destination, ".complete.json");
    if (await Bun.file(marker).exists()) {
      console.log(`Already downloaded ${release.label}`);
      continue;
    }

    const downloaderArguments = [
      "-app",
      appId,
      "-branch",
      release.branch,
      "-dir",
      destination,
      "-validate",
    ];
    if (source.depotId !== undefined) {
      downloaderArguments.push("-depot", source.depotId);
    }
    if (!release.branchHead) {
      downloaderArguments.push("-manifest", release.manifest);
    }
    if (qrPending) {
      downloaderArguments.push("-qr");
    } else if (username !== undefined && username !== "") {
      downloaderArguments.push("-username", username);
      if (password !== undefined && password !== "")
        downloaderArguments.push("-password", password);
      else downloaderArguments.push("-remember-password");
    }

    console.log(
      `${options.dryRun ? "Would download" : "Downloading"} ${source.label} ${release.label} to ${destination}`,
    );
    if (options.dryRun) continue;

    await mkdir(destination, { recursive: true });
    await run(downloader, downloaderArguments);
    qrPending = false;
    await writeFile(
      marker,
      `${JSON.stringify(
        downloadCompletionMarker(source, release, new Date().toISOString()),
        undefined,
        2,
      )}\n`,
      "utf8",
    );
  }
}

if (import.meta.main) await main(Bun.argv.slice(2));
