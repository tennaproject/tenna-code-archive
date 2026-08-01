import type { Build, Catalog } from "../shared/catalog";
import type { ScriptPayload, Manifest, Script } from "../shared/viewer";
import {
  chapterReleases,
  fetchCompressedJson,
  fetchJson,
  fetchShardEntry,
  manifestUrl,
  shardUrl,
} from "./archive-client";
import { bindHoverPopover } from "./hover-popover";
import { formatLineHash, parseLineHash } from "./line-selection";
import { installLinkPrefetch } from "./prefetch";
import { PromiseLruCache } from "./promise-cache";
import {
  aliasChaptersForRelease,
  parseAliasMap,
  scriptAlias,
  type AliasMap,
} from "./script-routing";
import { populatePreview } from "./script-preview";
import { element, failureMessage, renderScriptName, setPageTitle, workerUrl } from "./ui";

function route():
  | {
      mode: "chapter";
      releaseId?: string;
      chapterId: string;
      scriptName: string;
    }
  | { mode: "alias"; releaseId?: string; scriptName: string } {
  const chaptered = document.documentElement.dataset.chaptered === "true";
  const segments = location.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  const filename = segments.at(-1);
  if (filename === undefined) throw new Error("Invalid script URL");
  const scriptName = filename.endsWith(".html") ? filename.slice(0, -".html".length) : filename;
  if (!scriptName.startsWith("gml_")) throw new Error("Invalid script URL");
  const releaseId = new URLSearchParams(location.search).get("build") ?? undefined;
  if (chaptered) {
    if (segments.length === 2) {
      return {
        mode: "chapter",
        releaseId,
        chapterId: segments[0] ?? "",
        scriptName,
      };
    }
    if (segments.length === 1) {
      return { mode: "alias", releaseId, scriptName };
    }
    throw new Error("Invalid script URL");
  }
  if (segments.length !== 1) throw new Error("Invalid script URL");
  return {
    mode: "chapter",
    releaseId,
    chapterId: "main",
    scriptName,
  };
}

let aliasRequest: Promise<AliasMap> | undefined;

function loadAliases(): Promise<AliasMap> {
  aliasRequest ??= fetchCompressedJson<unknown>("/data/aliases.json.gz").then(parseAliasMap);
  return aliasRequest;
}

async function resolveAlias(
  scriptName: string,
): Promise<
  | { type: "single"; scriptName: string; chapterId: string }
  | { type: "disambig"; scriptName: string; chapterIds: string[] }
  | { type: "missing" }
> {
  const alias = scriptAlias(await loadAliases(), scriptName);
  if (alias === undefined) return { type: "missing" };
  if (alias.chapters.length === 1) {
    return {
      type: "single",
      scriptName: alias.canonical,
      chapterId: alias.chapters[0] ?? "",
    };
  }
  return { type: "disambig", scriptName: alias.canonical, chapterIds: alias.chapters };
}

function renderDisambig(
  scriptName: string,
  chapterIds: string[],
  catalog: Catalog,
  releaseId: string | undefined,
): void {
  const disambig = element<HTMLElement>("script-disambig");
  const list = disambig.querySelector<HTMLUListElement>(".disambig-list");
  if (list === null) throw new Error("Missing disambiguation list");
  list.replaceChildren(
    ...chapterIds.map((id) => {
      const chapter = catalog.builds
        .flatMap((release) => release.chapters)
        .find((item) => item.id === id);
      const item = document.createElement("li");
      const link = document.createElement("a");
      const parameters =
        releaseId === undefined ? "" : `?${new URLSearchParams({ build: releaseId }).toString()}`;
      link.href = `/${encodeURIComponent(id)}/${encodeURIComponent(scriptName)}.html${parameters}`;
      const label = document.createElement("span");
      label.textContent = chapter?.label ?? id;
      const action = document.createElement("small");
      action.textContent = "Open script →";
      link.append(label, action);
      item.append(link);
      return item;
    }),
  );
  element<HTMLElement>("script-name").textContent = scriptName;
  element<HTMLSelectElement>("script-release").replaceChildren();
  element<HTMLElement>("related-scripts").hidden = true;
  element<HTMLElement>("code-panel").hidden = true;
  element<HTMLElement>("script-status").hidden = true;
  disambig.hidden = false;
  setPageTitle(scriptName, "Choose a chapter");
}

