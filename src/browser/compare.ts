import type { Catalog } from "../shared/catalog";
import type { Manifest } from "../shared/viewer";
import { fetchCompressedJson, fetchJson, fetchShardEntry, manifestUrl } from "./archive-client";
import { buildOptionAvailability, normalizeBuildPair, type BuildPair } from "./compare-builds";
import { calculateDiff, cancelDiff } from "./compare-diff";
import { CompareList } from "./compare-list";
import {
  compareManifests,
  formatKindFilter,
  parseKindFilter,
  scriptNameParts,
  type ChangeKind,
  type ComparedScript,
  type KindFilter,
} from "./compare-scripts";
import type { HighlightedDiffRow } from "./diff";
import type { AssetTablesFile, RenumberTables } from "../shared/renumbering";
import { bindOptionHints } from "./option-hints";
import { diffHunks } from "./diff-navigation";
import { PromiseLruCache } from "./promise-cache";
import { element, failureMessage, renderScriptName, setPageTitle } from "./ui";

const leftBuild = element<HTMLSelectElement>("left-build");
const rightBuild = element<HTMLSelectElement>("right-build");
const chapter = element<HTMLSelectElement>("chapter");
const filterKind = element<HTMLFieldSetElement>("script-filter-kind");
const filterBoxes = [...filterKind.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
const sorting = element<HTMLSelectElement>("script-sort");
const copyScriptListButton = element<HTMLButtonElement>("copy-script-list");
const summary = element<HTMLElement>("comparison-summary");
const scriptListSection = element<HTMLElement>("script-list-section");
const comparisonSections = element<HTMLElement>("comparison-sections");
const diffSection = element<HTMLElement>("diff-section");
const diffTitle = element<HTMLElement>("diff-title");
const diffBody = element<HTMLTableSectionElement>("diff-body");
const diffNavigation = element<HTMLElement>("diff-navigation");
const diffNavigationPosition = element<HTMLElement>("diff-navigation-position");
const previousDiffChange = element<HTMLButtonElement>("previous-diff-change");
const nextDiffChange = element<HTMLButtonElement>("next-diff-change");
const backToScripts = element<HTMLAnchorElement>("back-to-scripts");
const diffScrollContainer = diffSection.querySelector<HTMLElement>(".source-container");
if (diffScrollContainer === null) throw new Error("Missing diff source container");
const diffWarning = document.createElement("p");
diffWarning.className = "panel-muted diff-warning";
diffWarning.setAttribute("role", "status");
diffWarning.hidden = true;
diffScrollContainer.before(diffWarning);
const manifestRequests = new PromiseLruCache<Manifest>(8);
const sourceRequests = new PromiseLruCache<string>(32);
const assetTableRequests = new PromiseLruCache<AssetTablesFile>(4);
let diffViewRequestId = 0;
let comparisonLoadRequestId = 0;
let catalog: Catalog;
let comparedScripts: ComparedScript[] = [];
let selectedScriptName: string | undefined;
let diffHunkRows: HTMLTableRowElement[][] = [];
let currentDiffHunk = -1;
let diffScrollUpdatePending = false;
let activeRenumberTables: RenumberTables | undefined;
let activeRenumberWarning: string | undefined;
let diffOrigin: HTMLElement | undefined;

function selectedBuild(id: string) {
  const build = catalog.builds.find((candidate) => candidate.id === id);
  if (build === undefined) throw new Error(`Unknown release ${id}`);
  return build;
}

function replaceOptions(
  select: HTMLSelectElement,
  options: Array<{ value: string; label: string }>,
  selected?: string,
): void {
  select.replaceChildren(
    ...options.map(({ value, label }) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = value === selected;
      return option;
    }),
  );
}

function selectedKinds(): KindFilter {
  return new Set(filterBoxes.filter((box) => box.checked).map((box) => box.value as ChangeKind));
}

function applyKindFilter(filter: KindFilter): void {
  for (const box of filterBoxes) box.checked = filter.has(box.value as ChangeKind);
}

