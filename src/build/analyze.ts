import { createHash } from "node:crypto";

import { classify, indexGmlDirectory, type ScriptIndex } from "../gml/indexer";
import type { SectionType } from "../shared/viewer";
import type { ArtifactStore } from "./store";

interface CatalogScript {
  name: string;
  hash: string;
  lines: number;
  type: SectionType;
  group: string;
  prefix: string;
  suffix: string;
}

interface ChapterAnalysis {
  scripts: CatalogScript[];
  revision: string;
  index?: ScriptIndex;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCatalogScript(value: unknown): value is CatalogScript {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.hash) ||
    !Number.isInteger(value.lines) ||
    (value.lines as number) < 0 ||
    typeof value.type !== "string" ||
    typeof value.group !== "string" ||
    typeof value.prefix !== "string" ||
    typeof value.suffix !== "string"
  ) {
    return false;
  }

  try {
    const classification = classify(`${value.name}.gml`);
    return (
      value.type === classification.type &&
      value.group === classification.segment &&
      value.prefix === classification.prefix &&
      value.suffix === value.name.replace(classification.prefix, "")
    );
  } catch {
    return false;
  }
}

function isCatalogScripts(value: unknown): value is CatalogScript[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isCatalogScript)) return false;
  return value.every(
    (script, index) => index === 0 || compareScriptNames(value[index - 1]!.name, script.name) < 0,
  );
}

function compareScriptNames(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function scriptsFromIndex(index: ScriptIndex): CatalogScript[] {
  const scripts: CatalogScript[] = [];
  for (const section of index.sections) {
    for (const group of section.groups) {
      for (const entry of group.entries) {
        const hash = index.hashes.get(entry.name);
        if (hash === undefined) {
          throw new Error(`Missing source hash for ${entry.name}`);
        }
        scripts.push({
          name: entry.name,
          hash,
          lines: entry.lines,
          type: section.type,
          group: group.name,
          prefix: entry.prefix,
          suffix: entry.suffix,
        });
      }
    }
  }
  return scripts.sort((left, right) => compareScriptNames(left.name, right.name));
}

function revisionForScripts(scripts: CatalogScript[]): string {
  const hash = createHash("sha256");
  for (const script of scripts) {
    hash.update(script.name);
    hash.update("\0");
    hash.update(script.hash);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function searchUrlForChapter(
  chapterId: string,
  revision: string,
  renderStamp: string,
): string {
  return `/${chapterId}/index-${revision.slice(0, 12)}-${renderStamp.slice(0, 8)}.json.gz`;
}

interface AnalyzeRequest {
  buildId: string;
  chapterId: string;
  inputDirectory: string;
  fingerprint: string;
}

export async function analyzeChapter(
  request: AnalyzeRequest,
  store: ArtifactStore,
): Promise<{ analysis: ChapterAnalysis; cached: boolean }> {
  const cached = await store.readCatalog(request.buildId, request.chapterId, request.fingerprint);
  if (isCatalogScripts(cached)) {
    return {
      analysis: { scripts: cached, revision: revisionForScripts(cached) },
      cached: true,
    };
  }

  const index = await indexGmlDirectory(request.inputDirectory);
  const scripts = scriptsFromIndex(index);
  await store.writeCatalog(request.buildId, request.chapterId, request.fingerprint, scripts);
  return {
    analysis: { scripts, revision: revisionForScripts(scripts), index },
    cached: false,
  };
}