function scriptPrefix(scriptName: string, script: Script): string {
  if (script.prefix !== undefined) return script.prefix;
  return scriptName.slice(0, scriptName.length - script.suffix.length);
}

function parseSchema<T>(value: unknown, label: string): T {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Invalid ${label}`);
  }
  if ((value as Record<string, unknown>).schemaVersion !== 1) {
    throw new Error(`Invalid ${label}`);
  }
  return value as T;
}

function parseManifest(value: unknown): Manifest {
  return parseSchema<Manifest>(value, "viewer manifest");
}

function parsePayload(value: unknown): ScriptPayload {
  return parseSchema<ScriptPayload>(value, "script payload");
}

const manifestRequests = new PromiseLruCache<Manifest>(8);

function loadManifest(catalog: Catalog, chapterId: string, releaseId: string): Promise<Manifest> {
  const url = manifestUrl(catalog, chapterId, releaseId);
  return manifestRequests.get(url, () => fetchCompressedJson<unknown>(url).then(parseManifest));
}

let lineSelectionAnchor: number | undefined;

function highlightHash(options: { scroll?: boolean; anchor?: number } = {}): void {
  for (const row of document.querySelectorAll(".code .selected")) {
    row.classList.remove("selected");
  }
  const range = parseLineHash(location.hash);
  if (range === undefined) {
    lineSelectionAnchor = undefined;
    return;
  }
  lineSelectionAnchor = options.anchor ?? range.start;
  const startCell = document.querySelector<HTMLElement>(`#L${range.start}`);
  if (startCell === null) return;
  if (options.scroll !== false) startCell.scrollIntoView();
  let row: Element | null = startCell.parentElement;
  for (let line = range.start; row !== null && line <= range.end; line += 1) {
    row.classList.add("selected");
    row = row.nextElementSibling;
  }
}

function bindLineSelection(table: HTMLTableElement): void {
  table.addEventListener("click", (event) => {
    if (!(event instanceof MouseEvent) || !(event.target instanceof Element)) return;
    const link = event.target.closest<HTMLAnchorElement>('td:first-child a[href^="#L"]');
    if (link === null || event.metaKey || event.ctrlKey || event.altKey) return;
    const line = parseLineHash(link.hash)?.start;
    if (line === undefined) return;
    if (!event.shiftKey) {
      lineSelectionAnchor = line;
      return;
    }
    event.preventDefault();
    const anchor = lineSelectionAnchor ?? parseLineHash(location.hash)?.start ?? line;
    history.pushState(null, "", formatLineHash(anchor, line));
    highlightHash({ scroll: false, anchor });
  });
}

function renderRelated(manifest: Manifest, currentName: string, current: Script): void {
  if (current.type === "script") return;
  const related = Object.entries(manifest.scripts).filter(
    ([name, script]) =>
      name !== currentName && script.type === current.type && script.group === current.group,
  );
  if (related.length === 0) return;
  const container = element<HTMLSpanElement>("related-script-links");
  for (const [index, [name, script]] of related.entries()) {
    if (index > 0) container.append(", ");
    const item = document.createElement("a");
    item.textContent = script.suffix;
    item.href = releaseUrl(`${name}.html`);
    item.dataset.prefetch = shardUrl("/data/pages/payloads", script.payload);
    container.append(item);
  }
  element<HTMLElement>("related-scripts").hidden = false;
}

let activeReleaseId: string | undefined;

function releaseUrl(path: string): string {
  if (activeReleaseId === undefined) return path;
  const url = new URL(path, location.href);
  url.searchParams.set("build", activeReleaseId);
  return `${url.pathname.split("/").at(-1) ?? path}${url.search}${url.hash}`;
}

