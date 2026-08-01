import { readFile } from "node:fs/promises";
import { join } from "node:path";

const VERSION_SOURCES: Array<[filename: string, pattern: RegExp]> = [
  ["gml_Object_obj_initializer2_Create_0.gml", /\bglobal\.(?:versionno|version)\s*=\s*"([^"]+)"/],
  [
    "gml_GlobalScript_scr_init.gml",
    /function\s+get_version\s*\([^)]*\)\s*\{[\s\S]*?\bvar\s+version\s*=\s*"([^"]+)"/,
  ],
  ["gml_Object_obj_CHAPTER_SELECT_Create_0.gml", /\bglobal\.(?:versionno|version)\s*=\s*"([^"]+)"/],
  ["gml_Object_DEVICE_MENU_Create_0.gml", /\bversion_text\s*=\s*"([^"]+)"/],
];

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function extractGameVersion(chapterRoot: string): Promise<string | undefined> {
  for (const [filename, pattern] of VERSION_SOURCES) {
    const source = await readIfPresent(join(chapterRoot, filename));
    if (source === undefined) continue;
    const version = pattern.exec(source)?.[1]?.trim();
    if (version !== undefined && version !== "") return version;
  }
  return undefined;
}
