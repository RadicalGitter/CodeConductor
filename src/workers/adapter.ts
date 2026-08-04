import type { JobContract } from "../contracts/job.js";
import type { ProcessInvocation } from "../runtime/process-runner.js";

export interface WorkerAdapterDescription {
  id: string;
  label: string;
  executable: string;
  mutationMode: "worktree";
  outputFormat: "jsonl" | "text";
  safetyMode: string;
  available: boolean;
}

export interface WorkerAdapter {
  readonly description: WorkerAdapterDescription;
  buildInvocation(
    contract: JobContract,
    workspacePath: string,
  ): ProcessInvocation;
}

export class WorkerRegistry {
  private readonly adapters = new Map<string, WorkerAdapter>();

  constructor(adapters: WorkerAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.description.id)) {
        throw new Error(
          `Duplicate worker adapter id: ${adapter.description.id}`,
        );
      }
      this.adapters.set(adapter.description.id, adapter);
    }
  }

  get(id: string): WorkerAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Unknown worker adapter: ${id}`);
    return adapter;
  }

  list(): WorkerAdapterDescription[] {
    return [...this.adapters.values()].map((adapter) => ({
      ...adapter.description,
    }));
  }
}

export function buildWorkerPrompt(contract: JobContract): string {
  const allowed = contract.scope.allowedPaths.length
    ? contract.scope.allowedPaths.join(", ")
    : "(the assigned worktree; deterministic post-run scope checks still apply)";
  const forbidden = contract.scope.forbiddenPaths.length
    ? contract.scope.forbiddenPaths.join(", ")
    : "(none declared)";
  const context = contract.contextRefs.length
    ? contract.contextRefs.join("\n- ")
    : "(none)";
  const constraints = contract.constraints.length
    ? contract.constraints.join("\n- ")
    : "(none)";
  const escalations = contract.escalateWhen.join("\n- ");

  return `You are one coding worker operating inside an isolated Git worktree.

Complete this bounded ${contract.taskClass} job:
${contract.objective}

Frozen base revision: ${contract.repository.baseRevision}
Allowed path declaration: ${allowed}
Forbidden path declaration: ${forbidden}

Context references:
- ${context}

Constraints:
- ${constraints}

Stop and report needs-input instead of guessing when:
- ${escalations}

Use the coding and inspection tools available in your harness. Make the requested changes in the assigned worktree and run focused checks when practical. Treat your changes and final response as a proposal: Conductor records evidence, while acceptance and canonical integration remain outside your authority.`;
}