function updateChapterOptions(preferred?: string): void {
  const leftChapters = selectedBuild(leftBuild.value).chapters;
  const rightIds = new Set(selectedBuild(rightBuild.value).chapters.map((item) => item.id));
  const shared = leftChapters.filter((item) => rightIds.has(item.id));
  replaceOptions(
    chapter,
    shared.map((item) => ({ value: item.id, label: item.label })),
    shared.some((item) => item.id === preferred) ? preferred : shared[0]?.id,
  );
}

function updateBuildOptionStates(pair: BuildPair): void {
  const buildIds = catalog.builds.map((build) => build.id);
  const availability = new Map(
    buildOptionAvailability(buildIds, pair).map((state) => [state.id, state]),
  );
  for (const option of leftBuild.options) {
    option.disabled = availability.get(option.value)?.asEarlier !== true;
  }
  for (const option of rightBuild.options) {
    option.disabled = availability.get(option.value)?.asLater !== true;
  }
}

function fetchManifest(url: string): Promise<Manifest> {
  return manifestRequests.get(url, () => fetchCompressedJson<Manifest>(url));
}

function fetchSource(hash: string): Promise<string> {
  return sourceRequests.get(hash, () => fetchShardEntry<string>("/data/sources", "sources", hash));
}

function assetTablesUrl(buildId: string): string | undefined {
  return catalog.builds
    .find((build) => build.id === buildId)
    ?.chapters.find((item) => item.id === chapter.value)?.assets;
}

function fetchAssetTables(url: string): Promise<AssetTablesFile> {
  return assetTableRequests.get(url, () =>
    fetchCompressedJson<unknown>(url).then((value) => {
      if (
        typeof value !== "object" ||
        value === null ||
        (value as Record<string, unknown>).schemaVersion !== 1
      ) {
        throw new Error("Invalid asset table metadata");
      }
      return value as AssetTablesFile;
    }),
  );
}

interface RenumberTableResult {
  tables?: RenumberTables;
  warning?: string;
}

async function renumberTables(): Promise<RenumberTableResult> {
  const leftUrl = assetTablesUrl(leftBuild.value);
  const rightUrl = assetTablesUrl(rightBuild.value);
  if (leftUrl === undefined || rightUrl === undefined) {
    return {
      warning:
        "Asset-renumbering detection is unavailable because this release pair has no complete asset metadata.",
    };
  }
  try {
    const [left, right] = await Promise.all([
      fetchAssetTables(leftUrl),
      fetchAssetTables(rightUrl),
    ]);
    return {
      tables: {
        left: left.tables,
        right: right.tables,
        overrides: right.overrides,
      },
    };
  } catch (error) {
    console.error("Unable to load asset-renumbering metadata", error);
    return {
      warning:
        "Asset-renumbering detection is unavailable because its metadata could not be loaded.",
    };
  }
}

function preloadScriptSources(script: ComparedScript): void {
  if (script.left !== undefined) void fetchSource(script.left.source);
  if (script.right !== undefined) void fetchSource(script.right.source);
}

function comparisonUrl(scriptName: string | null = selectedScriptName ?? null): string {
  const parameters = new URLSearchParams({
    left: leftBuild.value,
    right: rightBuild.value,
    chapter: chapter.value,
    filter: formatKindFilter(selectedKinds()),
    sort: sorting.value,
  });
  if (scriptName !== null) parameters.set("script", scriptName);
  return `${location.pathname}?${parameters}`;
}

function updateBackLink(): void {
  backToScripts.href = comparisonUrl(null);
}

function updateUrl(mode: "push" | "replace" = "replace"): void {
  const url = comparisonUrl();
  if (mode === "push") history.pushState(null, "", url);
  else history.replaceState(null, "", url);
  updateBackLink();
}

