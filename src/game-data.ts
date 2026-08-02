import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { projectRoot } from "./platform/paths";
import type { TimelineRelationship } from "./shared/catalog";
import type { RenumberOverrides } from "./shared/renumbering";

export interface Room {
  name: string;
  description: string;
}

export interface Config {
  game: string;
  siteUrl?: string;
  links: Record<string, string>;
  chapters: Record<string, string>;
  timelineRelationships?: TimelineRelationship[];
  footer?: string;
  shardPrefixLength?: number;
}

export class DeltaruneData {
  private enemies?: Promise<string[]>;
  private flags?: Promise<Record<number, string>>;
  private rooms?: Promise<Room[]>;
  private language?: Promise<Record<string, string>>;
  private config?: Promise<Config>;
  private renumbering?: Promise<RenumberOverrides>;

  constructor(private readonly projectDirectory = projectRoot) {}

  private async loadJson<T>(filename: string): Promise<T> {
    const path = join(this.projectDirectory, "data", `${filename}.json`);
    return JSON.parse(await readFile(path, "utf8")) as T;
  }

  async getEnemy(enemyId: number): Promise<string | undefined> {
    this.enemies ??= this.loadJson<string[]>("enemies");
    return (await this.enemies)[enemyId];
  }

  async getFlag(flagId: number): Promise<string | undefined> {
    if (this.flags === undefined) {
      this.flags = this.loadJson<Record<string, string>>("flags").then((flags) =>
        Object.fromEntries(Object.entries(flags).map(([key, value]) => [Number(key), value])),
      );
    }
    return (await this.flags)[flagId];
  }

  async getRoomById(roomId: number): Promise<Room | undefined> {
    this.rooms ??= this.loadJson<Room[]>("rooms");
    return (await this.rooms)[roomId];
  }

  async getRoomByName(roomName: string, chapterId?: string): Promise<Room | undefined> {
    this.rooms ??= this.loadJson<Room[]>("rooms");
    const rooms = await this.rooms;
    return rooms.find(
      (room) =>
        room.name === roomName ||
        (chapterId !== undefined && room.name === `${roomName}_${chapterId}`),
    );
  }

  async getLocalizedString(key: string): Promise<string> {
    if (this.language === undefined) {
      this.language = this.loadJson<Record<string, string>>("lang_en");
    }
    return (await this.language)[key] ?? key;
  }

  async getConfig(): Promise<Config> {
    this.config ??= this.loadJson<Config>("config");
    return this.config;
  }

  async getRenumberOverrides(): Promise<RenumberOverrides> {
    this.renumbering ??= this.loadJson<RenumberOverrides>("renumbering");
    return this.renumbering;
  }
}
