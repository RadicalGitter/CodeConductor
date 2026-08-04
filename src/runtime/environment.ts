const BASE_ENVIRONMENT_KEYS =
  process.platform === "win32"
    ? [
        "APPDATA",
        "COMSPEC",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "PATH",
        "PATHEXT",
        "PROGRAMDATA",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "WINDIR",
      ]
    : ["HOME", "LANG", "LC_ALL", "PATH", "SHELL", "TMPDIR", "USER"];

export function selectParentEnvironment(
  extraKeys: readonly string[] = [],
): Record<string, string> {
  return selectRequestedEnvironment([...BASE_ENVIRONMENT_KEYS, ...extraKeys]);
}

export function selectRequestedEnvironment(
  keys: readonly string[],
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const requested of new Set(keys)) {
    const match = findEnvironmentEntry(requested);
    if (match) selected[match[0]] = match[1];
  }
  return selected;
}

export function parseEnvironmentList(value: string | undefined): string[] {
  return value
    ? [
        ...new Set(
          value
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
        ),
      ]
    : [];
}

function findEnvironmentEntry(requested: string): [string, string] | undefined {
  const expected =
    process.platform === "win32" ? requested.toUpperCase() : requested;
  for (const [key, value] of Object.entries(process.env)) {
    const candidate = process.platform === "win32" ? key.toUpperCase() : key;
    if (candidate === expected && value !== undefined) return [key, value];
  }
  return undefined;
}
