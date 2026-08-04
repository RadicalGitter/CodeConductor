import { spawn } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { selectParentEnvironment } from "../runtime/environment.js";

export interface GitWorkspace {
  path: string;
  repositoryRoot: string;
  baseRevision: string;
}

export class GitWorkspaceManager {
  readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  async inspectRepository(
    repositoryPath: string,
    baseRef: string,
  ): Promise<{
    root: string;
    revision: string;
  }> {
    const requested = await realpath(path.resolve(repositoryPath));
    const root = path.resolve(
      await git(requested, ["rev-parse", "--show-toplevel"]),
    );
    if (!samePath(requested, root)) {
      throw new Error(
        `Repository path must be its Git root: expected ${root}, received ${requested}`,
      );
    }
    const revision = await git(root, [
      "rev-parse",
      "--verify",
      `${baseRef}^{commit}`,
    ]);
    return { root, revision };
  }

  async create(input: {
    repositoryRoot: string;
    baseRevision: string;
    attemptId: string;
  }): Promise<GitWorkspace> {
    const target = this.targetPath(input.attemptId);
    await mkdir(this.workspaceRoot, { recursive: true });
    if (await exists(target))
      throw new Error(`Workspace already exists: ${target}`);

    await git(input.repositoryRoot, [
      "worktree",
      "add",
      "--detach",
      target,
      input.baseRevision,
    ]);
    const actualRevision = await git(target, ["rev-parse", "HEAD"]);
    if (actualRevision !== input.baseRevision) {
      throw new Error(
        `Worktree revision mismatch: expected ${input.baseRevision}, received ${actualRevision}`,
      );
    }

    return {
      path: target,
      repositoryRoot: input.repositoryRoot,
      baseRevision: actualRevision,
    };
  }

  async remove(workspace: GitWorkspace): Promise<void> {
    const expected = this.assertManagedPath(workspace.path);
    await git(workspace.repositoryRoot, [
      "worktree",
      "remove",
      "--force",
      expected,
    ]);
    await git(workspace.repositoryRoot, ["worktree", "prune"]);
  }

  targetPath(attemptId: string): string {
    if (!/^[a-zA-Z0-9_.-]+$/.test(attemptId)) {
      throw new Error(`Unsafe workspace id: ${attemptId}`);
    }
    return path.join(this.workspaceRoot, attemptId);
  }

  assertManagedPath(candidate: string): string {
    const resolved = path.resolve(candidate);
    const relative = path.relative(this.workspaceRoot, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Refusing unmanaged workspace path: ${candidate}`);
    }
    return resolved;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const child = spawn("git", ["-C", cwd, ...args], {
    shell: false,
    windowsHide: true,
    env: selectParentEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? -1));
  });
  if (exitCode !== 0) {
    throw new Error(
      `git ${args[0] ?? ""} failed (${exitCode}): ${stderr.trim()}`,
    );
  }
  return stdout.trim();
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}
