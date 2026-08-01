import type { Build, Catalog } from "../shared/catalog";
import type { SectionType, Manifest, Script } from "../shared/viewer";
import {
  chapterReleases,
  fetchCompressedJson,
  fetchJson,
  manifestUrl,
  shardUrl,
} from "./archive-client";
import { installLinkPrefetch } from "./prefetch";
import { element, failureMessage, renderScriptName, sectionName, setPageTitle } from "./ui";

const LIST_INITIAL_BATCH_SIZE = 120;
const LIST_BATCH_SIZE = 240;

const releaseSelect = element<HTMLSelectElement>("chapter-release");
const sections = element<HTMLElement>("script-sections");
const searchSubmit = element<HTMLButtonElement>("search-submit");

let listingRenderId = 0;
let listingObserver: IntersectionObserver | undefined;

function chapterId(): string {
  const id = location.pathname.split("/").filter(Boolean)[0];
  if (id === undefined || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error("Invalid chapter URL");
  }
  return id;
}

function scriptRow(
  name: string,
  script: Script,
  releaseId: string | undefined,
): HTMLTableRowElement {
  const row = document.createElement("tr");
  row.className = "table-subsection-content";
  const nameCell = document.createElement("td");
  const link = document.createElement("a");
  link.href =
    releaseId === undefined
      ? `${name}.html`
      : `${name}.html?build=${encodeURIComponent(releaseId)}`;
  link.dataset.prefetch = shardUrl("/data/pages/payloads", script.payload);
  renderScriptName(link, script.prefix ?? "", script.suffix);
  nameCell.append(link);

  const raw = document.createElement("td");
  const rawLink = document.createElement("a");
  rawLink.href = `/source.html?${new URLSearchParams({
    hash: script.source,
    name,
  }).toString()}`;
  rawLink.className = "raw-link";
  rawLink.dataset.prefetch = shardUrl("/data/sources", script.source);
  rawLink.textContent = "raw";
  rawLink.ariaLabel = `View raw source for ${name}`;
  raw.append(rawLink);
  const lines = document.createElement("td");
  lines.textContent = script.lines.toString();
  row.append(nameCell, lines, raw);
  return row;
}

function renderListing(manifest: Manifest, releaseId: string | undefined): void {
  listingRenderId += 1;
  const renderId = listingRenderId;
  listingObserver?.disconnect();
  listingObserver = undefined;

  const byType = new Map<SectionType, Array<[string, Script]>>();
  for (const [name, script] of Object.entries(manifest.scripts)) {
    const scripts = byType.get(script.type) ?? [];
    scripts.push([name, script]);
    byType.set(script.type, scripts);
  }

  const content: HTMLElement[] = [];
  const lazyBatches = new Map<Element, () => void>();

  for (const type of ["script", "object", "roomcc", "room"] as const) {
    const scripts = byType.get(type);
    if (scripts === undefined || scripts.length === 0) continue;

    const heading = document.createElement("h2");
    heading.className = "section-label";
    heading.textContent = sectionName(type);
    const table = document.createElement("table");
    table.className = `inventory-table chapter-inventory ${type}`;
    const head = document.createElement("thead");
    head.innerHTML =
      '<tr><th scope="col">Name</th><th scope="col">Lines</th><th scope="col">Raw source</th></tr>';
    const body = document.createElement("tbody");
    table.append(head, body);

    let priorGroup: string | undefined;
    let index = 0;
    const appendBatch = (size: number): void => {
      if (renderId !== listingRenderId) return;
      const end = Math.min(index + size, scripts.length);
      const fragment = document.createDocumentFragment();
      for (; index < end; index += 1) {
        const entry = scripts[index];
        if (entry === undefined) break;
        const [name, script] = entry;
        if (script.group !== priorGroup) {
          const group = document.createElement("tr");
          group.className = "table-subsection-header";
          const groupName = document.createElement("th");
          groupName.textContent = script.group;
          groupName.colSpan = 3;
          groupName.scope = "rowgroup";
          group.append(groupName);
          fragment.append(group);
          priorGroup = script.group;
        }
        fragment.append(scriptRow(name, script, releaseId));
      }
      body.append(fragment);
    };

    appendBatch(LIST_INITIAL_BATCH_SIZE);
    content.push(heading, table);

    if (index < scripts.length) {
      const sentinel = document.createElement("div");
      sentinel.className = "script-list-sentinel";
      sentinel.textContent = `Loading more ${sectionName(type).toLowerCase()} as you scroll…`;
      content.push(sentinel);
      lazyBatches.set(sentinel, () => {
        appendBatch(LIST_BATCH_SIZE);
        if (index >= scripts.length) {
          listingObserver?.unobserve(sentinel);
          sentinel.remove();
        }
      });
    }
  }

  if (content.length === 0) {
    const empty = document.createElement("p");
    empty.className = "panel-muted";
    empty.textContent = "No code entries are available in this release.";
    content.push(empty);
  }
  sections.replaceChildren(...content);
  sections.setAttribute("aria-busy", "false");

  if (lazyBatches.size > 0) {
    listingObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || renderId !== listingRenderId) continue;
          lazyBatches.get(entry.target)?.();
        }
      },
      { rootMargin: "1000px 0px" },
    );
    for (const sentinel of lazyBatches.keys()) listingObserver.observe(sentinel);
  }
}