function updatePageTitle(scriptName?: string): void {
  const chapterLabel = chapter.selectedOptions[0]?.textContent?.trim();
  if (scriptName !== undefined && chapterLabel !== undefined) {
    setPageTitle(`${scriptName} comparison`, chapterLabel);
  } else if (chapterLabel !== undefined) {
    setPageTitle(`Compare ${chapterLabel} releases`);
  } else {
    setPageTitle("Compare releases");
  }
}

function restoreScriptListFocus(): void {
  if (diffOrigin?.isConnected === true) diffOrigin.focus();
  else sorting.focus();
  diffOrigin = undefined;
}

function showScriptList(mode?: "push" | "replace", restoreFocus = false): void {
  diffViewRequestId += 1;
  cancelDiff();
  selectedScriptName = undefined;
  clearDiffNavigation();
  updatePageTitle();
  scriptListSection.hidden = false;
  diffSection.hidden = true;
  if (mode !== undefined) updateUrl(mode);
  if (restoreFocus) restoreScriptListFocus();
}

function clearDiffNavigation(): void {
  diffHunkRows = [];
  currentDiffHunk = -1;
  diffNavigation.hidden = true;
  diffNavigationPosition.textContent = "No changes";
  previousDiffChange.disabled = true;
  nextDiffChange.disabled = true;
}

function setCurrentDiffHunk(index: number): void {
  if (index < 0 || index >= diffHunkRows.length || index === currentDiffHunk) return;
  for (const row of diffHunkRows[currentDiffHunk] ?? []) {
    row.classList.remove("diff-hunk-current");
  }
  currentDiffHunk = index;
  for (const row of diffHunkRows[index] ?? []) row.classList.add("diff-hunk-current");
  diffNavigationPosition.textContent = `Change ${index + 1} of ${diffHunkRows.length}`;
  previousDiffChange.disabled = index === 0;
  nextDiffChange.disabled = index === diffHunkRows.length - 1;
}

function updateDiffHunkFromScroll(): void {
  diffScrollUpdatePending = false;
  if (diffNavigation.hidden || diffHunkRows.length === 0) return;
  const navigationBottom = diffNavigation.getBoundingClientRect().bottom;
  const anchor = navigationBottom + (window.innerHeight - navigationBottom) / 2;
  let current = 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const [index, rows] of diffHunkRows.entries()) {
    const first = rows[0];
    const last = rows[rows.length - 1];
    if (first === undefined || last === undefined) continue;
    const top = first.getBoundingClientRect().top;
    const bottom = last.getBoundingClientRect().bottom;
    const distance = anchor < top ? top - anchor : anchor > bottom ? anchor - bottom : 0;
    if (distance >= closestDistance) continue;
    closestDistance = distance;
    current = index;
  }
  setCurrentDiffHunk(current);
}

function scheduleDiffHunkScrollUpdate(): void {
  if (diffScrollUpdatePending) return;
  diffScrollUpdatePending = true;
  requestAnimationFrame(updateDiffHunkFromScroll);
}

function scrollToDiffHunk(index: number): void {
  const row = diffHunkRows[index]?.[0];
  if (row === undefined) return;
  setCurrentDiffHunk(index);
  row.scrollIntoView({ behavior: "auto", block: "center" });
}

function comparisonScopeLabel(): string {
  const chapterLabel = chapter.selectedOptions[0]?.textContent?.trim() ?? chapter.value;
  const leftLabel = leftBuild.selectedOptions[0]?.textContent?.trim() ?? leftBuild.value;
  const rightLabel = rightBuild.selectedOptions[0]?.textContent?.trim() ?? rightBuild.value;
  return `${chapterLabel}: ${leftLabel} → ${rightLabel}`;
}

const scriptList = new CompareList({
  container: comparisonSections,
  filter: selectedKinds,
  sorting,
  copyButton: copyScriptListButton,
  copyScope: comparisonScopeLabel,
  scriptUrl: (script) => comparisonUrl(script.name),
  openScript: (script, trigger) => void showDiff(script, "push", trigger),
  preloadScript: preloadScriptSources,
});

