import { Navigate, useLocation, useParams } from "react-router-dom";
import { legacyHashRedirects, legacyRedirects } from "./docs-data";
import { SectionNotFound } from "./SectionNotFound";

/**
 * Client-side redirect for the pre-track /docs/:section URLs (all live on the
 * public internet). Hash-aware overrides are checked first — the two anchors
 * whose content moved to a different page than the rest of their old section —
 * then the plain 1:1 map. The URL #hash is appended to the target so in-page
 * deep links (e.g. /docs/hooks#claude-vs-kilo) keep scrolling. An id with no
 * mapping renders the SectionNotFound recovery page — never a silent bounce.
 */
export function LegacyDocsRedirect() {
  const { legacySection } = useParams<{ legacySection: string }>();
  const { hash } = useLocation();
  const id = legacySection ?? "";

  const target = legacyHashRedirects[`${id}${hash}`] ?? legacyRedirects[id];
  if (!target) {
    return <SectionNotFound section={id} />;
  }
  return <Navigate to={target + hash} replace />;
}