function annotateShardHints(container: ParentNode, manifest: Manifest): void {
  for (const link of container.querySelectorAll<HTMLAnchorElement>(
    'a[href$=".html"], a[href*=".html?"]',
  )) {
    const filename = link.pathname.split("/").at(-1);
    if (filename === undefined) continue;
    const script = manifest.scripts[decodeURIComponent(filename).slice(0, -".html".length)];
    if (script === undefined) continue;
    link.dataset.prefetch = shardUrl("/data/pages/payloads", script.payload);
  }
}

function preserveReleaseLinks(container: ParentNode): void {
  if (activeReleaseId === undefined) return;
  for (const link of container.querySelectorAll<HTMLAnchorElement>('a[href$=".html"]')) {
    link.href = releaseUrl(link.getAttribute("href") ?? link.href);
  }
}

function renderReleasePicker(releases: Build[], scriptName: string): void {
  const selected = activeReleaseId ?? releases[0]?.id;
  const picker = element<HTMLSelectElement>("script-release");
  picker.replaceChildren(
    ...releases.map((release) => {
      const option = document.createElement("option");
      option.value = release.id;
      option.textContent = release.label;
      option.selected = release.id === selected;
      return option;
    }),
  );
  picker.disabled = false;
  picker.addEventListener("change", () => {
    const url = new URL(location.href);
    url.searchParams.set("build", picker.value);
    location.href = `${scriptName}.html${url.search}${url.hash}`;
  });
}

async function findReleaseWithScript(
  catalog: Catalog,
  chapterId: string,
  releases: Build[],
  requestedReleaseId: string | undefined,
  scriptName: string,
): Promise<{
  release: Build;
  manifest: Manifest;
  script: Script;
  scriptName: string;
}> {
  const requested = releases.find((release) => release.id === requestedReleaseId);
  const candidates =
    requestedReleaseId === undefined || requested === undefined ? releases : [requested];
  let resolvedName = scriptName;
  let aliasChecked = false;

  for (const release of candidates) {
    const manifest = await loadManifest(catalog, chapterId, release.id);
    let script = manifest.scripts[resolvedName];
    if (script !== undefined) return { release, manifest, script, scriptName: resolvedName };

    if (!aliasChecked) {
      aliasChecked = true;
      const alias = scriptAlias(await loadAliases(), scriptName);
      if (alias?.chapters.includes(chapterId) === true) {
        resolvedName = alias.canonical;
        script = manifest.scripts[resolvedName];
        if (script !== undefined) return { release, manifest, script, scriptName: resolvedName };
      }
    }
  }

  if (requested !== undefined) {
    throw new Error(`Script not found in ${requested.label}`);
  }
  throw new Error("Script not found");
}

function renderLines(lines: string[]): HTMLTableElement {
  const table = document.querySelector<HTMLTableElement>("table.code");
  if (table === null) throw new Error("Missing code table");
  table.innerHTML = lines
    .map(
      (line, index) =>
        `<tr><td id="L${index + 1}"><a href="#L${index + 1}" aria-label="Line ${index + 1}" title="Select line ${index + 1}; Shift-click to select a range">${index + 1}</a></td><td><pre>${line}</pre></td></tr>`,
    )
    .join("");
  return table;
}

const previewRequests = new PromiseLruCache<string>(24);

function previewHtml(scriptName: string, manifest: Manifest): Promise<string> {
  const script = manifest.scripts[scriptName];
  if (script === undefined)
    return Promise.reject(new Error(`Unknown preview script: ${scriptName}`));
  return previewRequests.get(script.payload, () =>
    fetchShardEntry<unknown>("/data/pages/payloads", "payloads", script.payload)
      .then(parsePayload)
      .then(async (payload) => {
        const preview = await highlight(payload.lines.slice(0, 100));
        if (payload.lines.length > 100) preview.push("...");
        return preview.join("\n");
      }),
  );
}

