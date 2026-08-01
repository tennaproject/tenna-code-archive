export interface ScriptAlias {
  canonical: string;
  chapters: string[];
}

export interface AliasMap {
  schemaVersion: 2;
  scripts: Record<string, ScriptAlias>;
}

const SAFE_SCRIPT = /^gml_[A-Za-z0-9_]+$/;
const SAFE_CHAPTER = /^[A-Za-z0-9._-]+$/;

export function parseAliasMap(value: unknown): AliasMap {
  if (typeof value !== "object" || value === null) throw new Error("Invalid script alias map");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 2 || typeof record.scripts !== "object" || record.scripts === null) {
    throw new Error("Invalid script alias map");
  }
  return value as AliasMap;
}

export function scriptAlias(aliases: AliasMap, requested: string): ScriptAlias | undefined {
  const alias = aliases.scripts[requested];
  if (alias === undefined) return undefined;
  if (
    typeof alias !== "object" ||
    alias === null ||
    !SAFE_SCRIPT.test(alias.canonical) ||
    !Array.isArray(alias.chapters) ||
    alias.chapters.length === 0 ||
    !alias.chapters.every((chapter) => typeof chapter === "string" && SAFE_CHAPTER.test(chapter))
  ) {
    throw new Error("Invalid script alias entry");
  }
  return alias;
}

export async function aliasChaptersForRelease(
  aliasChapters: readonly string[],
  releaseChapters: readonly string[],
  containsScript: (chapterId: string) => Promise<boolean>,
): Promise<string[]> {
  const availableChapters = new Set(releaseChapters);
  const matches = await Promise.all(
    aliasChapters.map(async (chapterId) =>
      availableChapters.has(chapterId) && (await containsScript(chapterId)) ? chapterId : undefined,
    ),
  );
  return matches.filter((chapterId): chapterId is string => chapterId !== undefined);
}
