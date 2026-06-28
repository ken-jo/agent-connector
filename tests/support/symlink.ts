import { symlinkSync } from "node:fs";

type SymlinkType = "dir" | "file" | "junction";

// Some Windows developer environments cannot create symlinks without Developer
// Mode or elevated privileges. These tests verify our handling after a symlink
// exists, so skip only when the OS refuses the setup step itself.
export function symlinkOrSkipTest(
  target: string,
  path: string,
  type?: SymlinkType,
): boolean {
  try {
    if (type === undefined) symlinkSync(target, path);
    else symlinkSync(target, path, type);
    return true;
  } catch (error) {
    if (isSymlinkUnavailableError(error)) return false;
    throw error;
  }
}

function isSymlinkUnavailableError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = String((error as { code?: unknown }).code);
  return code === "EPERM" || code === "EACCES" || code === "ENOTSUP" || code === "ENOSYS";
}