async function loadPreview(preview: HTMLElement, manifest: Manifest): Promise<void> {
  const scriptName = preview.dataset.scriptPreview;
  const content = preview.querySelector<HTMLElement>(":scope > .script-preview-content");
  if (scriptName === undefined || content === null) return;
  await populatePreview(
    content,
    () => previewHtml(scriptName, manifest),
    () => {
      preserveReleaseLinks(content);
      annotateShardHints(content, manifest);
    },
    (error) => failureMessage(error, "Unable to load this preview."),
  );
}

const annotationBindings = new WeakMap<HTMLElement, ReturnType<typeof bindHoverPopover>>();
let annotationManifest: Manifest | undefined;
let annotationPopoverDocument: Document | undefined;

function activateAnnotationPopover(event: Event): void {
  if (!(event.target instanceof Element) || annotationManifest === undefined) return;

  const functionContainer = event.target.closest<HTMLElement>(".function-reference");
  if (functionContainer !== null) {
    const trigger = functionContainer.querySelector<HTMLElement>(":scope > .function-link");
    const preview = functionContainer.querySelector<HTMLElement>(":scope > .function-preview");
    if (trigger !== null && preview !== null) {
      let binding = annotationBindings.get(preview);
      if (binding === undefined) {
        binding = bindHoverPopover(trigger, preview, { interactive: true });
        annotationBindings.set(preview, binding);
      }
      const loading = loadPreview(preview, annotationManifest);
      binding.show();
      void loading.then(() => {
        if (preview.hasAttribute("data-open")) binding.show();
      });
    }
    return;
  }

  const alarmContainer = event.target.closest<HTMLElement>(".alarm-reference");
  if (alarmContainer !== null) {
    const preview = alarmContainer.querySelector<HTMLElement>(":scope > .alarm-preview");
    if (preview !== null) void loadPreview(preview, annotationManifest);
    return;
  }

  const localized = event.target.closest<HTMLElement>(".localized-text");
  const preview = localized?.querySelector<HTMLElement>(":scope > .localized-expression");
  if (localized !== null && preview !== null && preview !== undefined) {
    let binding = annotationBindings.get(preview);
    if (binding === undefined) {
      binding = bindHoverPopover(localized, preview, { placement: "top" });
      annotationBindings.set(preview, binding);
    }
    binding.show();
  }
}

function bindAnnotationPopovers(table: HTMLTableElement, manifest: Manifest): void {
  annotationManifest = manifest;
  const ownerDocument = table.ownerDocument;
  if (ownerDocument === annotationPopoverDocument) return;
  annotationPopoverDocument?.removeEventListener("pointerover", activateAnnotationPopover);
  annotationPopoverDocument?.removeEventListener("focusin", activateAnnotationPopover);
  ownerDocument.addEventListener("pointerover", activateAnnotationPopover);
  ownerDocument.addEventListener("focusin", activateAnnotationPopover);
  annotationPopoverDocument = ownerDocument;
}

function reserveCodeHeight(lines: number): void {
  element<HTMLElement>("code-panel").style.minHeight = `calc(${lines} * var(--code-line-height))`;
}

function releaseCodeHeight(): void {
  const panel = element<HTMLElement>("code-panel");
  panel.style.minHeight = "";
  panel.dataset.loaded = "true";
}

function paintLines(lines: string[], manifest: Manifest): void {
  const table = renderLines(lines);
  bindLineSelection(table);
  preserveReleaseLinks(table);
  annotateShardHints(table, manifest);
  bindAnnotationPopovers(table, manifest);
  highlightHash();
}

function highlight(lines: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl("highlightWorker"), {
      type: "module",
    });
    worker.addEventListener("message", (event: MessageEvent<string[]>) => {
      resolve(event.data);
      worker.terminate();
    });
    worker.addEventListener("error", (event) => {
      worker.terminate();
      reject(event.error ?? new Error("Highlight worker failed"));
    });
    worker.postMessage(lines);
  });
}

