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
import { assertReplaceableOutput, type BuildOptions, type BuildPlan, planBuild } from "./plan";
import type { RenderStats } from "./render";
import { resolveShardPrefixLength } from "./shards";
import { fingerprintDirectory } from "./stamps";
import { emptyUsage, openStore } from "./store";

export type { BuildOptions } from "./plan";

interface BuildStats {
  scripts: RenderStats;
  catalog: CatalogStats;
}

interface BuildResult {
  output: string;
  stats: BuildStats;
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
  const projectDirectory = resolve(options.projectDirectory ?? projectRoot);
  const data = new DeltaruneData(projectDirectory);
  const config = await data.getConfig();
  const renumberOverrides = await data.getRenumberOverrides();
  const shardPrefixLength = resolveShardPrefixLength(config.shardPrefixLength);
  const renderTemplate = createTemplateRenderer(projectDirectory, {
    shard_prefix_length: shardPrefixLength,
  });
  const outputPlan = await planBuild(options, projectDirectory, config);
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
      const assets = await copyRuntimeAssets(plan.projectDirectory, plan.outputDirectory);
      await writeRootPages(plan.config, assets, plan.outputDirectory, renderTemplate);

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
      });

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
          plan.outputDirectory,
        ),
      ]);

      if (plan.allChapters && plan.prune) await store.prune(usage);

      await writeFile(
        join(plan.outputDirectory, ".build-stamp"),
        `${plan.stamps.render}:${plan.stamps.catalog}`,
        "utf8",
      );
    } finally {
      await store.dispose();
    }

    await publishOutput(
      plan.outputDirectory,
      outputPlan.outputDirectory,
      transactionDirectory,
      publicationState,
    );
    return { output: outputPlan.outputDirectory, stats };
  } finally {
    if (!publicationState.preserveTransaction) {
      await rm(transactionDirectory, { recursive: true, force: true });
    }
  }
}
