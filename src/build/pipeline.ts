import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { DeltaruneData } from "../game-data";
import { projectRoot } from "../platform/paths";
import { createTemplateRenderer } from "../platform/templates";
import { buildArchive, type CatalogStats } from "./chapters";
import { copyRuntimeAssets } from "./output/assets";
import { writeCatalogOutputs, writePayloadShards } from "./output/data";
import { writeRootPages } from "./output/pages";
import { writeRouting } from "./output/routing";
import {
  assertReplaceableOutput,
  type BuildLog,
  type BuildOptions,
  type BuildPlan,
  planBuild,
} from "./plan";
import type { RenderStats } from "./render";
import { resolveShardPrefixLength } from "./shards";
import { fingerprintDirectory } from "./stamps";
import { emptyUsage, openStore } from "./store";

export type { BuildLog, BuildOptions } from "./plan";

interface BuildStats {
  scripts: RenderStats;
  catalog: CatalogStats;
}

interface BuildResult {
  output: string;
  stats: BuildStats;
}

function defaultLog(message: string): void {
  console.log(message);
}

async function publishOutput(
  stagingDirectory: string,
  outputDirectory: string,
  transactionDirectory: string,
  state: { preserveTransaction: boolean },
): Promise<void> {
  await assertReplaceableOutput(outputDirectory);
  const backupDirectory = join(transactionDirectory, "previous");
  let movedPrevious = false;
  try {
    await rename(outputDirectory, backupDirectory);
    movedPrevious = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    await rename(stagingDirectory, outputDirectory);
  } catch (publishError) {
    if (!movedPrevious) throw publishError;
    try {
      await rename(backupDirectory, outputDirectory);
    } catch (restoreError) {
      state.preserveTransaction = true;
      throw new AggregateError(
        [publishError, restoreError],
        `Failed to publish the build or restore the previous output; it remains at ${backupDirectory}`,
        { cause: restoreError },
      );
    }
    throw publishError;
  }
}

export async function buildDeltarune(options: BuildOptions = {}): Promise<BuildResult> {
  const log: BuildLog = options.log ?? defaultLog;
  const projectDirectory = resolve(options.projectDirectory ?? projectRoot);
  log("Preparing build plan...");
  const data = new DeltaruneData(projectDirectory);
  const config = await data.getConfig();
  const renumberOverrides = await data.getRenumberOverrides();
  const shardPrefixLength = resolveShardPrefixLength(config.shardPrefixLength);
  const renderTemplate = createTemplateRenderer(projectDirectory, {
    shard_prefix_length: shardPrefixLength,
  });
  const outputPlan = await planBuild(options, projectDirectory, config);
  log(
    `Build plan ready: ${outputPlan.releases.length} releases, ` +
      `${outputPlan.chapters.length} chapters, ` +
      `cache ${outputPlan.cache.enabled ? "enabled" : "disabled"}.`,
  );
  log(`Output directory: ${outputPlan.outputDirectory}`);
  if (outputPlan.cache.enabled) log(`Cache directory: ${outputPlan.cache.directory}`);
  await mkdir(dirname(outputPlan.outputDirectory), { recursive: true });
  const transactionDirectory = await mkdtemp(
    join(dirname(outputPlan.outputDirectory), `.${basename(outputPlan.outputDirectory)}-build-`),
  );
  const plan: BuildPlan = {
    ...outputPlan,
    outputDirectory: join(transactionDirectory, "next"),
  };
  const viewerDataDirectory = join(plan.outputDirectory, "data", "pages");
  const stats: BuildStats = {
    scripts: { rendered: 0, cached: 0 },
    catalog: { computed: 0, cached: 0 },
  };
  const publicationState = { preserveTransaction: false };

  try {
    const store = await openStore({
      enabled: plan.cache.enabled,
      directory: plan.cache.directory,
      renderStamp: plan.stamps.render,
      catalogStamp: plan.stamps.catalog,
    });
    const usage = emptyUsage();
    const payloads = new Set<string>();
    try {
      await mkdir(viewerDataDirectory, { recursive: true });
      log("Copying runtime assets...");
      const assets = await copyRuntimeAssets(plan.projectDirectory, plan.outputDirectory);
      log(`Runtime assets ready: ${Object.keys(assets).length} fingerprinted assets.`);
      log("Writing root pages...");
      await writeRootPages(plan.config, assets, plan.outputDirectory, renderTemplate);

      log("Building archive...");
      const archive = await buildArchive(plan, {
        data,
        config,
        renumberOverrides,
        renderTemplate,
        store,
        payloads,
        assets,
        stats: stats.scripts,
        usage,
        catalogStats: stats.catalog,
        fingerprint: fingerprintDirectory,
        log,
      });

      log(
        `Archive ready: ${archive.catalog.builds.length} builds, ` +
          `${archive.routingChapters.length} chapters, ${archive.sourcePaths.size} unique sources, ` +
          `${payloads.size} payloads.`,
      );
      log("Writing catalog, payload shards, and routing metadata...");
      await Promise.all([
        writePayloadShards(viewerDataDirectory, payloads, store, usage, shardPrefixLength),
        writeCatalogOutputs(
          archive.catalog,
          archive.sourcePaths,
          plan.outputDirectory,
          store,
          usage,
          shardPrefixLength,
        ),
        writeRouting(
          archive.routingChapters,
          [
            ...new Set(
              archive.catalog.builds.flatMap((build) =>
                build.chapters.map((chapter) => chapter.id),
              ),
            ),
          ],
          config.chapters,
          plan.outputDirectory,
        ),
      ]);

      if (plan.allChapters && plan.prune) {
        log("Pruning stale cache entries...");
        await store.prune(usage);
      }

      await writeFile(
        join(plan.outputDirectory, ".build-stamp"),
        `${plan.stamps.render}:${plan.stamps.catalog}`,
        "utf8",
      );
    } finally {
      await store.dispose();
    }

    log("Publishing build output...");
    await publishOutput(
      plan.outputDirectory,
      outputPlan.outputDirectory,
      transactionDirectory,
      publicationState,
    );
    log("Build output published.");
    return { output: outputPlan.outputDirectory, stats };
  } finally {
    if (!publicationState.preserveTransaction) {
      await rm(transactionDirectory, { recursive: true, force: true });
    }
  }
}
