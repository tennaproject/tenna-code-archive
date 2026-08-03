import type { DeltaruneData } from "../game-data";
import type { TemplateRenderer } from "../platform/templates";
import type { AssetKind, AssetTables } from "../shared/renumbering";
import { scanSourceLine, scanSourceLines, type SourceScan } from "../shared/source-scanner";
import { classify } from "./indexer";

type ScriptText = Map<string, string[]>;

export interface AnnotationContext {
  data: DeltaruneData;
  renderTemplate: TemplateRenderer;
  chapterId: string;
  assets?: AssetTables;
  assetTypes?: Record<string, AssetKind>;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function replaceAsync(
  input: string,
  expression: RegExp,
  replacer: (match: RegExpExecArray) => Promise<string>,
): Promise<string> {
  if (!expression.global) throw new Error("replaceAsync requires a global RegExp");
  const matches = [...input.matchAll(expression)];
  const replacements = await Promise.all(matches.map(replacer));
  let result = input;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    const replacement = replacements[index];
    if (match?.index === undefined || replacement === undefined) continue;
    result =
      result.slice(0, match.index) + replacement + result.slice(match.index + match[0].length);
  }
  return result;
}

class ProtectedHtml {
  private readonly fragments: string[] = [];

  protect(html: string): string {
    const index = this.fragments.push(html) - 1;
    return `<!--TENNA-ANNOTATION:${index}-->`;
  }

  restore(input: string): string {
    const restoreTokens = (value: string, ancestors: ReadonlySet<number>): string =>
      value.replace(/<!--TENNA-ANNOTATION:(\d+)-->/g, (_match, rawIndex: string) => {
        const index = Number(rawIndex);
        if (ancestors.has(index)) throw new Error(`Cyclic protected HTML fragment ${index}`);
        const fragment = this.fragments[index];
        if (fragment === undefined) throw new Error(`Missing protected HTML fragment ${index}`);
        return restoreTokens(fragment, new Set([...ancestors, index]));
      });

    return restoreTokens(input, new Set());
  }
}

interface CodeToken {
  start: number;
  value: string;
}

function previousCodeToken(line: string, before: number, code: Uint8Array): CodeToken | undefined {
  let end = before - 1;
  while (end >= 0 && (code[end] !== 1 || /\s/.test(line[end] ?? ""))) end -= 1;
  if (end < 0) return undefined;

  const character = line[end] ?? "";
  if (!/[A-Za-z0-9_]/.test(character)) return { start: end, value: character };
  let start = end;
  while (start > 0 && code[start - 1] === 1 && /[A-Za-z0-9_]/.test(line[start - 1] ?? "")) {
    start -= 1;
  }
  return { start, value: line.slice(start, end + 1) };
}

function previousCodeTokens(
  line: string,
  before: number,
  code: Uint8Array,
  carried: readonly string[],
  count: number,
): string[] {
  const tokens: string[] = [];
  let cursor = before;
  while (tokens.length < count) {
    const token = previousCodeToken(line, cursor, code);
    if (token === undefined) break;
    tokens.push(token.value);
    cursor = token.start;
  }
  for (let index = carried.length - 1; tokens.length < count && index >= 0; index -= 1) {
    const token = carried[index];
    if (token !== undefined) tokens.push(token);
  }
  return tokens;
}

function trailingCodeTokens(line: string, code: Uint8Array, count: number): string[] {
  const reversed: string[] = [];
  let cursor = line.length;
  while (reversed.length < count) {
    const token = previousCodeToken(line, cursor, code);
    if (token === undefined) break;
    reversed.push(token.value);
    cursor = token.start;
  }
  return reversed.reverse();
}

