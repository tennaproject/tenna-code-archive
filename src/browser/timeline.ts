import type {
  Build as TimelineRelease,
  Catalog as TimelineCatalog,
  Chapter as TimelineChapter,
  TimelineRelationship,
} from "../shared/catalog";
import { chapterReleases, fetchJson, manifestUrl } from "./archive-client";
import { bindHoverPopover } from "./hover-popover";
import { installLinkPrefetch } from "./prefetch";
import { element, failureMessage } from "./ui";

interface RevisionNode {
  release: TimelineRelease;
  releaseIndex: number;
  chapter: TimelineChapter;
}

const loading = element<HTMLElement>("timeline-loading");
const errorMessage = element<HTMLElement>("timeline-error");
const timeline = element<HTMLElement>("timeline-container");
const relationshipSummary = element<HTMLElement>("timeline-relationship-summary");
const timelineScroll = element<HTMLElement>("timeline-scroll");
const canvas = element<HTMLElement>("timeline-canvas");
const scrollbar = element<HTMLElement>("timeline-scrollbar");
const scrollbarTrack = element<HTMLElement>("timeline-scrollbar-track");
const panThreshold = 5;

interface PanGesture {
  pointerId: number;
  startX: number;
  startScrollLeft: number;
  dragging: boolean;
}

let panGesture: PanGesture | undefined;
let suppressNextClick = false;
let loadedCatalog: TimelineCatalog | undefined;

function finishPanning(event: PointerEvent, cancelled = false): void {
  if (panGesture?.pointerId !== event.pointerId) return;
  const dragged = panGesture.dragging;
  panGesture = undefined;
  timelineScroll.classList.remove("is-dragging");
  if (timelineScroll.hasPointerCapture(event.pointerId)) {
    timelineScroll.releasePointerCapture(event.pointerId);
  }
  if (!cancelled && dragged) {
    suppressNextClick = true;
    window.setTimeout(() => {
      suppressNextClick = false;
    });
  }
}

timelineScroll.addEventListener("pointerdown", (event) => {
  if (event.pointerType !== "mouse" || event.button !== 0 || !event.isPrimary) {
    return;
  }
  suppressNextClick = false;
  panGesture = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startScrollLeft: timelineScroll.scrollLeft,
    dragging: false,
  };
});

timelineScroll.addEventListener("pointermove", (event) => {
  if (panGesture?.pointerId !== event.pointerId) return;
  if ((event.buttons & 1) === 0) {
    finishPanning(event);
    return;
  }
  const deltaX = event.clientX - panGesture.startX;
  if (!panGesture.dragging) {
    if (Math.abs(deltaX) < panThreshold) return;
    panGesture.dragging = true;
    timelineScroll.classList.add("is-dragging");
    timelineScroll.setPointerCapture(event.pointerId);
  }
  event.preventDefault();
  timelineScroll.scrollLeft = panGesture.startScrollLeft - deltaX;
  window.getSelection()?.removeAllRanges();
});

window.addEventListener("pointerup", (event) => finishPanning(event));
window.addEventListener("pointercancel", (event) => finishPanning(event, true));
timelineScroll.addEventListener("dragstart", (event) => event.preventDefault());
timelineScroll.addEventListener(
  "click",
  (event) => {
    if (!suppressNextClick) return;
    suppressNextClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  },
  true,
);

function formatDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const isoDate = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (isoDate !== undefined) return isoDate;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toISOString().slice(0, 10);
}

function shortRevision(revision: string): string {
  return revision.slice(0, 12);
}

function tooltip(title: string, details: string): HTMLElement {
  const result = document.createElement("span");
  result.className = "timeline-tooltip";
  result.setAttribute("role", "tooltip");

  const heading = document.createElement("strong");
  heading.textContent = title;
  const copy = document.createElement("span");
  copy.textContent = details;
  result.append(heading, copy);
  return result;
}

function releaseAxis(releases: TimelineRelease[]): HTMLElement {
  const axis = document.createElement("div");
  axis.className = "timeline-axis";
  axis.setAttribute("role", "row");

  const axisLabel = document.createElement("div");
  axisLabel.className = "timeline-axis-label";
  axisLabel.setAttribute("role", "columnheader");
  const label = document.createElement("span");
  label.className = "section-label";
  label.textContent = "Release date";
  axisLabel.append(label);

  const releaseCells = document.createElement("div");
  releaseCells.className = "timeline-releases";
  releaseCells.setAttribute("role", "row");
  for (const item of releases) {
    const release = document.createElement("div");
    release.className = "timeline-release";
    release.setAttribute("role", "columnheader");
    const name = document.createElement("strong");
    name.textContent = formatDate(item.publishedAt) ?? item.label;
    release.title = item.label;
    release.append(name);
    releaseCells.append(release);
  }

  axis.append(axisLabel, releaseCells);
  return axis;
}