async function loadComparison(): Promise<void> {
  comparisonLoadRequestId += 1;
  const loadRequestId = comparisonLoadRequestId;
  if (chapter.value === "") {
    activeRenumberTables = undefined;
    activeRenumberWarning = undefined;
    summary.textContent = "These releases do not share a chapter.";
    comparedScripts = [];
    scriptList.setScripts(comparedScripts);
    showScriptList();
    updateUrl();
    return;
  }
  summary.textContent = "Loading manifests…";
  comparisonSections.setAttribute("aria-busy", "true");
  const loading = document.createElement("p");
  loading.className = "comparison-loading";
  loading.textContent = "Loading script inventory…";
  comparisonSections.replaceChildren(loading);
  const [left, right, renumbering] = await Promise.all([
    fetchManifest(manifestUrl(catalog, chapter.value, leftBuild.value)),
    fetchManifest(manifestUrl(catalog, chapter.value, rightBuild.value)),
    renumberTables(),
  ]);
  if (loadRequestId !== comparisonLoadRequestId) return;
  activeRenumberTables = renumbering.tables;
  activeRenumberWarning = renumbering.warning;
  comparedScripts = compareManifests(left, right, activeRenumberTables);
  const counts = new Map<ChangeKind, number>([
    ["added", 0],
    ["removed", 0],
    ["changed", 0],
    ["renumbered", 0],
    ["unchanged", 0],
  ]);
  for (const script of comparedScripts) {
    counts.set(script.kind, (counts.get(script.kind) ?? 0) + 1);
  }
  const renumbered = counts.get("renumbered") ?? 0;
  const countSummary = [
    `${counts.get("changed")} changed`,
    `${counts.get("added")} added`,
    `${counts.get("removed")} removed`,
    ...(renumbered > 0 ? [`${renumbered} renumbered`] : []),
    `${counts.get("unchanged")} unchanged`,
  ].join(", ");
  summary.textContent =
    activeRenumberWarning === undefined
      ? countSummary
      : `${countSummary}. ${activeRenumberWarning}`;
  scriptList.setScripts(comparedScripts);
  const selected = comparedScripts.find((script) => script.name === selectedScriptName);
  if (selected === undefined) showScriptList();
  else void showDiff(selected);
  updateUrl();
}

function lines(source: string): string[] {
  return source === "" ? [] : source.split("\n");
}

function codeCell(html: string | undefined): HTMLTableCellElement {
  const cell = document.createElement("td");
  const code = document.createElement("code");
  code.innerHTML = html ?? "";
  cell.append(code);
  return cell;
}

function renderDiff(rows: HighlightedDiffRow[], viewRequestId: number): Promise<void> {
  diffBody.replaceChildren();
  clearDiffNavigation();
  const hunks = diffHunks(rows);
  const rowHunks = new Map<number, number>();
  for (const [hunkIndex, hunk] of hunks.entries()) {
    for (let rowIndex = hunk.start; rowIndex < hunk.end; rowIndex += 1) {
      rowHunks.set(rowIndex, hunkIndex);
    }
  }
  diffHunkRows = hunks.map(() => []);
  diffNavigation.hidden = hunks.length === 0;
  if (hunks.length > 0) {
    diffNavigationPosition.textContent = `Change 1 of ${hunks.length}`;
    previousDiffChange.disabled = true;
    nextDiffChange.disabled = hunks.length === 1;
  }
  const CHUNK_SIZE = 100;
  let index = 0;

  return new Promise((resolve) => {
    function renderChunk(): void {
      if (viewRequestId !== diffViewRequestId) {
        resolve();
        return;
      }
      const end = Math.min(index + CHUNK_SIZE, rows.length);
      const fragment = document.createDocumentFragment();
      for (; index < end; index += 1) {
        const row = rows[index];
        if (row === undefined) break;
        const element = document.createElement("tr");
        element.className = `diff-${row.kind}`;
        if (row.renumbering === true) element.classList.add("diff-renumbering");
        const hunkIndex = rowHunks.get(index);
        if (hunkIndex !== undefined) {
          diffHunkRows[hunkIndex]?.push(element);
          if (hunkIndex === currentDiffHunk) element.classList.add("diff-hunk-current");
        }
        const leftNumber = document.createElement("th");
        leftNumber.scope = "row";
        leftNumber.textContent = row.leftNumber?.toString() ?? "";
        const rightNumber = document.createElement("th");
        rightNumber.scope = "row";
        rightNumber.textContent = row.rightNumber?.toString() ?? "";
        element.append(leftNumber, codeCell(row.leftHtml), rightNumber, codeCell(row.rightHtml));
        fragment.append(element);
      }
      diffBody.append(fragment);
      if (index < rows.length) {
        requestAnimationFrame(renderChunk);
        return;
      }
      if (hunks.length > 0) {
        scrollToDiffHunk(0);
        scheduleDiffHunkScrollUpdate();
      }
      resolve();
    }

    renderChunk();
  });
}

