import { constants, accessSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export function resolveExecutablePath(
  executable: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (path.isAbsolute(executable)) return executableFile(executable);
  if (executable.includes("/") || executable.includes("\\")) return undefined;

  const searchPath =
    environment.PATH ?? environment.Path ?? environment.path ?? "";
  const extensions =
    process.platform === "win32"
      ? path.extname(executable)
        ? [""]
        : [".exe", ".com"]
      : [""];
  for (const directoryEntry of searchPath.split(path.delimiter)) {
    const directory = directoryEntry.trim().replace(/^"|"$/g, "");
    if (!directory) continue;
    for (const extension of extensions) {
      const resolved = executableFile(
        path.join(directory, `${executable}${extension}`),
      );
      if (resolved) return resolved;
    }
  }
  return undefined;
}

function executableFile(candidate: string): string | undefined {
  try {
    if (!statSync(candidate).isFile()) return undefined;
    if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
    const resolved = realpathSync(candidate);
    if (
      process.platform === "win32" &&
      ![".exe", ".com"].includes(path.extname(resolved).toLowerCase())
    ) {
      return undefined;
    }
    return resolved;
  } catch {
    return undefined;
  }
}
