/**
 * Shared <meta name="description"> helpers. Kept in their own tiny module so
 * the /docs chooser can set page meta WITHOUT importing DocsPage (which pulls
 * the whole DocsContent chunk — ~197 kB — just to render two cards).
 */

export const DEFAULT_DESCRIPTION =
  "One declarative defineConnector deploys MCP servers, hooks, commands, skills, subagents & memory (AGENTS.md-first managed blocks) across 29 AI-agent platforms — with default, platform-independent per-tool token telemetry.";

/** Set (or update) the document's <meta name="description"> content. */
export function setMetaDescription(content: string) {
  let el = document.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute("name", "description");
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}
