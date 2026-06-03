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
