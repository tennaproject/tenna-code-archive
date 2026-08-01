declare module "@highlightjs/cdn-assets/es/core.js" {
  interface HighlightResult {
    value: string;
  }

  interface HighlightJs {
    highlight(code: string, options: { language: string }): HighlightResult;
    registerLanguage(name: string, language: (hljs: HighlightJs) => unknown): void;
  }

  const hljs: HighlightJs;
  export default hljs;
}

declare module "@highlightjs/cdn-assets/es/languages/gml.min.js" {
  import type hljs from "@highlightjs/cdn-assets/es/core.js";
  const language: (instance: typeof hljs) => unknown;
  export default language;
}