async function renderSelection(catalog: Catalog, releases: Build[], id: string): Promise<void> {
  searchSubmit.disabled = true;
  const release = releases.find((candidate) => candidate.id === releaseSelect.value);
  if (release === undefined) throw new Error("Unknown release");
  const isDefaultRelease = releases[0]?.id === release.id;

  const chapter = release.chapters.find((item) => item.id === id);
  if (chapter === undefined) throw new Error("Release does not contain chapter");
  setPageTitle(chapter.label, release.label);
  releaseSelect.dataset.searchUrl = chapter.search;
  searchSubmit.disabled = false;
  const searchResults = document.getElementById("search-results");
  searchResults?.classList.add("hidden");
  searchResults?.setAttribute("aria-busy", "false");

  listingRenderId += 1;
  sections.setAttribute("aria-busy", "true");
  const status = document.createElement("p");
  status.className = "panel-muted";
  status.id = "script-sections-status";
  status.setAttribute("role", "status");
  status.textContent = "Loading script inventory…";
  sections.replaceChildren(status);

  const manifest = await fetchCompressedJson<Manifest>(
    manifestUrl(catalog, id, isDefaultRelease ? undefined : release.id),
  );
  if (releaseSelect.value !== release.id) return;
  renderListing(manifest, release.id);

  const url = new URL(location.href);
  url.searchParams.set("build", release.id);
  history.replaceState(null, "", `${url.pathname}${url.search}`);
}

async function start(): Promise<void> {
  installLinkPrefetch();
  const catalog = await fetchJson<Catalog>("/data/catalog.json");
  const id = chapterId();
  const releases = chapterReleases(catalog, id);
  if (releases.length === 0) throw new Error("No releases contain this chapter");
  const requested = new URLSearchParams(location.search).get("build");
  const selected = releases.some((release) => release.id === requested)
    ? requested
    : releases[0]?.id;
  releaseSelect.replaceChildren(
    ...releases.map((release) => {
      const option = document.createElement("option");
      option.value = release.id;
      option.textContent = release.label;
      option.selected = release.id === selected;
      return option;
    }),
  );
  releaseSelect.disabled = false;
  releaseSelect.dataset.defaultRelease = releases[0]?.id ?? "";
  releaseSelect.addEventListener("change", () => {
    const requestedRelease = releaseSelect.value;
    void renderSelection(catalog, releases, id).catch((error: unknown) => {
      if (releaseSelect.value !== requestedRelease) return;
      sections.setAttribute("aria-busy", "false");
      const status = document.getElementById("script-sections-status");
      if (status !== null) {
        status.textContent = failureMessage(
          error,
          "Unable to load scripts for this release. Check your connection and try again.",
        );
      }
    });
  });
  await renderSelection(catalog, releases, id);
}

void start().catch((error: unknown) => {
  sections.setAttribute("aria-busy", "false");
  const status = document.getElementById("script-sections-status");
  if (status !== null) {
    status.textContent = failureMessage(
      error,
      "Unable to load this chapter. Check your connection and try again.",
    );
  }
});