function parseText(text: string, isFormat: boolean): string {
  let parsed = text.replace(/\\\\/g, "\\");
  parsed = parsed.replace(/(?<!`)\//g, '<span class="cc cc-wait">Wait for input</span>');
  parsed = parsed.replace(
    /\^([1-9])(.)/g,
    '$2<span class="cc cc-delay">Delay $1<span>$1</span></span>',
  );
  parsed = parsed.replace(/(?<!`)&amp;\s*/g, "<br>");
  parsed = parsed.replace(/(?<!`)%/g, '<span class="cc cc-close">Close Message</span>');
  if (isFormat) {
    parsed = parsed.replace(
      /~([1-9])/g,
      '<span class="cc cc-arg">Argument №$1<span>$1</span></span>',
    );
  }
  parsed = parsed.replace(/\\[EM](.)/g, '<span class="cc-face">Face $1</span>');
  parsed = parsed.replace(/\\m(.)\*?/g, '<span class="cc-face">Mini face $1</span> ');
  parsed = parsed.replace(/\\f(.)\*?/g, '<span class="cc-face">Mini text $1</span> ');
  parsed = parsed.replace(
    /\\c([A-Za-z0-9_-])(.*?)(?=\\c|$)/g,
    '<span class="cc-color cc-$1">$2</span>',
  );
  parsed = parsed.replace(
    /\\([RGYBOLPpWX])(.*?)(?=\\[RGYBOLPpWX]|$)/g,
    '<span class="cc-color cc-$1">$2</span>',
  );
  parsed = parsed.replace(/\\T(.)/g, '<span class="cc-face">Sound $1</span>');
  parsed = parsed.replace(/\\F(.)/g, '<span class="cc-face">Char $1</span>');
  parsed = parsed.replace(/\\C(.)/g, '<span class="cc-face">Choice type $1</span>');
  parsed = parsed.replace(/\\C/g, '<span class="cc-face">Choice</span>');
  parsed = parsed.replace(/\\"/g, '"');
  parsed = parsed.replace(/`(.)/g, "$1");
  return parsed;
}

function highlightText(match: RegExpExecArray, renderTemplate: TemplateRenderer): string {
  const variable = match[2] ?? "";
  return renderTemplate("highlight/text.html", {
    before_var: '"',
    variable,
    after_var: match[3] ?? "",
    parsed_text: parseText(variable, (match[1] ?? "").includes("subloc")),
  });
}

async function highlightLocalizedText(
  match: RegExpExecArray,
  context: AnnotationContext,
): Promise<string> {
  const key = match[2] ?? "";
  return context.renderTemplate("highlight/text.html", {
    before_var: match[1] ?? "",
    variable: key,
    after_var: match[3] ?? "",
    parsed_text: parseText(escapeHtml(await context.data.getLocalizedString(key)), false),
  });
}

async function highlightRoom(match: RegExpExecArray, context: AnnotationContext): Promise<string> {
  const value = match[2] ?? "";
  const room = /^\d+$/.test(value)
    ? await context.data.getRoomById(Number(value))
    : await context.data.getRoomByName(value, context.chapterId);
  if (room === undefined) return match[0];
  return context.renderTemplate("highlight/room.html", {
    before_room: match[1] ?? "",
    room_name: room.name,
    room_description: room.description,
  });
}

async function highlightEnemy(match: RegExpExecArray, context: AnnotationContext): Promise<string> {
  const enemyId = Number(match[2]);
  const enemyName = await context.data.getEnemy(enemyId);
  if (enemyName === undefined) return match[0];
  return context.renderTemplate("highlight/enemy.html", {
    before_enemy: match[1] ?? "",
    enemy_id: enemyId,
    enemy_name: enemyName,
  });
}

async function highlightFlag(match: RegExpExecArray, context: AnnotationContext): Promise<string> {
  const flagId = Number(match[2]);
  const description = await context.data.getFlag(flagId);
  return context.renderTemplate(
    description === undefined ? "highlight/flag_not_found.html" : "highlight/flag_found.html",
    {
      before_flag: match[1] ?? "",
      flag_id: flagId,
      flag_description: description ?? null,
      after_flag: match[3] ?? "",
    },
  );
}

function highlightAsset(
  match: RegExpExecArray,
  kind: AssetKind,
  context: AnnotationContext,
  valueIndex = 2,
): string {
  if (isLikelyBoolean(match, valueIndex)) return match[0];
  const assetId = Number(match[valueIndex]);
  const name = context.assets?.[kind][assetId];
  if (name === undefined || name === "") return match[0];
  return context.renderTemplate("highlight/sprite.html", {
    before_sprite: match[1] ?? "",
    sprite_id: assetId,
    sprite_name: name,
  });
}

// draw_sprite_ext() takes the image frame second, so we don't really want this
const SPRITE_CONTEXT = /\b([a-z0-9_]*sprite(?:_index)?\s*=\s*)(\d+)\b/gi;
const MONSTER_TYPE_COMPARISON = new RegExp(
  "(global\\.monstertype(?:\\[(?:[^\\[\\]]|\\[[^\\[\\]]*\\])*\\])?\\s*(?:==|!=)\\s*)(\\d+)\\b",
  "gi",
);

function isLikelyBoolean(match: RegExpExecArray, valueIndex: number): boolean {
  return match[valueIndex] === "0" && (match[1] ?? "").includes("=");
}

interface AssetTypeContext {
  expression: RegExp;
  kinds: Map<string, AssetKind>;
}

const assetTypeCache = new WeakMap<Record<string, AssetKind>, AssetTypeContext | undefined>();

function assetTypeContext(assetTypes: Record<string, AssetKind>): AssetTypeContext | undefined {
  if (assetTypeCache.has(assetTypes)) return assetTypeCache.get(assetTypes);

  const kinds = new Map<string, AssetKind>();
  const targets: string[] = [];
  for (const [target, kind] of Object.entries(assetTypes)) {
    const normalized = target.toLowerCase();
    if (kinds.has(normalized)) continue;
    kinds.set(normalized, kind);
    targets.push(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }
  const context =
    targets.length === 0
      ? undefined
      : {
          expression: new RegExp(`\\b((${targets.join("|")})\\s*=\\s*)(\\d+)\\b`, "gi"),
          kinds,
        };
  assetTypeCache.set(assetTypes, context);
  return context;
}

async function highlightFunction(
  match: RegExpExecArray,
  text: ScriptText,
  context: AnnotationContext,
  code: Uint8Array,
  carriedCodeTokens: readonly string[],
): Promise<string> {
  const functionName = match[1] ?? "";
  const previous = previousCodeTokens(match.input, match.index, code, carriedCodeTokens, 1)[0];
  if (previous === "." || previous?.toLowerCase() === "function") return match[0];
  const scriptName = `gml_GlobalScript_${functionName}`;
  if (!text.has(scriptName)) return match[0];
  return context.renderTemplate("highlight/function.html", {
    script_name: scriptName,
    function_name: functionName,
  });
}

async function highlightAlarm(
  match: RegExpExecArray,
  currentScriptName: string,
  text: ScriptText,
  context: AnnotationContext,
  code: Uint8Array,
  carriedCodeTokens: readonly string[],
): Promise<string> {
  const previous = previousCodeTokens(match.input, match.index, code, carriedCodeTokens, 2);
  if (previous[0] === "." && previous[1]?.toLowerCase() !== "self") {
    return match[0];
  }
  const alarmNumber = Number(match[4]);
  const owner = classify(`${currentScriptName}.gml`);
  if (owner.type !== "object") return match[0];
  const scriptName = `${owner.prefix}Alarm_${alarmNumber}`;
  if (!text.has(scriptName)) return match[0];
  return context.renderTemplate("highlight/alarm.html", {
    alarm_indent: match[1] ?? "",
    alarm_qualifier: match[2] ?? "",
    alarm_content: match[3] ?? "",
    script_name: scriptName,
  });
}

async function processLine(
  sourceLine: string,
  scriptName: string,
  text: ScriptText,
  context: AnnotationContext,
  startsInBlockComment = false,
  carriedCodeTokens: readonly string[] = [],
): Promise<string> {
  const protectedHtml = new ProtectedHtml();
  const replaceAnnotated = async (
    input: string,
    expression: RegExp,
    replacer: (match: RegExpExecArray, code: Uint8Array) => Promise<string>,
  ): Promise<string> => {
    let code: Uint8Array | undefined;
    return replaceAsync(input, expression, async (match) => {
      const matchIndex = match.index;
      code ??= scanSourceLine(input, { blockComment: startsInBlockComment }).code;
      if (matchIndex === undefined || code[matchIndex] !== 1) {
        return match[0];
      }
      const replacement = await replacer(match, code);
      return replacement === match[0] ? replacement : protectedHtml.protect(replacement);
    });
  };

  let line = escapeHtml(sourceLine);
  line = await replaceAnnotated(
    line,
    /([a-z0-9_]+loc\((?:\d+, )?)"((?:[^"\\]|\\.)+)(", "[a-z0-9_-]+")\)/gi,
    async (match) => `${match[1] ?? ""}${highlightText(match, context.renderTemplate)})`,
  );
  line = await replaceAnnotated(
    line,
    /([a-z0-9_]+subloc\((?:\d+, )?)"((?:[^"\\]|\\.)+)(", (?:.+, )?"[a-z0-9_-]+")\)/gi,
    async (match) => `${match[1] ?? ""}${highlightText(match, context.renderTemplate)})`,
  );
  line = await replaceAnnotated(
    line,
    /(scr_(?:84_get_lang_string(?:_ch1)?|gettext)\(")([a-z0-9_-]+)("\))/gi,
    (match) => highlightLocalizedText(match, context),
  );
  line = await replaceAnnotated(
    line,
    /(global\.flag\[|scr_flag_(?:g|s)et(?:_ext)?\()(\d+)((?:, .+?)?(?:\]|\)))/gi,
    (match) => highlightFlag(match, context),
  );
  line = await replaceAnnotated(line, /(room_goto\()([a-z0-9_]+)/gi, (match) =>
    highlightRoom(match, context),
  );
  line = await replaceAnnotated(line, MONSTER_TYPE_COMPARISON, (match) =>
    highlightEnemy(match, context),
  );
  if (context.assets !== undefined) {
    line = await replaceAnnotated(line, SPRITE_CONTEXT, async (match) =>
      highlightAsset(match, "sprites", context),
    );
    const typedAssets = assetTypeContext(context.assetTypes ?? {});
    if (typedAssets !== undefined) {
      line = await replaceAnnotated(line, typedAssets.expression, async (match) => {
        const target = match[2]?.toLowerCase();
        const kind = target === undefined ? undefined : typedAssets.kinds.get(target);
        return kind === undefined ? match[0] : highlightAsset(match, kind, context, 3);
      });
    }
  }
  line = await replaceAnnotated(line, /(?<![.\w])(s?cr?_[a-z0-9_]+)\(/gi, (match, code) =>
    highlightFunction(match, text, context, code, carriedCodeTokens),
  );
  line = await replaceAnnotated(
    line,
    /(^\s*)?(?<![.\w])(self\.)?(alarm\[(\d+)\])/gi,
    (match, code) => highlightAlarm(match, scriptName, text, context, code, carriedCodeTokens),
  );
  return `<code>${protectedHtml.restore(line)}</code>`;
}

export async function annotateLine(line: string, data: DeltaruneData): Promise<string> {
  const keys = [
    ...line.matchAll(/scr_(?:84_get_lang_string(?:_ch1)?|gettext)\("([a-zA-Z0-9_-]+)"\)/gi),
  ]
    .map((match) => match[1])
    .filter((key): key is string => key !== undefined);
  if (keys.length === 0) return line;
  const strings = await Promise.all(
    keys.map(async (key) => {
      const localized = await data.getLocalizedString(key);
      return JSON.stringify(localized);
    }),
  );
  return `${line} // ${strings.join(", ")}`;
}

export async function annotateScript(
  scriptName: string,
  text: ScriptText,
  context: AnnotationContext,
  scans?: readonly SourceScan[],
): Promise<string[]> {
  const source = text.get(scriptName);
  if (source === undefined) throw new Error(`Unknown script: ${scriptName}`);
  const lineScans = scans?.length === source.length ? scans : scanSourceLines(source);
  let carriedCodeTokens: string[] = [];
  const lineStates = source.map((line, index) => {
    const scan = lineScans[index] ?? scanSourceLine(line);
    const startsInBlockComment = scan.startsInBlockComment;
    const priorCodeTokens = carriedCodeTokens;
    carriedCodeTokens = [...carriedCodeTokens, ...trailingCodeTokens(line, scan.code, 2)].slice(-2);
    return { startsInBlockComment, priorCodeTokens };
  });
  return Promise.all(
    source.map((line, index) => {
      const state = lineStates[index];
      return processLine(
        line,
        scriptName,
        text,
        context,
        state?.startsInBlockComment ?? false,
        state?.priorCodeTokens,
      );
    }),
  );
}
