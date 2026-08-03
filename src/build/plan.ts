import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import {
  loadCatalogReleases,
  loadConfiguredReleases,
  type ResolvedRelease,
} from "../archive/release-inputs";
import type { Config } from "../game-data";
import { assertSafePathSegment } from "../platform/paths";
import { computeCatalogStamp, computeRenderStamp } from "./stamps";

const GAME_ID = "deltarune";

export type BuildLog = (message: string) => void;

export interface BuildOptions {
  chapter?: string;
  catalogFile?: string;
  gmlRoot?: string;
  inputDirectory?: string;
  outputDirectory?: string;
  projectDirectory?: string;
  cache?: boolean;
  cacheDirectory?: string;
  prune?: boolean;
  log?: BuildLog;
}

export interface BuildPlan {
  projectDirectory: string;
  config: Config;
  releases: ResolvedRelease[];
  chapters: Array<[id: string, label: string]>;
  outputDirectory: string;
  allChapters: boolean;
  prune: boolean;
  cache: { enabled: boolean; directory: string };
  stamps: { render: string; catalog: string };
}

function containsPath(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function pathsOverlap(left: string, right: string): boolean {
  return containsPath(left, right) || containsPath(right, left);
}

export async function assertReplaceableOutput(path: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  if (!info.isDirectory()) {
    throw new Error(`Refusing to replace a non-directory build output: ${path}`);
  }
  if ((await readdir(path)).length === 0) return;

  let marker;
  try {
    marker = await lstat(join(path, ".build-stamp"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (marker?.isFile()) return;

  throw new Error(`Refusing to replace nonempty unmarked build output: ${path}`);
}

async function assertSafeOutputDirectory(
  path: string,
  projectDirectory: string,
  releases: ResolvedRelease[],
  cacheDirectory: string | undefined,
): Promise<void> {
  const absolute = resolve(path);
  if (absolute === parse(absolute).root) {
    throw new Error(`Refusing to remove filesystem root: ${absolute}`);
  }
  if (absolute === projectDirectory) {
    throw new Error(`Refusing to use the project directory as build output: ${absolute}`);
  }
  if (containsPath(absolute, projectDirectory)) {
    throw new Error(`Refusing to use a parent of the project as build output: ${absolute}`);
  }
  const sourceStatic = join(projectDirectory, "static");
  const outputStatic = join(absolute, "static");
  if (pathsOverlap(sourceStatic, outputStatic)) {
    throw new Error(`Build output would overlap source assets: ${outputStatic}`);
  }
  if (
    containsPath(projectDirectory, absolute) &&
    !containsPath(join(projectDirectory, "out"), absolute)
  ) {
    throw new Error(
      `Build output inside the project must be under ${join(projectDirectory, "out")}`,
    );
  }
  const overlappingInput = releases.find((release) => pathsOverlap(absolute, release.root));
  if (overlappingInput !== undefined) {
    throw new Error(`Build output overlaps input ${overlappingInput.id}: ${overlappingInput.root}`);
  }
  if (cacheDirectory !== undefined && pathsOverlap(absolute, cacheDirectory)) {
    throw new Error(`Build output overlaps cache directory: ${cacheDirectory}`);
  }
  await assertReplaceableOutput(absolute);
}

function assertSafeCacheDirectory(
  cacheDirectory: string,
  projectDirectory: string,
  releases: ResolvedRelease[],
): void {
  if (cacheDirectory === projectDirectory) {
    throw new Error(`Refusing to use the project directory as build cache: ${cacheDirectory}`);
  }
  if (
    containsPath(projectDirectory, cacheDirectory) &&
    !containsPath(join(projectDirectory, ".cache"), cacheDirectory)
  ) {
    throw new Error(
      `Build cache inside the project must be under ${join(projectDirectory, ".cache")}`,
    );
  }
  if (pathsOverlap(cacheDirectory, join(projectDirectory, "static"))) {
    throw new Error(`Build cache overlaps source assets: ${cacheDirectory}`);
  }
  const overlappingInput = releases.find((release) => pathsOverlap(cacheDirectory, release.root));
  if (overlappingInput !== undefined) {
    throw new Error(`Build cache overlaps input ${overlappingInput.id}: ${overlappingInput.root}`);
  }
}

export async function planBuild(
  options: BuildOptions,
  projectDirectory: string,
  config: Config,
): Promise<BuildPlan> {
  projectDirectory = resolve(projectDirectory);
  const sourceOptions = [options.catalogFile, options.gmlRoot, options.inputDirectory].filter(
    (value) => value !== undefined,
  );
  if (sourceOptions.length > 1) {
    throw new Error("Use only one of catalogFile, gmlRoot, or inputDirectory");
  }
  const gmlRoot =
    sourceOptions.length === 0 ? join(projectDirectory, "local", "decompiled") : options.gmlRoot;
  const releases =
    gmlRoot === undefined
      ? await loadCatalogReleases(
          options.catalogFile,
          resolve(options.inputDirectory ?? projectDirectory),
        )
      : await loadConfiguredReleases(gmlRoot, projectDirectory);
  if (releases.length === 0) {
    throw new Error(
      gmlRoot === undefined
        ? "The build catalog is empty"
        : `No release in data/releases.json has decompiled GML under ${gmlRoot}`,
    );
  }

  const configured = Object.entries(config.chapters);
  for (const [id, label] of configured) {
    assertSafePathSegment(id, "chapter ID");
    if (typeof label !== "string" || label === "") {
      throw new Error(`Chapter ${JSON.stringify(id)} needs a label`);
    }
  }
  const chapters =
    options.chapter === undefined
      ? configured
      : configured.filter(([id]) => id === options.chapter);
  if (chapters.length === 0) {
    throw new Error(`Unknown chapter ${options.chapter ?? "(none)"}`);
  }

  const outputDirectory = resolve(
    options.outputDirectory ?? join(projectDirectory, "out", GAME_ID),
  );
  const cacheDirectory = resolve(
    options.cacheDirectory ?? join(projectDirectory, ".cache", GAME_ID),
  );
  const cacheEnabled = options.cache ?? true;
  if (cacheEnabled) {
    assertSafeCacheDirectory(cacheDirectory, projectDirectory, releases);
  }
  await assertSafeOutputDirectory(
    outputDirectory,
    projectDirectory,
    releases,
    cacheEnabled ? cacheDirectory : undefined,
  );

  const [render, catalog] = await Promise.all([
    computeRenderStamp(projectDirectory),
    computeCatalogStamp(projectDirectory),
  ]);

  return {
    projectDirectory,
    config,
    releases,
    chapters,
    outputDirectory,
    allChapters: options.chapter === undefined,
    prune: options.prune === true,
    cache: {
      enabled: cacheEnabled,
      directory: cacheDirectory,
    },
    stamps: { render, catalog },
  };
}
