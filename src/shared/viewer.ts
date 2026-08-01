import type { RenumberToken } from "./renumbering";

export type SectionType = "script" | "object" | "roomcc" | "room";

export interface Script {
  payload: string;
  source: string;
  masked: string;
  renumbering: RenumberToken[];
  lines: number;
  type: SectionType;
  group: string;
  prefix?: string;
  suffix: string;
}

export interface Manifest {
  schemaVersion: 1;
  chapterId: string;
  chapterLabel: string;
  game: string;
  scripts: Record<string, Script>;
}

export interface ScriptPayload {
  schemaVersion: 1;
  lines: string[];
}
