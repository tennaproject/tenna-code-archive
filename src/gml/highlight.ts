import hljs from "@highlightjs/cdn-assets/es/core.js";
import gml from "@highlightjs/cdn-assets/es/languages/gml.min.js";

hljs.registerLanguage("gml", gml);

export function highlightGml(source: string): string {
  return hljs.highlight(source, { language: "gml" }).value;
}

export function highlightAnnotatedHtml(html: string): string {
  let result = "";
  let codeDepth = 0;
  let preHighlightedDepth = 0;

  for (const chunk of html.split(/(<[^>]+>)/)) {
    if (chunk.startsWith("<")) {
      if (/^<code(?:\s|>)/.test(chunk)) {
        codeDepth += 1;
      } else if (chunk === "</code>") {
        codeDepth = Math.max(0, codeDepth - 1);
      }

      if (chunk.startsWith("<span") && chunk.includes("skip-highlight")) {
        preHighlightedDepth = 1;
      } else if (preHighlightedDepth !== 0) {
        if (chunk.startsWith("<span")) {
          preHighlightedDepth += 1;
        } else if (chunk === "</span>") {
          preHighlightedDepth -= 1;
        }
      }

      result += chunk;
      continue;
    }

    if (codeDepth === 0 || preHighlightedDepth !== 0) {
      result += chunk;
      continue;
    }

    if (chunk.trim() === "") {
      result += chunk;
      continue;
    }

    const decoded = chunk.replace(
      /&amp;|&lt;|&gt;/g,
      (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">" })[entity] ?? entity,
    );
    result += highlightGml(decoded);
  }

  return result;
}