async function showDiff(
  script: ComparedScript,
  historyMode?: "push" | "replace",
  trigger?: HTMLElement,
): Promise<void> {
  diffViewRequestId += 1;
  const viewRequestId = diffViewRequestId;
  if (trigger !== undefined) diffOrigin = trigger;
  selectedScriptName = script.name;
  updatePageTitle(script.name);
  scriptListSection.hidden = true;
  diffSection.hidden = false;
  diffSection.setAttribute("aria-busy", "true");
  diffTitle.textContent = `${script.name} (loading…)`;
  clearDiffNavigation();
  diffBody.replaceChildren();
  diffWarning.textContent = activeRenumberWarning ?? "";
  diffWarning.hidden = activeRenumberWarning === undefined;
  if (historyMode !== undefined) updateUrl(historyMode);
  else updateBackLink();
  if (trigger !== undefined) backToScripts.focus();
  try {
    const [before, after] = await Promise.all([
      script.left === undefined ? Promise.resolve("") : fetchSource(script.left.source),
      script.right === undefined ? Promise.resolve("") : fetchSource(script.right.source),
    ]);
    if (viewRequestId !== diffViewRequestId) return;
    const rows = await calculateDiff(lines(before), lines(after), activeRenumberTables);
    const { prefix, suffix } = scriptNameParts(script);
    if (viewRequestId !== diffViewRequestId) return;
    renderScriptName(diffTitle, prefix, suffix);
    await renderDiff(rows, viewRequestId);
    if (viewRequestId !== diffViewRequestId) return;
    diffSection.setAttribute("aria-busy", "false");
  } catch (error) {
    if (viewRequestId !== diffViewRequestId) return;
    diffSection.setAttribute("aria-busy", "false");
    diffTitle.textContent = script.name;
    const row = document.createElement("tr");
    const message = document.createElement("td");
    message.colSpan = 4;
    message.className = "diff-error";
    const alert = document.createElement("span");
    alert.setAttribute("role", "alert");
    alert.textContent = failureMessage(
      error,
      "Unable to load this diff. Check your connection and try again.",
    );
    message.append(alert);
    row.append(message);
    diffBody.replaceChildren(row);
  }
}

function showComparisonError(error: unknown): void {
  activeRenumberTables = undefined;
  activeRenumberWarning = undefined;
  comparedScripts = [];
  scriptList.clear();
  summary.textContent = failureMessage(
    error,
    "Unable to load this comparison. Check your connection and try again.",
  );
  comparisonSections.setAttribute("aria-busy", "false");
  const message = document.createElement("p");
  message.className = "comparison-empty";
  message.textContent = "Unable to load this comparison.";
  comparisonSections.replaceChildren(message);
  showScriptList();
}

function reloadComparison(): void {
  diffViewRequestId += 1;
  cancelDiff();
  const loadRequestId = comparisonLoadRequestId + 1;
  void loadComparison().catch((error: unknown) => {
    if (loadRequestId === comparisonLoadRequestId) showComparisonError(error);
  });
}

