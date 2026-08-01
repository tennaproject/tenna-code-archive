import { highlightAnnotatedHtml } from "../gml/highlight";

self.addEventListener("message", (event: MessageEvent<string[]>) => {
  const lines = event.data;
  self.postMessage(lines.map((line) => highlightAnnotatedHtml(line)));
});
