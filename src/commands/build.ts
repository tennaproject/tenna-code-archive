import { resolve } from "node:path";

import { buildDeltarune } from "../build/pipeline";

interface ParsedOptions {
  chapter?: string;
  catalogFile?: string;
  gmlRoot?: string;
  inputDirectory?: string;
  outputDirectory?: string;
  cache?: boolean;
  cacheDirectory?: string;
  prune?: boolean;
}

function parseOptions(arguments_: string[]): ParsedOptions {
  const options: ParsedOptions = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (option === "--no-cache") {
      options.cache = false;
      continue;
    }
    if (option === "--prune") {
      options.prune = true;
      continue;
    }
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${String(option)}`);
    switch (option) {
      case "--cache-dir":
        options.cacheDirectory = value;
        break;
      case "--chapter":
        options.chapter = value;
        break;
      case "--catalog":
        options.catalogFile = value;
        break;
      case "--gml":
        options.gmlRoot = resolve(value);
        break;
      case "--input":
        options.inputDirectory = value;
        break;
      case "--output":
        options.outputDirectory = value;
        break;
      default:
        throw new Error(`Unknown option: ${String(option)}`);
    }
    index += 1;
  }
  const sources = [options.catalogFile, options.gmlRoot, options.inputDirectory].filter(
    (value) => value !== undefined,
  );
  if (sources.length > 1) throw new Error("Use only one of --catalog, --gml, or --input");
  return options;
}

const options = parseOptions(Bun.argv.slice(2));
const { output, stats } = await buildDeltarune({
  chapter: options.chapter,
  catalogFile: options.catalogFile,
  gmlRoot: options.gmlRoot,
  inputDirectory: options.inputDirectory,
  outputDirectory: options.outputDirectory,
  cache: options.cache,
  cacheDirectory: options.cacheDirectory,
  prune: options.prune,
});
console.log(`Built ${output}`);
console.log(
  `Scripts: ${stats.scripts.rendered} annotated, ${stats.scripts.cached} cached; ` +
    `catalog: ${stats.catalog.computed} computed, ${stats.catalog.cached} cached`,
);