async function load(): Promise<void> {
  const status = element<HTMLElement>("script-status");
  installLinkPrefetch();
  try {
    const routeResult = route();
    const catalog = await fetchJson<Catalog>("/data/catalog.json");

    let chapterId: string;
    let scriptName: string;
    const requestedReleaseId = routeResult.releaseId;

    if (routeResult.mode === "alias") {
      scriptName = routeResult.scriptName;
      const resolved = await resolveAlias(scriptName);
      if (resolved.type === "missing") throw new Error("Script not found");
      scriptName = resolved.scriptName;
      const requestedRelease = catalog.builds.find((release) => release.id === requestedReleaseId);
      let chapterIds = resolved.type === "disambig" ? resolved.chapterIds : [resolved.chapterId];
      if (requestedRelease !== undefined) {
        chapterIds = await aliasChaptersForRelease(
          chapterIds,
          requestedRelease.chapters.map((chapter) => chapter.id),
          async (id) =>
            (await loadManifest(catalog, id, requestedRelease.id)).scripts[scriptName] !==
            undefined,
        );
      }
      if (chapterIds.length === 0) {
        throw new Error(`Script not found in ${requestedRelease?.label ?? "release"}`);
      }
      if (chapterIds.length > 1) {
        renderDisambig(scriptName, chapterIds, catalog, requestedRelease?.id);
        return;
      }
      chapterId = chapterIds[0] ?? "";
      const chapterUrl = `/${encodeURIComponent(chapterId)}/${encodeURIComponent(scriptName)}.html${location.search}${location.hash}`;
      history.replaceState(null, "", chapterUrl);
    } else {
      chapterId = routeResult.chapterId;
      scriptName = routeResult.scriptName;
    }

    const releases = chapterReleases(catalog, chapterId);
    const defaultReleaseId = releases[0]?.id;
    if (defaultReleaseId === undefined) {
      throw new Error("No releases contain this chapter");
    }
    const requestedRelease = releases.find((release) => release.id === requestedReleaseId);
    activeReleaseId = requestedRelease?.id ?? defaultReleaseId;

    const found = await findReleaseWithScript(
      catalog,
      chapterId,
      releases,
      requestedReleaseId,
      scriptName,
    );
    const { release, manifest, script } = found;
    scriptName = found.scriptName;
    activeReleaseId = release.id;
    renderReleasePicker(releases, scriptName);
    element<HTMLSelectElement>("script-release").value = release.id;
    const url = new URL(location.href);
    url.pathname = `/${encodeURIComponent(chapterId)}/${encodeURIComponent(scriptName)}.html`;
    url.searchParams.set("build", release.id);
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    setPageTitle(scriptName, manifest.chapterLabel, release.label);
    renderScriptName(
      element<HTMLElement>("script-name"),
      scriptPrefix(scriptName, script),
      script.suffix,
    );
    const raw = element<HTMLAnchorElement>("raw-source");
    raw.href = `/source.html?${new URLSearchParams({
      hash: script.source,
      name: scriptName,
    }).toString()}`;
    raw.dataset.prefetch = shardUrl("/data/sources", script.source);
    raw.classList.remove("pending-reveal");
    element<HTMLAnchorElement>("back-to-chapter").href = releaseUrl("index.html");
    renderRelated(manifest, scriptName, script);
    reserveCodeHeight(script.lines);

    const payload = parsePayload(
      await fetchShardEntry<unknown>("/data/pages/payloads", "payloads", script.payload),
    );

    const highlighted = await highlight(payload.lines);
    paintLines(highlighted, manifest);
    status.hidden = true;
    releaseCodeHeight();
  } catch (error) {
    element<HTMLElement>("script-name").textContent = "Script unavailable";
    setPageTitle("Script unavailable");
    status.textContent = failureMessage(
      error,
      "Unable to load this script. Check your connection and try again.",
    );
    status.hidden = false;
    releaseCodeHeight();
  }
}

window.addEventListener("hashchange", () => highlightHash());
void load();
