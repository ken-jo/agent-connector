/**
 * core/oauth/browser — can this process hand a URL to a browser, and how.
 *
 * The opener is spawned without a shell (the URL is one argv entry), detached
 * and with its stdio ignored, so a stdio MCP server that logs in lazily never
 * shares its protocol pipes with the browser.
 */

import { spawn } from "node:child_process";

import { OAuthError } from "./errors.js";

/** `AGENT_CONNECTOR_BROWSER=never|always` overrides the platform heuristics. */
export const BROWSER_ENV = "AGENT_CONNECTOR_BROWSER";

export function canOpenBrowser(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const forced = env[BROWSER_ENV];
  if (forced === "never") return false;
  if (forced === "always") return true;
  const overSsh = Boolean(env.SSH_CONNECTION || env.SSH_TTY);
  if (platform === "darwin" || platform === "win32") return !overSsh;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

export type SpawnFn = (
  file: string,
  args: string[],
  options: { detached: boolean; stdio: "ignore" },
) => {
  once(event: "spawn" | "error", listener: (err?: Error) => void): unknown;
  unref(): void;
};

export interface OpenBrowserOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Process seam (tests). Defaults to node:child_process spawn. */
  spawn?: SpawnFn;
}

/** The opener command for `platform`, as `[file, ...args]` with `url` last. */
export function browserCommand(url: string, platform: NodeJS.Platform): string[] {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["rundll32", "url.dll,FileProtocolHandler", url];
  return ["xdg-open", url];
}

export async function openBrowser(url: string, opts: OpenBrowserOptions = {}): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OAuthError("config", `cannot open "${url}": not a URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new OAuthError("config", `cannot open "${parsed.protocol}" URLs in a browser`);
  }
  const platform = opts.platform ?? process.platform;
  const spawnFn: SpawnFn = opts.spawn ?? (spawn as unknown as SpawnFn);
  const [file, ...args] = browserCommand(parsed.toString(), platform);
  await new Promise<void>((resolve, reject) => {
    let child: ReturnType<SpawnFn>;
    try {
      child = spawnFn(file as string, args, { detached: true, stdio: "ignore" });
    } catch (err) {
      reject(
        new OAuthError(
          "browser-unavailable",
          `could not start ${file}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }
    child.once("error", (err) => {
      reject(
        new OAuthError(
          "browser-unavailable",
          `could not start ${file}: ${err instanceof Error ? err.message : String(err)}`,
          "open the printed URL yourself, or set AGENT_CONNECTOR_BROWSER=never to skip the attempt",
        ),
      );
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
