import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { ProposalContribution } from "../contracts/attempt.js";
import { resolveExecutablePath } from "../runtime/executable.js";
import { isolatedGitEnvironment, runBoundedGit } from "../runtime/git.js";
import { runProcess } from "../runtime/process-runner.js";

export interface GitWorkspace {
  path: string;
  repositoryRoot: string;
  baseRevision: string;
  gitTimeoutMs?: number;
  maxGitOutputBytes?: number;
  cleanupTimeoutMs?: number;
  maxPatchBytes?: number;
}

export class GitWorkspaceManager {
  readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  async inspectRepository(
    repositoryPath: string,
    baseRef: string,
    limits: { gitTimeoutMs?: number; maxGitOutputBytes?: number } = {},
  ): Promise<{
    root: string;
    revision: string;
  }> {
    const requested = await realpath(path.resolve(repositoryPath));
    const root = path.resolve(
      await git(requested, ["rev-parse", "--show-toplevel"], limits),
    );
    if (!samePath(requested, root)) {
      throw new Error(
        `Repository path must be its Git root: expected ${root}, received ${requested}`,
      );
    }
    const revision = await git(
      root,
      ["rev-parse", "--verify", `${baseRef}^{commit}`],
      limits,
    );
    return { root, revision };
  }

  async create(input: {
    repositoryRoot: string;
    baseRevision: string;
    attemptId: string;
    gitTimeoutMs?: number;
    maxGitOutputBytes?: number;
    cleanupTimeoutMs?: number;
    maxPatchBytes?: number;
  }): Promise<GitWorkspace> {
    const target = this.targetPath(input.attemptId);
    await mkdir(this.workspaceRoot, { recursive: true });
    if (await exists(target))
      throw new Error(`Workspace already exists: ${target}`);

    await git(
      input.repositoryRoot,
      ["worktree", "add", "--detach", target, input.baseRevision],
      input,
    );
    const actualRevision = await git(target, ["rev-parse", "HEAD"], input);
    if (actualRevision !== input.baseRevision) {
      throw new Error(
        `Worktree revision mismatch: expected ${input.baseRevision}, received ${actualRevision}`,
      );
    }

    return {
      path: target,
      repositoryRoot: input.repositoryRoot,
      baseRevision: actualRevision,
      gitTimeoutMs: input.gitTimeoutMs,
      maxGitOutputBytes: input.maxGitOutputBytes,
      cleanupTimeoutMs: input.cleanupTimeoutMs,
      maxPatchBytes: input.maxPatchBytes,
    };
  }

  async remove(workspace: GitWorkspace): Promise<void> {
    const expected = this.assertManagedPath(workspace.path);
    const deadline = Date.now() + (workspace.cleanupTimeoutMs ?? 30_000);
    if (await exists(expected)) {
      await boundedCleanupGit(
        workspace.repositoryRoot,
        ["worktree", "remove", "--force", expected],
        this.workspaceRoot,
        deadline,
        workspace.gitTimeoutMs,
        workspace.maxGitOutputBytes,
      );
    }
    await boundedCleanupGit(
      workspace.repositoryRoot,
      ["worktree", "prune"],
      this.workspaceRoot,
      deadline,
      workspace.gitTimeoutMs,
      workspace.maxGitOutputBytes,
    );
  }

  async composeProposalBaseline(
    workspace: GitWorkspace,
    contributions: ProposalContribution[],
  ): Promise<GitWorkspace> {
    if (contributions.length === 0) return workspace;
    const actualRevision = await git(
      workspace.path,
      ["rev-parse", "HEAD"],
      workspace,
    );
    if (actualRevision !== workspace.baseRevision) {
      throw new Error(
        `Composition workspace moved from ${workspace.baseRevision} to ${actualRevision}`,
      );
    }

    try {
      for (const contribution of contributions) {
        const recordedPatch = await stat(contribution.patchPath);
        if (
          workspace.maxPatchBytes !== undefined &&
          recordedPatch.size > workspace.maxPatchBytes
        ) {
          throw new Error(
            `Proposal patch for ${contribution.attemptId} exceeds the child budget`,
          );
        }
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
          { ...workspace, input: patch },
        );
      }

      const tree = await git(workspace.path, ["write-tree"], workspace);
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
          ...workspace,
        },
      );
      await git(
        workspace.path,
        ["reset", "--hard", derivedRevision],
        workspace,
      );
      return { ...workspace, baseRevision: derivedRevision };
    } catch (error) {
      await git(
        workspace.path,
        ["reset", "--hard", workspace.baseRevision],
        workspace,
      );
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
  configuredTimeoutMs = 30_000,
  maxOutputBytes = 10 * 1024 * 1024,
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
      {
        executable,
        args: [
          "-c",
          `core.hooksPath=${path.join(artifactRoot, ".disabled-git-hooks")}`,
          "-C",
          cwd,
          ...args,
        ],
        cwd,
        env: isolatedGitEnvironment(),
      },
      {
        stdoutPath,
        stderrPath,
        timeoutMs: Math.min(configuredTimeoutMs, remainingMs - 5_000),
        maxStdoutBytes: maxOutputBytes,
        maxStderrBytes: maxOutputBytes,
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
    gitTimeoutMs?: number;
    maxGitOutputBytes?: number;
  } = {},
): Promise<string> {
  return runBoundedGit(cwd, args, {
    input: options.input,
    environment: options.env,
    timeoutMs: options.gitTimeoutMs,
    maxOutputBytes: options.maxGitOutputBytes,
  });
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
