import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { hashSourceLines, sourceLines } from "./source";
import type { SectionType } from "../shared/viewer";
import { scanSourceLines, type SourceScan } from "../shared/source-scanner";

export interface Entry {
  name: string;
  lines: number;
  prefix: string;
  suffix: string;
}

export interface EntryGroup {
  name: string;
  entries: Entry[];
}

export interface Section {
  type: SectionType;
  groups: EntryGroup[];
}

export interface ScriptIndex {
  sections: Section[];
  text: Map<string, string[]>;
  hashes: Map<string, string>;
  scans: Map<string, SourceScan[]>;
}

export interface Classification {
  type: SectionType;
  segment: string;
  prefix: string;
}

export function classify(filename: string): Classification {
  const name = basename(filename);
  if (name !== filename || !/^gml_[A-Za-z0-9_]+\.gml$/.test(name)) {
    throw new Error(`Unsafe GML filename: ${JSON.stringify(filename)}`);
  }
  if (name.startsWith("gml_GlobalScript_")) {
    return {
      type: "script",
      segment: "Global Scripts",
      prefix: "gml_GlobalScript_",
    };
  }
  if (name.startsWith("gml_Script_")) {
    return { type: "script", segment: "Scripts", prefix: "gml_Script_" };
  }
  if (name.startsWith("gml_Object_")) {
    const stem = name.replace(/\.gml$/, "");
    const objectCode = stem.slice("gml_Object_".length);
    const collisionOffset = objectCode.indexOf("_Collision_");
    if (collisionOffset !== -1) {
      const objectName = objectCode.slice(0, collisionOffset);
      return {
        type: "object",
        segment: objectName,
        prefix: `gml_Object_${objectName}_`,
      };
    }
    const match = /^(.*)_([A-Za-z]+)_(\d+)$/.exec(objectCode);
    if (match?.[1] === undefined) {
      throw new Error(`Failed to find object name: ${name}`);
    }
    return {
      type: "object",
      segment: match[1],
      prefix: `gml_Object_${match[1]}_`,
    };
  }
  if (name.startsWith("gml_RoomCC_")) {
    const match = /^gml_RoomCC_(.+)_(\d+)_(\w+)\.gml$/.exec(name);
    if (match?.[1] === undefined) {
      throw new Error(`Failed to find room name: ${name}`);
    }
    return {
      type: "roomcc",
      segment: match[1],
      prefix: `gml_RoomCC_${match[1]}_`,
    };
  }
  if (name.startsWith("gml_Room_")) {
    const match = /^gml_Room_(.+)_(\w+)\.gml$/.exec(name);
    if (match?.[1] === undefined) {
      throw new Error(`Failed to find room name: ${name}`);
    }
    return {
      type: "room",
      segment: match[1],
      prefix: `gml_Room_${match[1]}_`,
    };
  }
  throw new Error(`Failed to classify: ${name}`);
}

function emptySections(): Section[] {
  return [
    { type: "script", groups: [] },
    { type: "object", groups: [] },
    { type: "roomcc", groups: [] },
    { type: "room", groups: [] },
  ];
}

function addSectionEntry(
  sectionByType: Map<SectionType, Section>,
  name: string,
  lineCount: number,
): void {
  const classification = classify(`${name}.gml`);
  const section = sectionByType.get(classification.type);
  if (section === undefined) throw new Error("Unknown section type");
  let group = section.groups.find((candidate) => candidate.name === classification.segment);
  if (group === undefined) {
    group = { name: classification.segment, entries: [] };
    section.groups.push(group);
  }
  group.entries.push({
    name,
    lines: lineCount,
    prefix: classification.prefix,
    suffix: name.replace(classification.prefix, ""),
  });
}

export function sectionsFromNames(scripts: Iterable<readonly [string, number, string]>): Section[] {
  const sections = emptySections();
  const sectionByType = new Map(sections.map((section) => [section.type, section]));
  for (const [name, lineCount] of scripts) {
    addSectionEntry(sectionByType, name, lineCount);
  }
  return sections;
}

export async function indexGmlDirectory(decompiledDirectory: string): Promise<ScriptIndex> {
  const sections = emptySections();
  const sectionByType = new Map(sections.map((section) => [section.type, section]));
  const text = new Map<string, string[]>();
  const hashes = new Map<string, string>();
  const scans = new Map<string, SourceScan[]>();
  const files = (await readdir(decompiledDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".gml"))
    .map((entry) => entry.name)
    .sort();

  if (files.length === 0) {
    throw new Error(`No GML files found in ${decompiledDirectory}`);
  }

  for (const file of files) {
    const path = join(decompiledDirectory, file);
    const source = await readFile(path, "utf8");
    if (source.includes("DECOMPILER FAILED!")) {
      throw new Error(`UTMT failed to decompile ${path}`);
    }
    const name = file.slice(0, -".gml".length);
    const lines = sourceLines(source);
    const sourceHash = hashSourceLines(lines);
    addSectionEntry(sectionByType, name, lines.length);
    text.set(name, lines);
    hashes.set(name, sourceHash);
    scans.set(name, scanSourceLines(lines));
  }

  return { sections, text, hashes, scans };
}
