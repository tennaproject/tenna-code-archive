export interface ScanState {
  blockComment: boolean;
}

export interface NumberToken {
  raw: string;
  value: number;
  position: number;
}

export interface SourceScan {
  startsInBlockComment: boolean;
  endsInBlockComment: boolean;
  code: Uint8Array;
  masked: string;
  numbers: NumberToken[];
}

function identifierOrDecimal(character: string | undefined): boolean {
  return character !== undefined && (/[A-Za-z0-9_.]/.test(character) || character === "$");
}

export function scanSourceLine(
  line: string,
  state: ScanState = { blockComment: false },
): SourceScan {
  const startsInBlockComment = state.blockComment;
  const code = new Uint8Array(line.length);
  let result = "";
  let quote: string | undefined;
  let lineComment = false;
  let numberPosition = 0;
  const numbers: NumberToken[] = [];

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === undefined) break;

    if (character >= "0" && character <= "9") {
      let end = index + 1;
      while (end < line.length) {
        const digit = line[end];
        if (digit === undefined || digit < "0" || digit > "9") break;
        end += 1;
      }
      const raw = line.slice(index, end);
      const inCode = quote === undefined && !state.blockComment && !lineComment;
      const codeLiteral =
        inCode &&
        !identifierOrDecimal(line[index - 1]) &&
        line[index - 1] !== "+" &&
        line[index - 1] !== "-" &&
        !identifierOrDecimal(line[end]);
      if (inCode) code.fill(1, index, end);
      if (codeLiteral) {
        result += "#";
        numbers.push({ raw, value: Number(raw), position: numberPosition });
      } else {
        result += raw;
      }
      numberPosition += 1;
      index = end - 1;
      continue;
    }

    if (lineComment) {
      result += character;
      continue;
    }

    if (state.blockComment) {
      result += character;
      if (character === "*" && line[index + 1] === "/") {
        result += "/";
        index += 1;
        state.blockComment = false;
      }
      continue;
    }

    if (quote !== undefined) {
      result += character;
      if (character === "\\") {
        result += line[index + 1] ?? "";
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === "/" && line[index + 1] === "/") {
      result += "//";
      index += 1;
      lineComment = true;
      continue;
    }
    if (character === "/" && line[index + 1] === "*") {
      result += "/*";
      index += 1;
      state.blockComment = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      result += character;
      continue;
    }
    code[index] = 1;
    result += character;
  }

  return {
    startsInBlockComment,
    endsInBlockComment: state.blockComment,
    code,
    masked: result,
    numbers,
  };
}

export function scanSourceLines(lines: readonly string[]): SourceScan[] {
  const state: ScanState = { blockComment: false };
  return lines.map((line) => scanSourceLine(line, state));
}
