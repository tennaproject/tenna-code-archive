import type { SearchHit, SearchRequest, SearchResponse } from "./search-types";
import { bindOptionHints } from "./option-hints";
import { element, failureMessage, workerUrl } from "./ui";

const form = element<HTMLFormElement>("search-form");
const resultsSection = element<HTMLElement>("search-results");
const resultsBody = element<HTMLTableSectionElement>("search-hits");
const status = element<HTMLElement>("search-status");
const worker = new Worker(workerUrl("searchWorker"), { type: "module" });
const pending = new Map<
  number,
  {
    resolve: (response: SearchResponse) => void;
    reject: (error: Error) => void;
  }
>();
let nextRequestId = 0;
let latestSubmissionId = 0;
let workerFailure: Error | undefined;

function isCurrentSearch(
  submissionId: number,
  releaseSelect: HTMLSelectElement,
  releaseId: string,
  searchUrl: string,
): boolean {
  return (
    submissionId === latestSubmissionId &&
    releaseSelect.value.trim() === releaseId &&
    releaseSelect.dataset.searchUrl?.trim() === searchUrl
  );
}

function runSearch(request: Omit<SearchRequest, "id">): Promise<SearchResponse> {
  if (workerFailure !== undefined) return Promise.reject(workerFailure);

  nextRequestId += 1;
  const id = nextRequestId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...request } satisfies SearchRequest);
  });
}

worker.addEventListener("message", (event: MessageEvent<SearchResponse>) => {
  const request = pending.get(event.data.id);
  if (request === undefined) return;
  pending.delete(event.data.id);
  request.resolve(event.data);
});

worker.addEventListener("error", (event) => {
  workerFailure =
    event.error instanceof Error ? event.error : new Error(event.message || "Search worker failed");
  for (const request of pending.values()) request.reject(workerFailure);
  pending.clear();
});

function fileHeader(file: string, fileUrl: string): HTMLTableRowElement {
  const row = document.createElement("tr");
  row.className = "table-subsection-header";
  const heading = document.createElement("th");
  heading.colSpan = 2;
  heading.scope = "rowgroup";
  const link = document.createElement("a");
  link.href = fileUrl;
  link.textContent = file.replace(/\.gml$/, "");
  heading.append(link);
  row.append(heading);
  return row;
}

function hitRow(hit: SearchHit, fileUrl: string): HTMLTableRowElement {
  const row = document.createElement("tr");
  row.className = "table-subsection-content";
  const lineNumber = document.createElement("th");
  lineNumber.scope = "row";
  const link = document.createElement("a");
  link.href = `${fileUrl}#L${hit.index}`;
  link.textContent = hit.index.toString();
  lineNumber.append(link);
  const source = document.createElement("td");
  source.innerHTML = hit.html;
  row.append(lineNumber, source);
  return row;
}

function renderResults(results: SearchResponse["results"], releaseId: string | undefined): void {
  const fragment = document.createDocumentFragment();
  for (const [file, hits] of Object.entries(results)) {
    const fileUrl =
      releaseId === undefined
        ? `${file}.html`
        : `${file}.html?build=${encodeURIComponent(releaseId)}`;
    fragment.append(fileHeader(file, fileUrl));
    for (const hit of hits) fragment.append(hitRow(hit, fileUrl));
  }
  resultsBody.replaceChildren(fragment);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  latestSubmissionId += 1;
  const submissionId = latestSubmissionId;
  const formData = new FormData(form);
  const term = String(formData.get("search") ?? "");

  resultsSection.classList.remove("hidden");
  resultsSection.setAttribute("aria-busy", "true");
  resultsBody.replaceChildren();

  if (term === "") {
    status.textContent = "Enter a search term.";
    resultsSection.setAttribute("aria-busy", "false");
    return;
  }

  const releaseSelect = document.getElementById("chapter-release") as HTMLSelectElement | null;
  const releaseId = releaseSelect?.value.trim() || undefined;
  const defaultReleaseId = releaseSelect?.dataset.defaultRelease?.trim() || undefined;
  const releaseQuery =
    releaseId === undefined || releaseId === defaultReleaseId ? undefined : releaseId;
  const searchUrl = releaseSelect?.dataset.searchUrl?.trim() || undefined;
  if (releaseSelect === null || releaseId === undefined || searchUrl === undefined) {
    status.textContent = "Search is still loading.";
    resultsSection.setAttribute("aria-busy", "false");
    return;
  }

  status.textContent = "Searching…";
  void runSearch({
    term,
    findAll: formData.get("find-all") === "on",
    isRegex: formData.get("is-regex") === "on",
    caseSensitive: formData.get("case-sensitive") === "on",
    indexUrl: new URL(searchUrl, location.origin).href,
  })
    .then((response) => {
      if (!isCurrentSearch(submissionId, releaseSelect, releaseId, searchUrl)) return;

      resultsSection.setAttribute("aria-busy", "false");
      if (response.error !== undefined) {
        status.textContent = response.error;
        return;
      }
      if (response.numHits === 0) {
        status.textContent = `No matches for “${term}”. Try a shorter term, or turn off “Case sensitive”.`;
        return;
      }

      status.textContent = response.overflow
        ? `Showing the first ${response.numHits} results. Enable “Find all” to see every match.`
        : `Found ${response.numHits} results.`;
      renderResults(response.results, releaseQuery);
    })
    .catch((error: unknown) => {
      if (!isCurrentSearch(submissionId, releaseSelect, releaseId, searchUrl)) return;
      resultsSection.setAttribute("aria-busy", "false");
      status.textContent = failureMessage(
        error,
        "Unable to finish the search. Try again in a moment.",
      );
    });
});

bindOptionHints();