function revisionNodes(chapterId: string, releases: TimelineRelease[]): RevisionNode[] {
  const nodes: RevisionNode[] = [];
  let priorAvailableRevision: string | undefined;

  releases.forEach((release, releaseIndex) => {
    const chapter = release.chapters.find((item) => item.id === chapterId);
    if (chapter === undefined) return;
    if (priorAvailableRevision === undefined || chapter.revision !== priorAvailableRevision) {
      nodes.push({ release, releaseIndex, chapter });
    }
    priorAvailableRevision = chapter.revision;
  });

  return nodes;
}

function trackCells(releases: TimelineRelease[]): HTMLElement[] {
  return releases.map((release) => {
    const cell = document.createElement("span");
    cell.className = "timeline-track-cell";
    cell.setAttribute("aria-hidden", "true");
    cell.title = release.label;
    return cell;
  });
}

function manifestHint(chapterId: string, releaseId: string): string | undefined {
  if (loadedCatalog === undefined) return undefined;
  const releases = chapterReleases(loadedCatalog, chapterId);
  const isDefaultRelease = releases[0]?.id === releaseId;
  try {
    return manifestUrl(loadedCatalog, chapterId, isDefaultRelease ? undefined : releaseId);
  } catch {
    return undefined;
  }
}

function nodeLink(node: RevisionNode): HTMLAnchorElement {
  const { release, releaseIndex, chapter } = node;
  const revision = shortRevision(chapter.revision);
  const details = [formatDate(release.publishedAt) ?? release.label, `Revision ${revision}`]
    .filter(Boolean)
    .join(" - ");
  const description = [
    chapter.label,
    release.label,
    chapter.gameVersion === undefined ? undefined : `version ${chapter.gameVersion}`,
    `revision ${revision}`,
  ]
    .filter((value): value is string => value !== undefined)
    .join(", ");

  const link = document.createElement("a");
  link.className = "timeline-node";
  link.href = `/${encodeURIComponent(chapter.id)}/?build=${encodeURIComponent(release.id)}`;
  const hint = manifestHint(chapter.id, release.id);
  if (hint !== undefined) link.dataset.prefetch = hint;
  link.style.setProperty("--release-index", releaseIndex.toString());
  link.setAttribute("aria-label", `Open ${description}`);

  const square = document.createElement("span");
  square.className = "timeline-node-square";
  square.setAttribute("aria-hidden", "true");
  const version = document.createElement("small");
  version.className = "timeline-node-version";
  version.textContent = chapter.gameVersion ?? "-";
  version.setAttribute("aria-hidden", "true");
  const preview = tooltip(release.label, details);
  link.append(square, version, preview);
  bindHoverPopover(link, preview, { placement: "top" });
  return link;
}

function connectorLink(older: RevisionNode, newer: RevisionNode): HTMLAnchorElement {
  const parameters = new URLSearchParams([
    ["chapter", older.chapter.id],
    ["left", older.release.id],
    ["right", newer.release.id],
  ]);
  const description = `Compare ${older.chapter.label} from ${older.release.label} with ${newer.release.label}`;
  const revisions = `${shortRevision(older.chapter.revision)} -> ${shortRevision(newer.chapter.revision)}`;

  const link = document.createElement("a");
  link.className = "timeline-connector";
  link.href = `/compare.html?${parameters.toString()}`;
  link.style.setProperty("--from-index", older.releaseIndex.toString());
  link.style.setProperty("--to-index", newer.releaseIndex.toString());
  link.setAttribute("aria-label", description);
  const preview = tooltip("Compare revisions", revisions);
  link.append(preview);
  bindHoverPopover(link, preview, { placement: "top" });
  return link;
}

function chapterRow(
  chapterId: string,
  chapterLabel: string,
  releases: TimelineRelease[],
): HTMLElement {
  const row = document.createElement("section");
  row.className = "timeline-row";
  row.setAttribute("role", "row");

  const heading = document.createElement("h2");
  heading.className = "timeline-chapter";
  heading.setAttribute("role", "rowheader");
  heading.textContent = chapterLabel;

  const track = document.createElement("div");
  track.className = "timeline-track";
  track.setAttribute("role", "cell");
  track.append(...trackCells(releases));

  const nodes = revisionNodes(chapterId, releases);
  for (let index = 1; index < nodes.length; index += 1) {
    const older = nodes[index - 1];
    const newer = nodes[index];
    if (older !== undefined && newer !== undefined) {
      track.append(connectorLink(older, newer));
    }
  }
  track.append(...nodes.map(nodeLink));
  row.append(heading, track);
  return row;
}

