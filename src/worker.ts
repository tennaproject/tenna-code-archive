/// <reference types="@cloudflare/workers-types" />

interface EmbedChapter {
  id: string;
  label: string;
}

interface EmbedScript {
  canonical: string;
  chapters: EmbedChapter[];
}

interface EmbedMap {
  schemaVersion: 1;
  scripts: Record<string, EmbedScript>;
}

interface Env {
  ASSETS: Fetcher;
}

const SITE_NAME = "Tenna Code Archive";
const SCRIPT_ROUTE = /^\/(?:[A-Za-z0-9._-]+\/)?(gml_[A-Za-z0-9_]+)(?:\.html)?$/;
const SCRIPT_PAGE = "/script.html";

let embedsPromise: Promise<EmbedMap> | undefined;

function loadEmbeds(env: Env, origin: string): Promise<EmbedMap> {
  embedsPromise ??= env.ASSETS.fetch(new URL("/data/embeds.json.gz", origin))
    .then((response) => {
      if (!response.ok) throw new Error(`Failed to load embed data: ${response.status}`);
      return response.body;
    })
    .then((body) => {
      if (body === null) throw new Error("Empty embed data");
      return new Response(body.pipeThrough(new DecompressionStream("gzip"))).json() as Promise<
        Record<string, unknown>
      >;
    })
    .then(parseEmbeds);
  return embedsPromise;
}

function parseEmbeds(value: Record<string, unknown>): EmbedMap {
  if (value.schemaVersion !== 1 || typeof value.scripts !== "object" || value.scripts === null) {
    throw new Error("Invalid embed data");
  }
  return value as unknown as EmbedMap;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setTitle(html: string, title: string): string {
  return html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
}

function setMeta(html: string, property: string, content: string): string {
  const tag = `<meta property="${property}" content="${escapeHtml(content)}">`;
  const existing = new RegExp(`<meta\\s+property="${property}"[^>]*>`);
  return existing.test(html)
    ? html.replace(existing, tag)
    : html.replace("</head>", `${tag}\n</head>`);
}

function setDescription(html: string, content: string): string {
  const tag = `<meta name="description" content="${escapeHtml(content)}">`;
  const existing = /<meta\s+name="description"[^>]*>/;
  return existing.test(html)
    ? html.replace(existing, tag)
    : html.replace("</head>", `${tag}\n</head>`);
}

function setCanonical(html: string, url: string): string {
  const tag = `<link rel="canonical" href="${escapeHtml(url)}">`;
  const existing = /<link\s+rel="canonical"[^>]*>/;
  return existing.test(html)
    ? html.replace(existing, tag)
    : html.replace("</head>", `${tag}\n</head>`);
}

function canonicalPath(script: EmbedScript, query: string): string {
  const name = encodeURIComponent(script.canonical);
  const first = script.chapters[0];
  if (script.chapters.length === 1 && first !== undefined) {
    return `/${encodeURIComponent(first.id)}/${name}.html${query}`;
  }
  return `/${name}.html${query}`;
}

function describe(script: EmbedScript): string {
  if (script.chapters.length === 0) return script.canonical;
  return `${script.canonical} - ${script.chapters.map((chapter) => chapter.label).join(", ")}`;
}

function enhance(html: string, script: EmbedScript, url: URL): string {
  const title = `${script.canonical} - ${SITE_NAME}`;
  const description = describe(script);
  const canonical = new URL(canonicalPath(script, url.search), url.origin).href;
  const image = new URL("/static/meta-banner.png", url.origin).href;

  let output = html;
  output = setTitle(output, title);
  output = setDescription(output, description);
  output = setMeta(output, "og:title", title);
  output = setMeta(output, "og:description", description);
  output = setMeta(output, "og:url", canonical);
  output = setMeta(output, "og:image", image);
  output = setMeta(output, "twitter:title", title);
  output = setMeta(output, "twitter:description", description);
  output = setMeta(output, "twitter:url", canonical);
  output = setMeta(output, "twitter:image", image);
  output = setCanonical(output, canonical);
  return output;
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: {
      "content-type": "text/html;charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

async function serveScriptPage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const page = await env.ASSETS.fetch(new URL(SCRIPT_PAGE, url.origin));
  if (!page.ok) return page;
  const html = await page.text();
  try {
    const embeds = await loadEmbeds(env, url.origin);
    const name = url.pathname.match(SCRIPT_ROUTE)?.[1];
    const script = name === undefined ? undefined : embeds.scripts[name];
    if (script === undefined) return htmlResponse(html);
    return htmlResponse(enhance(html, script, url));
  } catch (error) {
    console.error("Failed to enhance script page:", error);
    return htmlResponse(html);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "GET" && SCRIPT_ROUTE.test(new URL(request.url).pathname)) {
      return serveScriptPage(request, env);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
