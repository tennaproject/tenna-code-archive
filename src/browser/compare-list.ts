import type { SectionType } from "../shared/viewer";
import {
  changeLabel,
  formatScriptListForCopy,
  scriptNameParts,
  type ChangeKind,
  type ComparedScript,
  type KindFilter,
} from "./compare-scripts";
import { renderScriptName, sectionName } from "./ui";

const INITIAL_BATCH_SIZE = 120;
const BATCH_SIZE = 240;
const CHANGE_RANK: Record<ChangeKind, number> = {
  changed: 0,
  added: 1,
  removed: 2,
  renumbered: 3,
  unchanged: 4,
};

interface CompareListOptions {
  container: HTMLElement;
  filter(): KindFilter;
  sorting: HTMLSelectElement;
  copyButton: HTMLButtonElement;
  copyScope(): string;
  scriptUrl(script: ComparedScript): string;
  openScript(script: ComparedScript, trigger: HTMLAnchorElement): void;
  preloadScript(script: ComparedScript): void;
}

function scriptType(script: ComparedScript): SectionType {
  return script.left?.type ?? script.right?.type ?? "script";
}

function scriptGroup(script: ComparedScript): string {
  return script.left?.group ?? script.right?.group ?? "";
}

function lineDelta(script: ComparedScript): number {
  return (script.right?.lines ?? 0) - (script.left?.lines ?? 0);
}

export class CompareList {
  private scripts: ComparedScript[] = [];
  private renderId = 0;
  private observer?: IntersectionObserver;

  constructor(private readonly options: CompareListOptions) {}

  clear(): void {
    this.scripts = [];
    this.renderId += 1;
    this.observer?.disconnect();
    this.observer = undefined;
    this.options.copyButton.disabled = true;
  }

  setScripts(scripts: ComparedScript[]): void {
    this.scripts = scripts;
    this.render();
  }

  private visibleScripts(): ComparedScript[] {
    const filter = this.options.filter();
    return this.scripts.filter((script) => filter.has(script.kind));
  }

  private compareScripts(left: ComparedScript, right: ComparedScript): number {
    let difference: number;
    switch (this.options.sorting.value) {
      case "changes":
        difference = CHANGE_RANK[left.kind] - CHANGE_RANK[right.kind];
        break;
      case "line-change":
        difference =
          Math.abs((right.right?.lines ?? 0) - (right.left?.lines ?? 0)) -
          Math.abs((left.right?.lines ?? 0) - (left.left?.lines ?? 0));
        break;
      case "earlier-lines":
        difference = (right.left?.lines ?? 0) - (left.left?.lines ?? 0);
        break;
      case "later-lines":
        difference = (right.right?.lines ?? 0) - (left.right?.lines ?? 0);
        break;
      case "group":
      default:
        difference = scriptGroup(left).localeCompare(scriptGroup(right));
        break;
    }
    return (
      difference ||
      scriptGroup(left).localeCompare(scriptGroup(right)) ||
      left.name.localeCompare(right.name)
    );
  }

  private scriptRow(script: ComparedScript): HTMLTableRowElement {
    const row = document.createElement("tr");
    row.className = `table-subsection-content comparison-${script.kind}`;
    const status = document.createElement("td");
    status.textContent = changeLabel(script.kind);
    const name = document.createElement("td");
    const link = document.createElement("a");
    link.href = this.options.scriptUrl(script);
    const { prefix, suffix } = scriptNameParts(script);
    renderScriptName(link, prefix, suffix);
    link.addEventListener("click", (event) => {
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
      this.options.openScript(script, link);
    });
    let preloadTimer: number | undefined;
    link.addEventListener("pointerenter", () => {
      preloadTimer = window.setTimeout(() => this.options.preloadScript(script), 120);
    });
    link.addEventListener("pointerleave", () => {
      window.clearTimeout(preloadTimer);
    });
    link.addEventListener("focus", () => this.options.preloadScript(script));
    name.append(link);
    const leftLines = document.createElement("td");
    leftLines.textContent = script.left?.lines.toString() ?? "-";
    const rightLines = document.createElement("td");
    rightLines.textContent = script.right?.lines.toString() ?? "-";
    const lineChange = document.createElement("td");
    const delta = lineDelta(script);
    lineChange.className = `line-delta ${
      delta > 0 ? "line-delta-positive" : delta < 0 ? "line-delta-negative" : "line-delta-neutral"
    }`;
    lineChange.textContent = delta > 0 ? `+${delta}` : delta.toString();
    lineChange.setAttribute(
      "aria-label",
      delta > 0
        ? `${delta} more lines`
        : delta < 0
          ? `${Math.abs(delta)} fewer lines`
          : "No line change",
    );
    row.append(status, name, leftLines, rightLines, lineChange);
    return row;
  }

