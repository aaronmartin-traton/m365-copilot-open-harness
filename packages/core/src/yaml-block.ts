/**
 * YAML block values for array/object fenced-tool params.
 *
 * Hand-ported from upstream 5912b24 (cramt/m365-copilot-proxy #50). The tools
 * block shows an array param as `edits: <edits>`. Some models fill it with
 * inline JSON; others write a YAML block list under an empty `edits:` line:
 *
 *   edits:
 *     - oldText: "    return a - b"
 *       newText: "    return a + b"
 *
 * Upstream measured 44 of 47 real-pi `edit` calls lost this way. This module
 * reads the subset models write: sequences, mappings, double/single-quoted and
 * plain scalars, inline JSON values, and `|` / `>` block scalars. Mapping
 * values stay strings (no YAML booleans or numbers). Anything it cannot read
 * returns undefined, so the caller keeps its old reading.
 */

const indentOf = (line: string): number => line.length - line.trimStart().length;

const DASH = /^-([ \t]|$)/;

// A plain key may not start with a flow indicator: `{oldText: "a", …}` is a flow
// mapping, not a key named "{oldText". Quoted keys are matched by the first two
// alternatives, so nothing readable is lost.
const YAML_KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s:#'"{\[][^:]*?):(?:[ \t]+(.*)|[ \t]*)$/;

class YamlSubsetError extends Error {}

/**
 * End (exclusive) of the YAML block under an empty `key:` header line at
 * `from - 1`. The block is the following indented lines, or for an array,
 * `- ` items at the key's own column. Inner blank lines belong to the block;
 * trailing ones do not.
 */
export function yamlBlockEnd(lines: string[], from: number, isArray: boolean): number {
  let end = from;

  for (let j = from; j < lines.length; j++) {
    const line = lines[j];

    if (line.trim() === "") continue;

    if (/^[ \t]/.test(line) || (isArray && DASH.test(line))) end = j + 1;
    else break;
  }

  return end;
}

/** A YAML block (the lines under an empty `key:`) as the declared type, or undefined. */
export function parseYamlBlockValue(block: string[], declaredType: "array" | "object"): unknown {
  let value: unknown;

  try {
    value = parseYamlNode(block.map((l) => l.replace(/\t/g, "  ")));
  } catch {
    return undefined;
  }

  if (declaredType === "array") return Array.isArray(value) ? value : undefined;

  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

/** Inline JSON for an array/object param (`edits: [{...}]`), or undefined. */
export function parseInlineJsonValue(raw: string, declaredType: "array" | "object"): unknown {
  const s = raw.trim();
  const open = declaredType === "array" ? "[" : "{";
  const close = declaredType === "array" ? "]" : "}";

  if (!s.startsWith(open) || !s.endsWith(close)) return undefined;

  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function parseYamlNode(lines: string[]): unknown {
  const first = lines.findIndex((l) => l.trim() !== "");

  if (first < 0) throw new YamlSubsetError("empty block");
  const body = lines.slice(first);
  const indent = indentOf(body[0]);
  const head = body[0].trimStart();

  if (DASH.test(head)) return parseYamlSequence(body, indent);

  if (YAML_KEY.test(head)) return parseYamlMapping(body, indent);

  if (body.slice(1).some((l) => l.trim() !== "")) throw new YamlSubsetError("multi-line plain scalar");

  return parseYamlScalar(head);
}

/** Lines below `from` until one at `indent` or less. */
function childLines(lines: string[], from: number, indent: number): { lines: string[]; next: number } {
  let j = from;

  for (; j < lines.length; j++) {
    if (lines[j].trim() !== "" && indentOf(lines[j]) <= indent) break;
  }

  return { lines: lines.slice(from, j), next: j };
}

function parseYamlSequence(lines: string[], indent: number): unknown[] {
  const items: unknown[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (indentOf(line) !== indent || !DASH.test(line.trimStart())) {
      throw new YamlSubsetError(`bad sequence line: ${line}`);
    }

    const rest = line.trimStart().slice(1);
    const kids = childLines(lines, i + 1, indent);

    if (rest.trim() === "") {
      items.push(parseYamlNode(kids.lines));
    } else {
      // `- key: value` opens a mapping whose keys sit one column past the dash's text.
      const itemIndent = indent + 1 + (rest.length - rest.trimStart().length);
      const itemLines = [" ".repeat(itemIndent) + rest.trimStart(), ...kids.lines];

      items.push(
        YAML_KEY.test(rest.trimStart())
          ? parseYamlMapping(itemLines, itemIndent)
          : parseYamlValue(rest.trim(), kids.lines, indent),
      );
    }

    i = kids.next;
  }

  return items;
}

function parseYamlMapping(lines: string[], indent: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    const m = indentOf(line) === indent ? line.trimStart().match(YAML_KEY) : null;

    if (!m) throw new YamlSubsetError(`bad mapping line: ${line}`);
    const key = String(parseYamlScalar(m[1]));
    const inline = (m[2] ?? "").trim();
    // A value's block may start at the key's own column when it is a sequence.
    let j = i + 1;

    for (; j < lines.length; j++) {
      const l = lines[j];

      if (l.trim() === "") continue;
      const ind = indentOf(l);

      if (ind > indent || (ind === indent && DASH.test(l.trimStart()) && !inline)) continue;
      break;
    }

    out[key] = parseYamlValue(inline, lines.slice(i + 1, j), indent);
    i = j;
  }

  return out;
}

/** The value after `key:` or `- ` (`inline`), with the lines nested under it. */
function parseYamlValue(inline: string, nested: string[], parentIndent: number): unknown {
  const block = inline.match(/^([|>])([-+]?)$/);

  if (block) return parseYamlBlockScalar(nested, parentIndent, block[1] === ">", block[2]);
  const hasNested = nested.some((l) => l.trim() !== "");

  if (inline === "") return hasNested ? parseYamlNode(nested) : "";

  if (hasNested) throw new YamlSubsetError("value with both inline text and nested lines");

  return parseYamlScalar(inline);
}

function parseYamlScalar(raw: string): unknown {
  const s = raw.trim();

  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }

  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");

  // Flow-shaped but unreadable as JSON: a YAML flow mapping/sequence is outside
  // this subset, and keeping the raw text would hand the harness a corrupted
  // value (a mapping keyed "{oldText") that passes every required-param check.
  // Fail closed instead — the caller drops the block and keeps its old reading.
  if ((s.startsWith("[") && s.endsWith("]")) || (s.startsWith("{") && s.endsWith("}"))) {
    return JSON.parse(s);
  }

  return s;
}

/**
 * `|` keeps line breaks, `>` folds them into spaces. Chomping: `-` strips the
 * final newline, `+` keeps trailing blank lines, the default keeps one.
 */
function parseYamlBlockScalar(lines: string[], parentIndent: number, folded: boolean, chomp: string): string {
  const content = lines.filter((l) => l.trim() !== "");

  if (!content.length) return "";
  const indent = Math.min(...content.map(indentOf));

  if (indent <= parentIndent) throw new YamlSubsetError("block scalar not indented");
  const rows = lines.map((l) => (l.trim() === "" ? "" : l.slice(indent)));

  let text = folded
    ? rows.reduce(
        (acc, row, k) => (k === 0 ? row : row === "" || rows[k - 1] === "" ? `${acc}\n${row}` : `${acc} ${row}`),
        "",
      )
    : rows.join("\n");

  if (chomp === "+") return `${text}\n`;
  text = text.replace(/\n+$/, "");

  return chomp === "-" ? text : `${text}\n`;
}
