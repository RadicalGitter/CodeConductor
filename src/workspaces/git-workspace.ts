import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { ProposalContribution } from "../contracts/attempt.js";
import { selectParentEnvironment } from "../runtime/environment.js";
import { resolveExecutablePath } from "../runtime/executable.js";
import { runProcess } from "../runtime/process-runner.js";

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
    const deadline = Date.now() + 30_000;
    if (await exists(expected)) {
      await boundedCleanupGit(
        workspace.repositoryRoot,
        ["worktree", "remove", "--force", expected],
        this.workspaceRoot,
        deadline,
      );
    }
    await boundedCleanupGit(
      workspace.repositoryRoot,
      ["worktree", "prune"],
      this.workspaceRoot,
      deadline,
    );
  }

  async composeProposalBaseline(
    workspace: GitWorkspace,
    contributions: ProposalContribution[],
  ): Promise<GitWorkspace> {
    if (contributions.length === 0) return workspace;
    const actualRevision = await git(workspace.path, ["rev-parse", "HEAD"]);
    if (actualRevision !== workspace.baseRevision) {
      throw new Error(
        `Composition workspace moved from ${workspace.baseRevision} to ${actualRevision}`,
      );
    }

    try {
      for (const contribution of contributions) {
        const patch = await readFile(contribution.patchPath);
        if (patch.byteLength !== contribution.patchBytes) {
          throw new Error(
            `Proposal patch size changed for ${contribution.attemptId}`,
          );
        }
        if (
          createHash("sha256").update(patch).digest("hex") !==
          contribution.patchSha256
        ) {
          throw new Error(
            `Proposal patch hash changed for ${contribution.attemptId}`,
          );
        }
        if (patch.byteLength === 0) continue;
        await git(
          workspace.path,
          [
            "apply",
            "--index",
            "--3way",
            "--binary",
            "--whitespace=nowarn",
            "-",
          ],
          { input: patch },
        );
      }

      const tree = await git(workspace.path, ["write-tree"]);
      const message = [
        "Conductor proposal-only composition",
        "",
        ...contributions.map(
          (entry) =>
            `${entry.attemptId} ${entry.patchSha256} from ${entry.patchBaseRevision}`,
        ),
        "",
      ].join("\n");
      const derivedRevision = await git(
        workspace.path,
        ["commit-tree", tree, "-p", workspace.baseRevision],
        {
          input: Buffer.from(message, "utf8"),
          env: {
            GIT_AUTHOR_NAME: "Conductor",
            GIT_AUTHOR_EMAIL: "conductor@example.invalid",
            GIT_AUTHOR_DATE: "2000-01-01T00:00:00 +0000",
            GIT_COMMITTER_NAME: "Conductor",
            GIT_COMMITTER_EMAIL: "conductor@example.invalid",
            GIT_COMMITTER_DATE: "2000-01-01T00:00:00 +0000",
          },
        },
      );
      await git(workspace.path, ["reset", "--hard", derivedRevision]);
      return { ...workspace, baseRevision: derivedRevision };
    } catch (error) {
      await git(workspace.path, ["reset", "--hard", workspace.baseRevision]);
      throw new Error(`Proposal composition failed: ${errorMessage(error)}`);
    }
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

async function boundedCleanupGit(
  cwd: string,
  args: string[],
  artifactRoot: string,
  deadline: number,
): Promise<void> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 5_000) {
    throw new Error("Workspace cleanup deadline exhausted before Git closure");
  }
  const executable = resolveExecutablePath("git");
  if (!executable) throw new Error("A real Git executable is required");
  const identity = randomUUID();
  const artifactDirectory = path.join(artifactRoot, ".cleanup-logs");
  const stdoutPath = path.join(artifactDirectory, `${identity}.stdout.log`);
  const stderrPath = path.join(artifactDirectory, `${identity}.stderr.log`);
  try {
    const result = await runProcess(
      { executable, args: ["-C", cwd, ...args], cwd },
      {
        stdoutPath,
        stderrPath,
        timeoutMs: Math.min(10_000, remainingMs - 5_000),
      },
    );
    const stderr = await readFile(stderrPath, "utf8");
    if (result.termination.status !== "proven") {
      throw new Error(
        `git ${args[0] ?? ""} cleanup termination is ${result.termination.status}`,
      );
    }
    if (result.timedOut) {
      throw new Error(`git ${args[0] ?? ""} cleanup timed out`);
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `git ${args[0] ?? ""} failed (${result.exitCode}): ${stderr.trim()}`,
      );
    }
  } finally {
    await Promise.allSettled([
      rm(stdoutPath, { force: true }),
      rm(stderrPath, { force: true }),
    ]);
    await rm(artifactDirectory, { recursive: false }).catch(() => undefined);
  }
}

async function git(
  cwd: string,
  args: string[],
  options: {
    input?: Buffer;
    env?: Record<string, string>;
  } = {},
): Promise<string> {
  const child = spawn("git", ["-C", cwd, ...args], {
    shell: false,
    windowsHide: true,
    env: { ...selectParentEnvironment(), ...options.env },
    stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk) => (stdout += chunk));
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  if (options.input) child.stdin!.end(options.input);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
