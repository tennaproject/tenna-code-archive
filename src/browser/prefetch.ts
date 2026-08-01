const HOVER_DELAY_MS = 120;
const MAX_WARMED = 64;

interface NetworkInformation {
  saveData?: boolean;
  effectiveType?: string;
}

const warmed = new Set<string>();
let hoverTimer: number | undefined;

function conserving(): boolean {
  const connection = (navigator as Navigator & { connection?: NetworkInformation }).connection;
  if (connection === undefined) return false;
  return connection.saveData === true || /(^|-)2g$/.test(connection.effectiveType ?? "");
}

// Safari apparently hates prefetch
function warmData(url: string): void {
  if (warmed.has(url)) return;
  if (warmed.size >= MAX_WARMED) warmed.clear();
  warmed.add(url);
  // I have no idea why there are no type definitions for this
  const init: RequestInit & { priority?: "high" | "low" | "auto" } = {
    priority: "low",
  };
  void fetch(url, init).catch(() => {
    warmed.delete(url);
  });
}

function warmLink(link: HTMLAnchorElement): void {
  const data = link.dataset.prefetch;
  if (data !== undefined && data !== "") warmData(data);
}

function anchorFrom(target: EventTarget | null): HTMLAnchorElement | undefined {
  if (!(target instanceof Element)) return undefined;
  return target.closest("a[href]") ?? undefined;
}

export function installLinkPrefetch(): void {
  if (document.documentElement.dataset.linkPrefetch === "on") return;
  document.documentElement.dataset.linkPrefetch = "on";
  if (conserving()) return;

  document.addEventListener("pointerover", (event) => {
    // I do not really think someone is going to use it on mobile
    // but this prevents warming while scrolling past links
    if (event.pointerType === "touch") return;
    const link = anchorFrom(event.target);
    if (link === undefined) return;
    window.clearTimeout(hoverTimer);
    hoverTimer = window.setTimeout(() => {
      warmLink(link);
    }, HOVER_DELAY_MS);
  });

  document.addEventListener("pointerout", () => {
    window.clearTimeout(hoverTimer);
  });

  // Handle keyboard navigation, maybe overkill (maybe more than maybe)
  document.addEventListener("focusin", (event) => {
    const link = anchorFrom(event.target);
    if (link !== undefined) warmLink(link);
  });
}
