/**
 * Lazy, code-split syntax highlighter built on shiki's fine-grained core API.
 *
 * Design goals:
 *  - Keep the landing/docs initial JS chunk lean: shiki and every grammar/theme
 *    are dynamically imported, so they land in a separate async chunk that is
 *    only fetched the first time a CodeBlock highlights.
 *  - No WASM: we use the pure-JS (oniguruma-to-es) engine, which is smaller and
 *    avoids shipping an .onig.wasm asset.
 *  - Dual-theme output: `codeToHtml` is called with both github-light and
 *    github-dark and `defaultColor: false`, so every token carries CSS variables
 *    (--shiki / --shiki-dark). A tiny CSS rule under `.dark` flips them, so the
 *    highlight follows the site theme with zero re-highlighting on toggle.
 *  - Only the languages actually used in the docs/landing are bundled:
 *    ts, tsx, json, toml, bash/sh, md, plus plaintext for the `text` language.
 */

/** Languages we actually render across the docs + landing. */
export type HighlightLang =
  | "ts"
  | "tsx"
  | "json"
  | "toml"
  | "bash"
  | "sh"
  | "md"
  | "text";

/** Map our friendly language ids to shiki's canonical grammar names. */
const LANG_ALIAS: Record<HighlightLang, string> = {
  ts: "typescript",
  tsx: "tsx",
  json: "json",
  toml: "toml",
  bash: "bash",
  sh: "bash",
  md: "markdown",
  text: "text",
};

/** Normalize an arbitrary `language` prop to a known HighlightLang (or null). */
export function normalizeLang(lang?: string): HighlightLang | null {
  if (!lang) return null;
  const l = lang.toLowerCase();
  switch (l) {
    case "ts":
    case "typescript":
      return "ts";
    case "tsx":
      return "tsx";
    case "json":
    case "jsonc":
      return "json";
    case "toml":
      return "toml";
    case "bash":
    case "sh":
    case "shell":
    case "shellscript":
    case "zsh":
      return "bash";
    case "md":
    case "markdown":
      return "md";
    case "text":
    case "txt":
    case "plaintext":
    case "plain":
      return "text";
    default:
      return null;
  }
}

type HighlighterCore = Awaited<
  ReturnType<typeof import("shiki/core").createHighlighterCore>
>;

let highlighterPromise: Promise<HighlighterCore> | null = null;

/**
 * Lazily create (once) a singleton shiki core highlighter with the JS engine,
 * both github themes, and every language we use preloaded. All imports here are
 * dynamic so the whole thing is code-split into its own async chunk.
 */
async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [
        { createHighlighterCore },
        { createJavaScriptRegexEngine },
        githubLight,
        githubDark,
        typescript,
        tsx,
        json,
        toml,
        bash,
        markdown,
      ] = await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
        import("@shikijs/themes/github-light"),
        import("@shikijs/themes/github-dark"),
        import("@shikijs/langs/typescript"),
        import("@shikijs/langs/tsx"),
        import("@shikijs/langs/json"),
        import("@shikijs/langs/toml"),
        import("@shikijs/langs/bash"),
        import("@shikijs/langs/markdown"),
      ]);

      return createHighlighterCore({
        themes: [githubLight.default, githubDark.default],
        langs: [
          typescript.default,
          tsx.default,
          json.default,
          toml.default,
          bash.default,
          markdown.default,
        ],
        engine: createJavaScriptRegexEngine(),
      });
    })();
  }
  return highlighterPromise;
}

/**
 * Highlight `code` to dual-theme HTML. Returns CSS-var-driven token markup that
 * follows the site theme via the `.dark` class. Falls back to `null` on any
 * failure so callers can render the raw <pre><code> instead.
 */
export async function highlightToHtml(
  code: string,
  lang: HighlightLang,
): Promise<string | null> {
  // Plaintext has no grammar to load — render it raw (the caller's fallback).
  if (lang === "text") return null;
  try {
    const highlighter = await getHighlighter();
    return highlighter.codeToHtml(code, {
      lang: LANG_ALIAS[lang],
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    });
  } catch {
    return null;
  }
}
