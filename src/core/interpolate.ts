/**
 * core/interpolate — universal ${env:VAR} interpolation.
 *
 * The developer writes one portable syntax in their connector config:
 *   "${env:ACME_KEY}"            → value of process.env.ACME_KEY
 *   "${env:ACME_URL:-https://x}" → value, or the default after ":-" if unset/empty
 *
 * Two consumers:
 *   • resolveEnvRefs / resolveEnvRefsDeep — resolve to literals at INSTALL time,
 *     for hosts with NO native interpolation (e.g. Codex TOML).
 *   • rewriteEnvRefs — translate to a host's NATIVE interpolation token (e.g.
 *     Cursor/VS Code "${env:VAR}", Claude "${VAR}") so secrets are never baked
 *     into config files. Adapters choose which to use.
 */

/** Matches ${env:NAME} and ${env:NAME:-default}. NAME is [A-Za-z_][A-Za-z0-9_]*. */
export const ENV_REF_RE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Resolve every ${env:VAR} in `input` to a literal from `env`. */
export function resolveEnvRefs(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return input.replace(ENV_REF_RE, (_m, name: string, def?: string) => {
    const v = env[name];
    if (v != null && v !== "") return v;
    return def ?? "";
  });
}

/** Recursively resolve ${env:VAR} in all strings of a JSON-ish value. */
export function resolveEnvRefsDeep<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === "string") return resolveEnvRefs(value, env) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((v) => resolveEnvRefsDeep(v, env)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveEnvRefsDeep(v, env);
    return out as T;
  }
  return value;
}

/**
 * Translate every ${env:VAR(:-default)} via `render` into a host-native token.
 * The renderer receives the var name and optional default and returns the
 * replacement string (e.g. `(name) => "${" + name + "}"` for Claude).
 */
export function rewriteEnvRefs(
  input: string,
  render: (name: string, def?: string) => string,
): string {
  return input.replace(ENV_REF_RE, (_m, name: string, def?: string) =>
    render(name, def),
  );
}

/** True if the string contains at least one ${env:...} reference. */
export function hasEnvRef(input: string): boolean {
  ENV_REF_RE.lastIndex = 0;
  return ENV_REF_RE.test(input);
}

/**
 * Names of every ${env:VAR} reference in a JSON-ish value that
 * {@link resolveEnvRefsDeep} would bake to an EMPTY literal — i.e. the var is
 * unset/empty in `env` AND the reference carries no `:-default`. These are the
 * silent-empty-secret bakes on hosts WITHOUT native interpolation: the install
 * succeeds but writes `""` where a secret was meant, surfacing only as a
 * runtime auth failure inside the MCP server. Returns deduped names in
 * first-seen order; uses the SAME unset/default semantics as resolveEnvRefs so
 * the two can never disagree. A ref WITH a `:-default` is intentional and never
 * reported (even when the default itself is empty — the dev opted into "").
 */
export function findUnsetEnvRefs<T>(
  value: T,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const scanString = (input: string): void => {
    // A FRESH regex per scan — the shared ENV_REF_RE carries /g lastIndex state
    // (hasEnvRef / matchAll would otherwise start mid-string and miss matches).
    const re = new RegExp(ENV_REF_RE.source, "g");
    for (const m of input.matchAll(re)) {
      const name = m[1] as string;
      const def = m[2] as string | undefined;
      // Mirrors resolveEnvRefs: a present, non-empty value resolves to itself;
      // otherwise the default is used (no bake of ""). Only an unset/empty var
      // WITHOUT a default bakes "" — the case we report.
      const v = env[name];
      if (v != null && v !== "") continue;
      if (def !== undefined) continue;
      if (!seen.has(name)) {
        seen.add(name);
        order.push(name);
      }
    }
  };
  const walk = (v: unknown): void => {
    if (typeof v === "string") scanString(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return order;
}