async function start(): Promise<void> {
  catalog = await fetchJson<Catalog>("/data/catalog.json");
  const parameters = new URLSearchParams(location.search);
  const preferredChapter = parameters.get("chapter") ?? undefined;
  const matchingBuilds =
    preferredChapter === undefined
      ? []
      : catalog.builds.filter((build) =>
          build.chapters.some((item) => item.id === preferredChapter),
        );
  const fallbackRight = matchingBuilds[0] ?? catalog.builds[0];
  const fallbackLeft =
    matchingBuilds[1] ?? catalog.builds.find((candidate) => candidate.id !== fallbackRight?.id);
  if (fallbackLeft === undefined || fallbackRight === undefined) {
    throw new Error("At least two releases are required for a comparison");
  }
  const buildIds = catalog.builds.map((build) => build.id);
  const fallbackPair = normalizeBuildPair(buildIds, fallbackLeft.id, fallbackRight.id);
  if (fallbackPair === undefined) throw new Error("Unable to choose two distinct releases");
  const requestedPair = normalizeBuildPair(
    buildIds,
    parameters.get("left") ?? undefined,
    parameters.get("right") ?? undefined,
  );
  const pair = requestedPair ?? fallbackPair;
  const options = catalog.builds.map((build) => ({
    value: build.id,
    label: build.label,
  }));
  replaceOptions(leftBuild, options, pair.earlier);
  replaceOptions(rightBuild, options, pair.later);
  updateBuildOptionStates(pair);
  leftBuild.disabled = false;
  rightBuild.disabled = false;
  applyKindFilter(parseKindFilter(parameters.get("filter")));
  const preferredSort = parameters.get("sort");
  sorting.value = [...sorting.options].some((option) => option.value === preferredSort)
    ? (preferredSort ?? "group")
    : "group";
  selectedScriptName = parameters.get("script") ?? undefined;
  updateChapterOptions(preferredChapter);
  chapter.disabled = chapter.options.length === 0;
  await loadComparison();
}

leftBuild.addEventListener("change", () => {
  selectedScriptName = undefined;
  updateBuildOptionStates({ earlier: leftBuild.value, later: rightBuild.value });
  updateChapterOptions(chapter.value);
  chapter.disabled = chapter.options.length === 0;
  reloadComparison();
});
rightBuild.addEventListener("change", () => {
  selectedScriptName = undefined;
  updateBuildOptionStates({ earlier: leftBuild.value, later: rightBuild.value });
  updateChapterOptions(chapter.value);
  chapter.disabled = chapter.options.length === 0;
  reloadComparison();
});
chapter.addEventListener("change", () => {
  selectedScriptName = undefined;
  reloadComparison();
});
filterKind.addEventListener("change", () => {
  scriptList.render();
  updateUrl();
});
sorting.addEventListener("change", () => {
  scriptList.render();
  updateUrl();
});
copyScriptListButton.addEventListener("click", () => {
  void scriptList.copy();
});
previousDiffChange.addEventListener("click", () => scrollToDiffHunk(currentDiffHunk - 1));
nextDiffChange.addEventListener("click", () => scrollToDiffHunk(currentDiffHunk + 1));
backToScripts.addEventListener("click", (event) => {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  showScriptList("push", true);
});
window.addEventListener("scroll", scheduleDiffHunkScrollUpdate, { passive: true });
diffScrollContainer.addEventListener("scroll", scheduleDiffHunkScrollUpdate, { passive: true });
window.addEventListener("popstate", () => {
  const requested = new URLSearchParams(location.search).get("script");
  const selected = comparedScripts.find((script) => script.name === requested);
  if (selected === undefined) showScriptList(undefined, !diffSection.hidden);
  else {
    const active = document.activeElement;
    const origin =
      active instanceof HTMLElement && scriptListSection.contains(active) ? active : undefined;
    void showDiff(selected, undefined, origin);
  }
});

bindOptionHints();
void start().catch((error: unknown) => {
  showComparisonError(error);
});
