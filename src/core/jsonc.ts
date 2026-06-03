/**
 * core/jsonc — tolerant JSONC / JSON5-lite parsing.
 *
 * Many hosts document their config file as JSONC (or JSON5): // line comments,
 * /* *\/ block comments, and trailing commas are all legal. A strict JSON.parse
 * false-fails such a perfectly valid file → null → and a careless `?? {}` then
 * OVERWRITES the user's entire config with just our entry (data loss). To avoid
 * that, every JSON/JSONC adapter parses through `parseJsonc`, which strips
 * comments + trailing commas in ONE string-aware pass before JSON.parse.
 *
 * The single pass is deliberately string-literal aware: a // or /* inside a
 * quoted value (e.g. "http://x//y") is NOT a comment, and a comma inside a
 * string (e.g. "a,]") is NOT a trailing comma — both must survive verbatim.
 */

/**
 * Strip // line comments, /* *\/ block comments, and trailing commas from JSONC
 * text in a SINGLE string-aware pass.
 *
 * Rules:
 *   - While inside a string literal, every character (including //, /*, and ,)
 *     is copied verbatim; backslash escapes the next character.
 *   - Outside a string, // … runs to end-of-line and /* … *\/ to its close.
 *   - A comma is dropped ONLY when the next non-whitespace, non-comment token is
 *     a closing `}` or `]` (a trailing comma). A comma followed by another value
 *     or by end-of-input is preserved (the latter lets JSON.parse report the
 *     real syntax error instead of us masking it).
 */
export function stripJsonc(text: string): string {
  const n = text.length;
  let out = "";
  let i = 0;
  let inString = false;
  let quote = "";

  while (i < n) {
    const ch = text[i] as string;

    if (inString) {
      out += ch;
      if (ch === "\\") {
        // Copy the escaped character verbatim (covers \" \\ \/ etc.).
        if (i + 1 < n) {
          out += text[i + 1] as string;
          i += 2;
          continue;
        }
      } else if (ch === quote) {
        inString = false;
      }
      i += 1;
      continue;
    }

    const next = i + 1 < n ? (text[i + 1] as string) : "";

    // Enter a string literal.
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }

    // Line comment — skip to end of line (keep the newline for line tracking).
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < n && text[i] !== "\n") i += 1;
      continue;
    }

    // Block comment — skip to the closing */.
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2; // consume the closing */
      continue;
    }

    // Trailing comma — drop it only when the next significant token (skipping
    // whitespace AND comments) is a closing } or ]. This stays string-aware
    // because we only reach here outside a string.
    if (ch === ",") {
      const closer = nextSignificant(text, i + 1);
      if (closer === "}" || closer === "]") {
        i += 1; // drop the trailing comma
        continue;
      }
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * Peek the next significant (non-whitespace, non-comment) character at/after
 * `from`, returning "" at end-of-input. Used only outside string literals.
 */
function nextSignificant(text: string, from: number): string {
  const n = text.length;
  let i = from;
  while (i < n) {
    const ch = text[i] as string;
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i += 1;
      continue;
    }
    const next = i + 1 < n ? (text[i + 1] as string) : "";
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < n && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    return ch;
  }
  return "";
}

/**
 * Parse JSONC text tolerantly: strip comments + trailing commas, then JSON.parse.
 * Throws (like JSON.parse) on genuinely malformed input — callers that want a
 * fail-soft null should wrap in try/catch (BaseAdapter.readJson does).
 */
export function parseJsonc<T = unknown>(text: string): T {
  return JSON.parse(stripJsonc(text)) as T;
}