function relationshipOverlay(
  relationships: TimelineRelationship[],
  chapters: Map<string, string>,
  releases: TimelineRelease[],
): SVGSVGElement | undefined {
  const chapterIds = [...chapters.keys()];
  const paths: string[] = [];

  for (const relationship of relationships) {
    if (relationship.kind !== "shared-source") continue;
    const sourceRow = chapterIds.indexOf(relationship.sourceChapter);
    const source = revisionNodes(relationship.sourceChapter, releases).at(-1);
    if (sourceRow < 0 || source === undefined) continue;

    const targets = relationship.targetChapters
      .map((chapterId) => ({
        row: chapterIds.indexOf(chapterId),
        node: revisionNodes(chapterId, releases)[0],
      }))
      .filter(
        (
          target,
        ): target is {
          row: number;
          node: RevisionNode;
        } =>
          target.row >= 0 &&
          target.node !== undefined &&
          target.node.releaseIndex > source.releaseIndex,
      );
    if (targets.length === 0) continue;

    const sourceX = source.releaseIndex + 0.5;
    const sourceY = sourceRow + 0.5;
    const firstTargetX = Math.min(...targets.map(({ node }) => node.releaseIndex + 0.5));
    const forkX = Math.min(sourceX + 0.6, (sourceX + firstTargetX) / 2);
    paths.push(`M ${sourceX} ${sourceY} H ${forkX}`);
    for (const { row, node } of targets) {
      const targetX = node.releaseIndex + 0.5;
      const targetY = row + 0.5;
      paths.push(`M ${forkX} ${sourceY} V ${targetY} H ${targetX}`);
    }
  }

  if (paths.length === 0) return undefined;
  const overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  overlay.classList.add("timeline-relationships");
  overlay.setAttribute("viewBox", `0 0 ${releases.length} ${chapters.size}`);
  overlay.setAttribute("preserveAspectRatio", "none");
  overlay.setAttribute("aria-hidden", "true");
  for (const pathData of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    path.setAttribute("vector-effect", "non-scaling-stroke");
    overlay.append(path);
  }
  return overlay;
}

function render(catalog: TimelineCatalog): void {
  if (!Array.isArray(catalog.builds) || catalog.builds.length === 0) {
    throw new Error("The release catalog is empty");
  }
  loadedCatalog = catalog;

  const releases = [...catalog.builds].reverse();
  const chapters = new Map<string, string>();
  for (const release of releases) {
    for (const chapter of release.chapters) chapters.set(chapter.id, chapter.label);
  }
  const relationships = (catalog.timelineRelationships ?? []).filter(
    ({ sourceChapter, targetChapters }) =>
      chapters.has(sourceChapter) && targetChapters.some((chapterId) => chapters.has(chapterId)),
  );

  canvas.style.setProperty("--release-count", releases.length.toString());
  canvas.style.setProperty("--timeline-row-count", chapters.size.toString());
  canvas.setAttribute("aria-label", `${catalog.game} release timeline`);
  const rows = [...chapters].map(([id, label]) => chapterRow(id, label, releases));
  const relationshipGraphic = relationshipOverlay(relationships, chapters, releases);
  const empty = document.createElement("p");
  empty.className = "timeline-empty";
  empty.textContent = "No chapters are available in this catalog.";
  canvas.replaceChildren(
    releaseAxis(releases),
    ...(rows.length > 0 ? rows : [empty]),
    ...(relationshipGraphic === undefined ? [] : [relationshipGraphic]),
  );
  relationshipSummary.textContent = relationships.map(({ label }) => label).join(" ");
  loading.hidden = true;
  timeline.hidden = false;
  requestAnimationFrame(() => {
    timelineScroll.scrollLeft = timelineScroll.scrollWidth;
    syncScrollbarWidth();
  });
}

function syncScrollbarWidth(): void {
  scrollbarTrack.style.width = `${timelineScroll.scrollWidth}px`;
  scrollbar.scrollLeft = timelineScroll.scrollLeft;
  scrollbar.hidden = timelineScroll.scrollWidth <= timelineScroll.clientWidth;
}

function syncRelationshipClip(): void {
  canvas.style.setProperty(
    "--timeline-relationship-clip-start",
    `${Math.max(0, timelineScroll.scrollLeft)}px`,
  );
}

let syncingScroll = false;

function mirrorScroll(from: HTMLElement, to: HTMLElement): void {
  if (syncingScroll) return;
  syncingScroll = true;
  to.scrollLeft = from.scrollLeft;
  requestAnimationFrame(() => {
    syncingScroll = false;
  });
}

timelineScroll.addEventListener("scroll", () => {
  syncRelationshipClip();
  mirrorScroll(timelineScroll, scrollbar);
});
scrollbar.addEventListener("scroll", () => {
  mirrorScroll(scrollbar, timelineScroll);
});
new ResizeObserver(syncScrollbarWidth).observe(timelineScroll);

installLinkPrefetch();

void fetchJson<TimelineCatalog>("/data/catalog.json")
  .then(render)
  .catch((error: unknown) => {
    loading.hidden = true;
    errorMessage.textContent = failureMessage(
      error,
      "Unable to load the release timeline. Check your connection and reload the page.",
    );
    errorMessage.hidden = false;
  });
