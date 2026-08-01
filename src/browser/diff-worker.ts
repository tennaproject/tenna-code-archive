import { diffLines, type DiffRow, type HighlightedDiffRow } from "./diff";
import { highlightGml } from "../gml/highlight";
import {
  renumberedAssetsByLine,
  type RenumberedAsset,
  type RenumberTables,
} from "../shared/renumbering";

interface DiffRequest {
  id: number;
  before: string[];
  after: string[];
  tables?: RenumberTables;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function assetBadge(number: string, name: string): string {
  return `<span class="entity-reference">${number} <span class="entity-description">${escapeHtml(name)}</span></span>`;
}

function annotateNumbers(html: string, assets: RenumberedAsset[]): string {
  const wanted = new Map(assets.map((asset) => [asset.position, asset.name]));
  let result = "";
  let index = 0;
  let numberIndex = -1;

  while (index < html.length) {
    const character = html[index];
    if (character === "<") {
      const close = html.indexOf(">", index);
      const stop = close === -1 ? html.length : close + 1;
      result += html.slice(index, stop);
      index = stop;
    } else if (character === "&") {
      const close = html.indexOf(";", index);
      const stop = close === -1 ? index + 1 : close + 1;
      result += html.slice(index, stop);
      index = stop;
    } else if (character !== undefined && character >= "0" && character <= "9") {
      let end = index;
      while (end < html.length) {
        const digit = html[end];
        if (digit === undefined || digit < "0" || digit > "9") break;
        end += 1;
      }
      numberIndex += 1;
      const number = html.slice(index, end);
      const name = wanted.get(numberIndex);
      result += name === undefined ? number : assetBadge(number, name);
      index = end;
    } else {
      result += character;
      index += 1;
    }
  }
  return result;
}

function highlightRows(rows: DiffRow[], tables: RenumberTables | undefined): HighlightedDiffRow[] {
  const assetsByLine = tables === undefined ? [] : renumberedAssetsByLine(rows, tables);
  return rows.map((row, index) => {
    const assets =
      row.kind === "change" && row.left !== undefined && row.right !== undefined
        ? assetsByLine[index]
        : undefined;
    const leftHtml = row.left === undefined ? undefined : highlightGml(row.left);
    const rightHtml = row.right === undefined ? undefined : highlightGml(row.right);
    return {
      kind: row.kind,
      leftNumber: row.leftNumber,
      leftHtml:
        assets === undefined || leftHtml === undefined
          ? leftHtml
          : annotateNumbers(leftHtml, assets),
      rightNumber: row.rightNumber,
      rightHtml:
        assets === undefined || rightHtml === undefined
          ? rightHtml
          : annotateNumbers(rightHtml, assets),
      ...(assets === undefined ? {} : { renumbering: true as const }),
    };
  });
}

self.addEventListener("message", (event: MessageEvent<DiffRequest>) => {
  const { id, before, after, tables } = event.data;
  try {
    self.postMessage({
      id,
      rows: highlightRows(diffLines(before, after), tables),
    });
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
