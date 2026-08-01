import { fetchCompressedJson } from "./archive-client";
import { highlightGml } from "../gml/highlight";
import { PromiseLruCache } from "./promise-cache";
import type { SearchHit, SearchRequest, SearchResponse } from "./search-types";

const HIT_LIMIT = 100;
const indexCache = new PromiseLruCache<Record<string, string[]>>(4);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadSearchIndex(url: string): Promise<Record<string, string[]>> {
  return indexCache.get(url, () => fetchCompressedJson<Record<string, string[]>>(url));
}

function search(
  index: Record<string, string[]>,
  term: string,
  options: { findAll: boolean; isRegex: boolean; caseSensitive: boolean },
): Omit<SearchResponse, "id"> {
  const results: Record<string, SearchHit[]> = {};
  let numHits = 0;
  const regexContent = options.isRegex ? term : escapeRegExp(term);
  const regexFlags = options.caseSensitive ? "u" : "iu";
  const regex = new RegExp(regexContent, regexFlags);

  for (const [file, lines] of Object.entries(index)) {
    for (const [lineIndex, line] of lines.entries()) {
      if (!regex.test(line)) continue;
      if (numHits === HIT_LIMIT && !options.findAll) {
        return { numHits, overflow: true, results };
      }
      const hits = results[file] ?? [];
      hits.push({
        html: highlightGml(line),
        index: lineIndex + 1,
      });
      results[file] = hits;
      numHits += 1;
    }
  }
  return { numHits, overflow: false, results };
}

self.addEventListener("message", (event: MessageEvent<SearchRequest>) => {
  const { id, ...request } = event.data;
  void (async () => {
    try {
      const index = await loadSearchIndex(request.indexUrl);
      const result = search(index, request.term, request);
      const response: SearchResponse = { id, ...result };
      self.postMessage(response);
    } catch (error) {
      const response: SearchResponse = {
        id,
        numHits: 0,
        overflow: false,
        results: {},
        error: error instanceof Error ? error.message : String(error),
      };
      self.postMessage(response);
    }
  })();
});