  render(): void {
    this.renderId += 1;
    const renderId = this.renderId;
    this.observer?.disconnect();
    this.observer = undefined;

    const visible = this.visibleScripts();
    const byType = new Map<SectionType, ComparedScript[]>();
    for (const script of visible) {
      const type = scriptType(script);
      const list = byType.get(type) ?? [];
      list.push(script);
      byType.set(type, list);
    }

    const content: HTMLElement[] = [];
    const lazyBatches = new Map<Element, () => void>();
    for (const type of ["script", "object", "roomcc", "room"] as const) {
      const scripts = byType.get(type);
      if (scripts === undefined || scripts.length === 0) continue;
      const sortedScripts = scripts.slice().sort((left, right) => this.compareScripts(left, right));

      const heading = document.createElement("h2");
      heading.className = "section-label";
      heading.textContent = sectionName(type);
      const table = document.createElement("table");
      table.className = `inventory-table ${type}`;
      const colgroup = document.createElement("colgroup");
      colgroup.innerHTML =
        '<col class="inventory-col-status" /><col class="inventory-col-name" /><col class="inventory-col-lines" /><col class="inventory-col-lines" /><col class="inventory-col-lines" />';
      const head = document.createElement("thead");
      head.innerHTML =
        '<tr><th scope="col">Status</th><th scope="col">Script</th><th scope="col">Earlier lines</th><th scope="col">Later lines</th><th scope="col">Line change</th></tr>';
      const body = document.createElement("tbody");
      table.append(colgroup, head, body);

      let priorGroup: string | undefined;
      const showGroupHeadings = this.options.sorting.value === "group";
      let index = 0;
      const appendBatch = (size: number): void => {
        if (renderId !== this.renderId) return;
        const end = Math.min(index + size, sortedScripts.length);
        const fragment = document.createDocumentFragment();
        for (; index < end; index += 1) {
          const script = sortedScripts[index];
          if (script === undefined) break;
          if (showGroupHeadings) {
            const group = scriptGroup(script);
            if (group !== priorGroup) {
              if (group !== "") {
                const groupRow = document.createElement("tr");
                groupRow.className = "table-subsection-header";
                const groupCell = document.createElement("th");
                groupCell.colSpan = 5;
                groupCell.scope = "rowgroup";
                groupCell.textContent = group;
                groupRow.append(groupCell);
                fragment.append(groupRow);
              }
              priorGroup = group;
            }
          }
          fragment.append(this.scriptRow(script));
        }
        body.append(fragment);
      };
      appendBatch(INITIAL_BATCH_SIZE);

      content.push(heading, table);
      if (index < sortedScripts.length) {
        const sentinel = document.createElement("div");
        sentinel.className = "script-list-sentinel";
        sentinel.textContent = `Loading more ${sectionName(type).toLowerCase()} as you scroll…`;
        content.push(sentinel);
        lazyBatches.set(sentinel, () => {
          appendBatch(BATCH_SIZE);
          if (index >= sortedScripts.length) {
            this.observer?.unobserve(sentinel);
            sentinel.remove();
          }
        });
      }
    }

    if (content.length === 0) {
      const empty = document.createElement("p");
      empty.className = "comparison-empty";
      empty.textContent =
        this.options.filter().size === 0
          ? "Select at least one change kind to show scripts."
          : "No scripts match these filters. Select more change kinds to widen the list.";
      content.push(empty);
    }
    this.options.container.replaceChildren(...content);
    this.options.container.setAttribute("aria-busy", "false");
    this.options.copyButton.disabled = visible.length === 0;
    if (lazyBatches.size === 0) return;

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || renderId !== this.renderId) continue;
          lazyBatches.get(entry.target)?.();
        }
      },
      { rootMargin: "1000px 0px" },
    );
    for (const sentinel of lazyBatches.keys()) this.observer.observe(sentinel);
  }

  async copy(): Promise<void> {
    const text = formatScriptListForCopy(
      this.visibleScripts(),
      this.options.copyScope(),
      this.options.filter(),
    );
    let copied = false;
    if (navigator.clipboard?.writeText !== undefined) {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        copied = false;
      }
    }
    if (!copied) {
      const priorFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.className = "visually-hidden";
      document.body.append(area);
      area.focus({ preventScroll: true });
      area.select();
      try {
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      } finally {
        area.remove();
        priorFocus?.focus({ preventScroll: true });
      }
    }

    const button = this.options.copyButton;
    const original = button.textContent;
    button.textContent = copied ? "Copied!" : "Copy failed";
    button.disabled = true;
    window.setTimeout(() => {
      button.textContent = original;
      button.disabled = this.visibleScripts().length === 0;
    }, 1500);
  }
}
