export interface TimelineRelationship {
  kind: "shared-source";
  sourceChapter: string;
  targetChapters: string[];
  label: string;
}

export interface Chapter {
  id: string;
  label: string;
  revision: string;
  gameVersion?: string;
  viewer: string;
  search: string;
  assets?: string;
}

export interface Build {
  id: string;
  label: string;
  depotId?: string;
  manifestId?: string;
  publishedAt?: string;
  chapters: Chapter[];
}

export interface Catalog {
  schemaVersion: 1;
  game: string;
  builds: Build[];
  timelineRelationships?: TimelineRelationship[];
}
