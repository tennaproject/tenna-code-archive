import type { SectionType } from "../shared/viewer";

type WorkerAsset = "diffWorker" | "highlightWorker" | "searchWorker";

const sectionNames: Record<SectionType, string> = {
  script: "Scripts",
  object: "Objects",
  roomcc: "Room Creation Codes",
  room: "Rooms",
};

export function failureMessage(error: unknown, recovery: string): string {
  console.error(error);
  return recovery;
}

export function setPageTitle(...parts: string[]): void {
  document.title = [...parts, "Tenna Code Archive"].join(" - ");
}

export function element<T extends HTMLElement>(id: string): T {
  const result = document.getElementById(id);
  if (result === null) throw new Error(`Missing #${id}`);
  return result as T;
}

export function workerUrl(name: WorkerAsset): string {
  const url = document.documentElement.dataset[name];
  if (url === undefined || url === "") {
    throw new Error(`Missing worker URL: data-${name}`);
  }
  return url;
}

export function renderScriptName(parent: HTMLElement, prefix: string, suffix: string): void {
  const prefixElement = document.createElement("span");
  prefixElement.className = "prefix";
  prefixElement.textContent = prefix;
  const suffixElement = document.createElement("span");
  suffixElement.className = "suffix";
  suffixElement.textContent = suffix;
  parent.replaceChildren(prefixElement, suffixElement);
}

export function sectionName(type: SectionType): string {
  return sectionNames[type];
}
