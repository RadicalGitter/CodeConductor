# Vesserin backend generation and continuous-improvement plan

- Status: planned; implementation not started
- First product target: Vesserin Observation Projection v0
- Governing review: Ultra adversarial review of commit `5bf3cf2`
- Date: 2026-08-04

## Intent anchor

Oscar and a premium architect should be able to describe a game-backend
capability in game language, freeze its meaning and evidence once, and let
Conductor produce most of its implementation as isolated, diagnosable proposals
without spending premium attention on worker supervision.

The first implementation is an experiment as well as a product slice. Pro
access means Conductor does not need to beat premium implementation to justify
its existence immediately. It must first prove that the design is useful,
recoverable, observable, and capable of teaching us where orchestration helps
or hurts.

"Unattended" in this plan means unattended proposal production, deterministic
verification, diagnosis, and review preparation. It does not mean unattended
canonical integration. The latter remains an explicit owner or premium-
architect action.

## What is committed, experimental, and deferred

| Element                                                         | Classification            | Current support                                               | Decision                                                        |
| --------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------- |
| High-concept co-design followed by delegated implementation     | committed direction       | Vesserin design authority and Conductor jobs exist separately | make this the first real product workflow                       |
| Exact-revision, isolated proposal work                          | committed constraint      | implemented                                                   | preserve and harden                                             |
| Deterministic scope and acceptance evidence                     | committed constraint      | implemented, with eligibility gaps                            | seal before the pilot                                           |
| A Vesserin-owned compiler/context adapter                       | committed direction       | planned only                                                  | build after core hardening                                      |
| Source comments near implementation seams                       | committed affordance      | generic strict-JSON comments exist                            | use for the first pilot; add symbol binding only after evidence |
| Local workers writing most implementation bodies                | hypothesis                | one trivial live canary                                       | measure on a nontrivial backend package                         |
| Two simultaneous local workers improving throughput             | hypothesis                | deterministic fixtures only                                   | run a paired sequential/concurrent experiment                   |
| Sonnet review and bounded correction                            | hypothesis                | review packet only                                            | add after evidence integrity; measure an ablation               |
| Worker self-review                                              | superseded                | deliberately absent                                           | do not restore under a new name                                 |
| Token-state checkpoint micromanagement                          | superseded for production | outside this runtime                                          | omit from the workflow                                          |
| Automatic bug discovery and fix proposals                       | committed direction       | Vesserin instruments partly built                             | stage from deterministic reports to bounded proposals           |
| Automatic canonical merge                                       | not accepted              | absent                                                        | keep absent                                                     |
| Generated modules or engine lineages inside experimental worlds | preserved dream           | verifier scaffold only                                        | reopen after a microVM boundary and Vesserin M4/M6 evidence     |

## Definition of the goal

The first goal is complete when one real Vesserin backend capability travels
through this chain:

```text
Oscar + premium architect define game meaning
  -> architect freezes interfaces, oracles, scope, and contract graph
  -> Conductor validates one committed revision
  -> local workers implement isolated contract nodes
  -> deterministic checks and an aggregate assembly prove the package
  -> independent review produces advisory findings
  -> Oscar reviews game-facing behavior; premium architect reviews evidence
  -> accepted work enters Vesserin through its normal Git workflow
  -> run outcomes update diagnostics and routing evidence
```

The pilot success hypothesis is deliberately measurable:

- local workers originate most package implementation bodies and at least 70%
  of the accepted post-preparation production-code diff;
- at least two of the three worker implementation contracts are accepted
  without a premium rewrite; manual rewrites remain labeled rejected routes;
- no worker changes a frozen schema, test oracle, authority document, command
  profile, or hidden evaluator;
- the aggregate candidate passes Vesserin's focused checks, `npm run check`,
  and `npm run build` in a clean verification environment;
- Oscar can accept or reject the result from a game-facing behavior artifact,
  without reading TypeScript;
- every failed, rejected, equivalent, no-op, and `needs-input` outcome remains
  in the corpus;
- a fresh Conductor process can reconstruct the complete run after disposable
  worktrees are removed.

The percentages are pilot routing criteria, not permanent product targets.
Failure narrows or changes the route; it does not authorize weaker verification
or erase the larger goal.

The 70% denominator is changed, non-generated production code between the
frozen preparation revision and the accepted aggregate candidate. It includes
premium rewrites and correction attempts in worker-target files and excludes
tests, design records, command profiles, and the preparation commit itself.
Report the architect-authored preparation diff and attention beside this metric
so the package percentage cannot disguise total end-to-end cost.

## Reusable operating procedure

The canonical user-level skill is `$build-with-conductor`, maintained in the
AgentSkills repository. It carries the reusable workflow for freezing a design,
preparing project-owned seams and oracles, compiling a coherent graph,
preflighting the runtime, executing progressively, reviewing aggregate
evidence, and turning failures into diagnostic or fix proposals.

Conductor and Vesserin `AGENTS.md` files advertise the affordance and point to
project authority. They stay concise; the procedure remains in the skill, and
permissions remain in runtime policy rather than prompt text.

## Authority model

| Artifact or decision                                           | Class                         | Authority                                                              | Automation allowed                                               |
| -------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Vesserin design decisions, settled rules, and accepted commits | authoritative                 | Oscar and the Vesserin repository                                      | retrieve and validate only                                       |
| Approved backend design packet                                 | authoritative for one package | Oscar for game meaning; premium architect for technical contract       | freeze by revision and hash                                      |
| Work-package graph                                             | authoritative for one run     | premium architect after schema/policy validation                       | compile, schedule, and reproduce                                 |
| Frozen Conductor job                                           | authoritative for one attempt | Conductor policy                                                       | execute exactly; never widen                                     |
| Worker result and patch                                        | proposal                      | worker attempt                                                         | verify, review, reject, or supersede                             |
| Deterministic checks and Vesserin capsules                     | audit evidence                | owning deterministic tool                                              | create automatically and seal                                    |
| Semantic review or play report                                 | proposal                      | reviewer or playing agent                                              | cluster and present; never self-approve                          |
| Bug disposition                                                | authoritative triage decision | deterministic policy for exact engine crashes; otherwise premium/owner | record separately from observation                               |
| Model/harness profile                                          | derived routing evidence      | Conductor measurement                                                  | automatically demote; promote only after representative evidence |
| Canonical integration                                          | authoritative mutation        | premium architect or explicit owner action                             | never implicit in worker completion                              |

The architect-facing API and model-facing API are separate trust surfaces.
Architect tools may accept raw, explicit contracts because the caller already
has host authority. Model-facing tools accept only owner-defined project,
adapter, command, verifier, budget, and repository profile identifiers plus
bounded contract fields. A model cannot select a host execution boundary or
supply arbitrary executable arguments.

## Durable artifact model

Do not add all of these schemas in one implementation commit. They are the
stable meanings that each delivery slice should converge on.

### Backend design packet

`conductor.backend-design/v1` records:

- package identity and Vesserin base revision;
- the game-facing promise and acceptance story;
- owner decisions, existing settled decisions, working assumptions, and open
  questions as distinct fields;
- explicit non-goals;
- state, command, event, replay, visibility, and persistence implications;
- invariant, rule, faultline, decision, and source references;
- human-readable demonstrations Oscar will inspect;
- approval state and the exact hash frozen for compilation.

Free-form design does not become executable merely because it is committed.
The first version is translated into a structured package by the premium
architect. A later model may propose that translation, but the proposal must be
reviewed before workers start.

### Work package

`conductor.work-package/v1` records:

- design-packet hash and project profile;
- contract DAG and deterministic-only barrier nodes;
- exact target files or symbols, allowed paths, protected paths, and context
  pack hashes;
- expected mutation policy;
- focused, package-level, and held-out acceptance profiles;
- total and per-attempt budgets;
- review and correction policy;
- integration and notification policy.

### Worker result

`conductor.worker-result/v1` records a typed worker outcome:

```text
completed | needs-input | failed | cancelled
questions[]
assumptions[]
claimedChangedPaths[]
summary
residualRisks[]
```

This result is advisory. Conductor derives actual changed paths and check
outcomes independently. Implementation, test, and documentation contracts
default to `expectedMutation=true`; analysis and review default to false. A
permitted no-op requires an explicit reason and deterministic confirmation.

### Package run

`conductor.package-run/v1` binds:

- design and work-package hashes;
- source revision and graph;
- every job and attempt, including superseded attempts;
- exact worker, model, quant, runtime, harness, prompt-template, context,
  sampler, slot, and policy identities;
- queue, setup, generation, verification, review, and integration timings;
- resource and artifact summaries;
- aggregate candidate lineage and full-check result;
- review findings, correction attempts, and final dispositions;
- owner/premium attention measurements when available;
- a compact morning report and pointers to complete local evidence.

### Diagnostic finding

`conductor.finding/v1` separates the observation from its later disposition. It
records source, revision, run/attempt, failure signature, reproducer, confidence,
affected contract or invariant, evidence pointers, duplicate cluster, and data
visibility. Triage appends disposition rather than rewriting the original
report.

## Delivery sequence

### Phase 0 — reconcile current truth

The Ultra review reopened claims currently described as resolved. Before new
features, documentation and tests must agree that this head is suitable for
attended trials only.

Deliver:

- this plan linked from the roadmap;
- the tracked [unattended hardening register](hardening-register.md), mapping
  every confirmed finding to characterization, evidence, and closure updates;
- corrected process-tree, recovery, review-binding, and unattended-readiness
  claims;
- an explicit distinction between trusted coding workers, bounded container
  verification, and future hostile execution.

Exit:

- a cold reader can state what is implemented, what is unsafe, and which gate
  unlocks the Vesserin pilot without relying on conversation history.

### Phase 1 — singular execution state and complete recovery

Replace best-effort lifecycle updates with one durable state machine.

Deliver:

- legal queue and attempt transition tables with incrementing revisions;
- a durable `dispatchOperationId` linking queue intent, attempt reservation,
  and launch ownership;
- compare-and-transition semantics so one reserved attempt can be claimed only
  once;
- immutable terminal attempt state, with cleanup and review evidence stored in
  separate appendable records;
- `dispatching` and `cancelling` queue states;
- one scheduler path: the compatibility submission tool becomes an immediate-
  priority queued job rather than a second launcher;
- startup reconciliation that scans queue records and every nonterminal
  attempt;
- recoverable or quarantined malformed leases and staging directories;
- direct-queue validation for missing dependencies and cycles;
- a public `reconcile` operation with dry-run explanation and a narrowly typed
  authority-required action.
- test-only persistence failpoints at every authoritative transition boundary;
  the later `fault-inject` command is a wrapper over this harness, not its first
  implementation.

Exit evidence:

- 100 randomized simultaneous-start runs launch exactly one worker;
- process termination injected after every persistence boundary yields exactly
  resume, safe new attempt, or actionable quarantine;
- no terminal regression, invisible attempt, duplicate execution, or terminal
  queue/nonterminal attempt dead end;
- every queue item converges or explains the exact evidence needed to proceed.

Progress on `a84e8fc`: the revision-fenced transition engine,
`dispatchOperationId`, scheduler-owned MCP submission, `dispatching` and
`cancelling`, complete-attempt startup scan, and pre-launch termination matrix
are implemented. HARD-001 and HARD-002 are closed. Phase 1 remains open for
staging repair and direct-queue graph validation. Revision `243b0ec` closes
HARD-005: malformed/missing leases now
have typed, evidence-preserving repair, and dry-run reconciliation is public
through CLI and MCP. Revisions `726e1cf` and `3afab31` separate versioned cleanup
evidence from immutable terminal outcomes. Revision `1a3f908` closes HARD-006
for schema-readable single-host state with five evidence-bound actions, an
exhaustive 80-pair status model, public CLI/MCP execution, and crash-safe action
replay. Malformed whole-record bytes remain blocked rather than guessed.

### Phase 2 — process, Git, resource, and cleanup closure

Deliver:

- Windows Job Object ownership with kill-on-close, plus equivalent
  process-group/cgroup policy on supported platforms;
- descendant cleanup on normal worker exit as well as cancellation and owner
  crash;
- failure to prove termination keeps the attempt quarantined and blocks retry;
- all internal Git operations use a resolved trusted executable, noninteractive
  configuration, bounded output, timeout, cancellation, and configuration/hook
  isolation appropriate to the operation;
- one total attempt deadline in addition to command deadlines;
- maximum commands, changed paths, file count, patch bytes, log bytes, artifact
  bytes, worktree bytes, lineage depth, and retry count;
- deliberate retention classes and garbage collection with dry-run output;
- external-resource cleanup reconstructed from frozen owner profiles rather
  than executable commands read from mutable evidence;
- Docker engine update and a fully passing external-verifier canary before
  generated Vesserin tests execute there.

Initial pilot ceilings:

- 45 minutes total per attempt;
- two simultaneous workers;
- 20 changed paths;
- 5 MiB proposal patch;
- 10 MiB for each worker or check log;
- 50 MiB total attempt artifacts;
- one automatic retry for classified infrastructure failure only.

Exit evidence:

- worker/child/grandchild, normal-exit descendant, output flood, oversized
  patch, hung Git, hung cleanup, owner-crash, and cleanup-failure canaries all
  terminate or quarantine honestly;
- no automatic retry occurs while process or external-resource absence is
  unproven;
- no active resource survives beyond its declared cleanup deadline without an
  actionable health finding.

Progress on `caae1c8`, `726e1cf`, `3afab31`, and `77c2b54`: the supported
Windows lane now places commands in a verified kill-on-close Job before launch
and proves normal-exit, cancellation, timeout, and owner-crash closure for
detached Node and Bun descendants. Cleanup subjects, deadlines, and observations
are durable and independent of terminal worker outcome; unresolved cleanup
blocks queue success, retry, and worktree removal. Worktree remove/prune commands
are bounded and Job-owned. HARD-003 is closed for this Windows profile and
HARD-004 is closed. Phase 2 remains open for trusted/config-isolated bounds on
every internal Git operation, total-attempt and artifact quotas, retention/GC,
profile-reconstructed external cleanup, Docker qualification, and a cgroup-
backed POSIX lane.

### Phase 3 — eligibility and evidence sealing

Deliver:

- typed worker outcomes and no-op policy;
- mandatory positive scope and acceptance for model-facing mutable jobs;
- immutable or content-addressed terminal evidence snapshots;
- review retrieval that validates every binding and availability transition,
  including job, terminal manifest, patch, status, changed paths, verification,
  worker logs, command logs, lineage, and model/harness identity;
- parent-directory durability barriers and corruption quarantine;
- bounded artifact reads for every evidence type a reviewer needs;
- complete model and runtime provenance.

Exit evidence:

- a worker reporting `needs-input` cannot become eligible;
- an implementation no-op is ineligible unless explicitly authorized;
- mutating, replacing, deleting, or adding any bound artifact invalidates the
  cached review bundle;
- sealed evidence reconstructs after restart with its disposable worktree
  removed.

### Phase 4 — coherent package runs and morning handoff

Deliver:

- `get_package_run` and `get_package_run_bundle` through CLI and MCP;
- graph status, critical path, failures, pointed questions, terminal leaves,
  and proposal ancestry in one result;
- deterministic assembly/barrier nodes that compose declared parents and run
  package checks without spending a model call;
- an aggregate candidate patch and retained integration worktree;
- explicit `accepted`, `rejected`, and `superseded` review dispositions that do
  not alter worker terminal state;
- bounded notifications containing status and artifact pointers only;
- a Markdown or HTML morning report written in game and product language.

Exit evidence:

- after restart and workspace cleanup, one run ID retrieves the complete graph,
  aggregate proposal, evidence, failures, and questions;
- independent leaves can be assembled without a meaningless final worker;
- no reviewer needs to infer run membership by scanning the global queue.

### Phase 5 — safe control surfaces

Deliver:

- owner-configured project profiles binding repository roots, adapters,
  command profiles, execution boundaries, budgets, and protected paths;
- an architect surface for explicit local administration;
- a model-facing surface that accepts only profile IDs and bounded work-package
  fields;
- transport roles for local stdio, authenticated remote control, and read-only
  observers;
- server-side redaction and positive data selection for remote responses;
- audit events for every authority-relevant request and disposition.

Exit evidence:

- a model-facing caller cannot choose another repository, adapter, executable,
  execution boundary, verifier, secret-bearing environment name, or wider
  budget than its profile grants;
- laptop/Tailscale access controls the one host-owned Conductor service rather
  than sharing its runtime directory.

### Phase 6 — Vesserin adapter and package compiler

Project-specific behavior belongs with Vesserin and is invoked through a
versioned plugin or CLI protocol. Conductor core must not import Vesserin
modules.

Deliver in the Vesserin repository:

- a machine-readable Impact Atlas query/context-pack command with card paths,
  IDs, statuses, hashes, named tests, and exact Vesserin revision;
- a package compiler that reads approved design packets and source-authored
  `@conductor-contract` records from tracked files; for the first pilot, those
  records live in separate protected files and point at dedicated
  implementation targets;
- Vesserin task-weight classification and a premium-authored impact hypothesis
  requirement for heavy work;
- frozen context packs containing only relevant instructions, design sections,
  Atlas cards, interfaces, and tests;
- standard focused-test, full-check, build, determinism, docs, and external-
  verifier command profiles;
- default protection for `AGENTS.md`, decisions, schemas, package/lock files,
  design packets, contract-source records, command and verifier configuration,
  golden fixtures, unrelated tests, canon boundaries, and discovery-protected
  material;
- a reviewed, digest-pinned Vesserin verifier image or equivalent immutable
  offline environment containing the required Node runtime and dependencies,
  plus a clean-clone `npm run check` and `npm run build` canary distinct from
  the BusyBox isolation canary;
- review-packet enrichment that translates evidence into game-facing behavior;
- later, symbol identity and `next-declaration` binding when exact-path
  contracts produce real placement failures.

For the first pilot, the premium architect pre-creates dedicated implementation
files, protected interfaces, tests, design packets, and separate protected
contract records. Workers may edit only the dedicated implementation files;
whole-file path enforcement does not pretend to protect regions inside an
allowed file. When every target file exists, Kode's general file-creation
authority is removed. Inline records can return later only after protected-
region or symbol-bound enforcement is implemented and tested.

Exit evidence:

- a disposable Vesserin clone produces one successful proposal, one scope
  rejection, one structured `needs-input`, and one detected hidden-evidence
  mutation;
- the primary checkout is untouched;
- the same package and revision compile to the same generic work graph;
- the pinned Vesserin verifier runs the clean-clone full check and build without
  network access.

### Phase 7 — first product pilot: Observation Projection v0

The first product target is not the full M2 party-space rewrite. Vesserin's
world-space decision is explicitly under revision, and persistent-position work
must not freeze that unresolved model accidentally.

Observation Projection v0 is already identified as a next core capability. It
is a real backend seam shared by the player interface, test agents, companions,
and local-model play. It is deterministic, can be verified against the real
command boundary, and produces an artifact Oscar can judge directly.

#### Game-language design question

> Given this actor in this situation, what should they know, what should they be
> allowed to attempt, and what must remain hidden?

Oscar and the premium architect settle only three semantic questions before the
preparation commit:

1. who has authority to request `party.move`;
2. what temporary position information v0 may expose without turning the
   unresolved nested position into a permanent public contract;
3. which recent events and party facts are positively visible in the bootstrap.

The architect handles schema names, module boundaries, bounded command-domain
enumeration, tests, and file layout.

#### Acceptance story

A solo player asks what they can do. The actor-safe observation lists exactly
the moves the real command and authority boundary accepts from that state. An
invalid movement mode removes those actions. A structurally distinct overhead
observation contains diagnostic truth and can never be passed to a playing
agent. Repeating either projection mutates nothing and returns the same result.

Keep the existing four-member bootstrap as a stress fixture, but require the
one-member case because a real run begins solo.

#### Architect-owned preparation commit

The committed seam contains:

- the approved design packet and new observation faultline/authority card;
- a premium-authored requester identity and `party.move` authority boundary,
  with its oracle, because the current command carries no requester identity;
- exact versioned actor and overhead projection interfaces;
- empty implementation files with typed stubs;
- focused failing tests and a game-readable golden demonstration;
- a seeded hidden sentinel proving positive-whitelist behavior;
- three protected source contracts outside the worker-editable implementation
  files, with protected tests and schemas;
- Vesserin command profiles outside worker-authored source.

Do not let one worker write both implementation and its authoritative oracle.
Record the authority-boundary implementation and premium attention as
preparation cost even though the post-preparation delegation metric excludes
that commit.

#### Provisional contract graph

```text
observation.legal-actions -> observation.actor-view ---------+
                                                              +-> assembly/check
observation.overhead-view -----------------------------------+
```

1. `observation.legal-actions` implements bounded legal-action enumeration by
   querying the real validation/authority seam rather than copying movement
   rules.
2. `observation.actor-view` depends on legal actions and constructs only the
   positively selected actor-visible fields.
3. `observation.overhead-view` runs in parallel with legal actions, creates a
   structurally distinct diagnostic artifact, and includes the hidden sentinel
   excluded from actor view.
4. A deterministic assembly node composes the leaves, runs the agreement proof,
   focused tests, `npm run check`, and `npm run build`, and renders the
   game-facing report. Add a worker-authored reporting module only if the design
   requires real product code; do not spend a model call merely to join branches.

The graph deliberately uses contracts at coherent module seams rather than one
per function. Finer granularity is useful only when a leaf is independently
testable and the review/merge overhead remains lower than the saved work.

#### Pilot ladder

1. Resolve or deliberately set aside the current dirty Vesserin documentation
   work and pin one committed preparation revision.
2. Compile and inspect the graph without executing it.
3. Run only `observation.legal-actions` as the live Vesserin canary.
4. If scope, process, and evidence gates pass, run legal actions and overhead
   work with concurrency two, then the dependent actor view.
5. Assemble and run the complete deterministic acceptance deck in the external
   verifier.
6. Obtain one package-level premium review; optionally run Sonnet only if the
   review-ablation machinery is already ready.
7. Show Oscar actor and overhead observations, legal actions, and behavior
   differences—not TypeScript identifiers.
8. Integrate only after explicit premium disposition and a clean independent
   rerun.

#### Pilot acceptance

- every advertised action succeeds through the real command/authority boundary
  from the same state;
- every legal candidate in the architect-declared bounded command domain is
  advertised;
- invalid modes and unauthorized actors do not receive falsely legal actions;
- equal inputs produce deeply equal observations;
- projections do not mutate state or change its hash;
- hidden sentinel is absent from actor view and present in overhead view;
- solo and four-member fixtures pass;
- full checks and build pass from the assembled proposal;
- no test, schema, Atlas authority, or golden fixture changed;
- no design packet, source contract, or requester-authority oracle changed;
- Oscar can evaluate the behavior report directly.

After this succeeds, repair the open world-space decision and use the same
workflow for the larger M2 package: constrained site entry, advisory formation
placement, ordering over shape, typed impossible-placement refusal,
save/reload, replay, and observation integration.

## Diagnostics as a product capability

Diagnostics must answer five different questions. Combining them into one log
would make every failure expensive to interpret.

| Layer          | Question                                                   | Minimum evidence                                                         |
| -------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| Runtime health | Is Conductor safe and able to make progress?               | lease, scheduler, process groups, resources, storage, profiles, versions |
| Run trace      | What happened to this package?                             | ordered state transitions, graph, attempts, timings, artifacts           |
| Correctness    | Is the proposal consistent with its contract and Vesserin? | scope, checks, hashes, invariants, capsules, held-out results            |
| Productivity   | Did the route save scarce attention?                       | accepted outcomes, elapsed time, retries, review/correction time         |
| Learning       | What should change next?                                   | labeled failure taxonomy, model profile, disposition, comparison cohort  |

### Required tools

Build the real operations as CLI commands with JSON output, then expose bounded
MCP shims:

- `doctor`: dependency, model, policy, verifier, storage, quota, and canary
  readiness;
- `status`: lease, poller, queue, active attempts, process groups, external
  resources, blocked work, disk use, and stale evidence;
- `run inspect`: graph, critical path, attempts, findings, and aggregate result;
- `run explain`: the exact reason a job is waiting, ineligible, quarantined, or
  unsafe to retry;
- `evidence verify`: rehash and reconstruct an attempt or package run;
- `reconcile --dry-run`: enumerate incomplete transitions, orphans, corrupt
  records, and the least-authority repair;
- `gc --dry-run`: show which worktrees, logs, model traces, and bulk experiments
  would be removed and which durable citations retain them;
- `events`: bounded filtering by run, attempt, state transition, severity, or
  time without streaming whole transcripts;
- `benchmark`: execute a frozen route/capacity corpus;
- `fault-inject`: CLI wrapper over the existing test-only crash and race
  harness, unavailable in production policy;
- `finding list/show/dispose`: evidence-backed bug queue;
- `export experiment`: a manifest containing every outcome and exact route
  identity, suitable for later analysis or training splits.

The first human-facing surface is the morning report, not a dashboard. Build a
dashboard only after repeated reports show which comparisons Oscar and the
architect actually make.

### Event and metric vocabulary

An append-only `conductor.event/v1` record should contain event identity,
package/job/attempt identity, sequence, event type, prior and next lifecycle
state where relevant, actor, disposition, evidence pointer, and wall/monotonic
timing. Raw model text remains in local artifacts rather than the event stream.

Record, when the source exposes it:

- queue wait, setup, time to first token, generation, proposal capture,
  verification, review, correction, and total wall time;
- prompt, cached, reasoning, and output tokens;
- model file hash, quant, llama.cpp build and arguments, chat template, sampler,
  thinking mode, context, slot, Kode version, and Conductor version;
- GPU/VRAM, RAM, CPU, disk, log, patch, and worktree peaks;
- tool denials, malformed calls, scope violations, no-ops, retries, timeouts,
  and questions;
- focused, full-suite, held-out, semantic-review, and integration outcomes;
- premium preparation, review, correction, and integration time when observed
  or explicitly entered—never fabricate missing attention data;
- final accepted, rejected, superseded, known-intended, or unresolved label.

Store aggregate numeric analysis in a disposable local database. Store the
minimal evidence supporting accepted behavior, a bug, an owner decision, or a
route change as content-addressed files. Prompts, source, private game state,
and reviewer payloads stay local unless a specific external-review profile
positively selects them.

## Autonomous bug reporting

Vesserin already has the correct foundation: `OK`, `REJECTED`, and `CRASHED`,
named invariants, deterministic replay, reproduction capsules, and mechanical
diagnosis. Conductor should connect these instruments rather than invent a
second bug ontology.

### Finding lifecycle

```text
observed
  -> reproduced | unreproduced
  -> clustered
  -> triage-pending
  -> confirmed-defect | known-intended | needs-design | invalid
  -> fix-proposed
  -> verified
  -> closed | regressed
```

The observation never changes when its disposition changes. A cluster is a
hypothesis, not permission to delete representative evidence.

### What may be reported automatically

Immediately create a high-confidence report for:

- `CRASHED`, invariant failure, replay divergence, capsule regression, golden
  mismatch, verifier corruption, duplicate attempt, terminal regression,
  process/resource leak, or evidence-integrity failure;
- a deterministic command advertised as legal but rejected from the exact same
  state;
- a protected-path or hidden-sentinel violation.

Create an unconfirmed semantic report for:

- a playing agent stuck without useful choices;
- likely degenerate strategy, incoherent companion behavior, boring sequence,
  confusing refusal, missing affordance, or story-quality criticism.

Semantic reports must cite state cards, observations, objectives, traces, and
model identity. Model confidence is routing metadata, not truth.

### Automatic diagnosis and fix proposals

When deterministic replay reproduces a report, automation may:

- minimize the command/event prefix;
- emit or update a collision-safe capsule;
- identify the invariant, rule, source seam, Atlas cards, one-step state delta,
  and likely affected package;
- cluster equivalent signatures while retaining representative seeds;
- create a bounded Conductor fix contract against the exact failing revision;
- run the fix worker and verifier in isolation.

It may not change a test oracle, mark a semantic report as intended, alter a
holdout, accept its own fix, or integrate canonically. A fix proposal that
removes the crash but changes unrelated golden behavior remains a finding, not
a success.

Known-and-intended records should live in Vesserin's Atlas vocabulary and cite
a rule or decision. Touching an intended rule does not auto-close a report; the
rule may be intended while its warning, interaction, or consequence is wrong.

### Batched semantic triage

Local models may summarize and cluster semantic reports. A frontier reviewer
receives bounded batches with representative evidence and returns typed
`confirmed`, `known-intended`, `needs-context`, or `needs-owner-judgment`
proposals. Disagreement, novelty, irreversibility, and expected downstream
impact rank the small set shown to Oscar.

This is where independent Sonnet review may be valuable. It remains advisory,
is measured against holdouts and later outcomes, and is never used to justify
skipping premium review without evidence.

## Continuous-improvement experiments

Every experiment freezes a task corpus, exact route identities, outcome labels,
and analysis plan before comparison. Preserve the complete corpus; never train
or report only successful rescues.

### 1. Concurrency experiment

Run matched independent contracts sequentially and with concurrency two on one
resident model. Separate cold and warm starts. Record queue wait, TTFT,
generation throughput, verifier time, GPU/VRAM, acceptance, correction, and
review effort.

Concurrency two is promoted for a task class only if it produces at least 1.5
times as many accepted proposals per wall-clock hour without more than a five-
percentage-point acceptance drop or materially higher review cost. Otherwise
one strong worker remains the route.

### 2. Model and context routing

Compare KAT/APEX, Laguna, Qwen, or later candidates only on the same frozen
representative corpus. A model profile is invalidated by any change to model,
quant, backend, chat template, sampler, thinking mode, context, slot layout,
harness, tool parser, system prompt, or Conductor contract.

Measure accepted outcomes and correction burden, not generic benchmark rank or
tokens per second alone. Test one large-context worker against multiple smaller
contexts when the actual package graph makes both routes meaningful.

### 3. Contract granularity

Compare one broad module contract with a small coherent DAG, not function-count
extremes. Measure task failures, needs-input quality, lineage conflicts,
reconciliation cost, review time, and accepted code. Granularity is promoted by
lower total attention, not by creating more jobs.

### 4. Context-pack ablation

Run matched jobs with the validated Vesserin/Atlas context pack and with the
minimum repository instructions. Measure authority mistakes, missing coupling,
scope drift, and review corrections. This is the honest test of whether the
Impact Atlas changes worker behavior.

### 5. Independent-review ablation

Randomly route eligible, frozen packages through no external semantic review or
Sonnet review before premium assessment. Blind the premium assessor to the
route where practical. Measure defects found, false positives, corrections,
hidden-check survival, review time, and total cost.

Do not compare worker self-review; it has already been rejected as an
independent evidence source.

### 6. Bug-report quality

Use seeded known defects, known-intended rules, novel deterministic failures,
and semantic ambiguities. Measure reproduction rate, cluster purity, false
positive/negative cost, time to actionable contract, and regression survival.

Routing may automatically demote a failing model or reduce concurrency. A new
route is promoted only after representative accepted evidence and an explicit
policy decision.

## Fault-injection and regression campaign

Before unattended use, terminate fresh Conductor processes immediately after
each authoritative write or external side effect:

1. job staging, sync, and publish;
2. queue dispatch intent;
3. attempt staging, sync, and publish;
4. queue-to-attempt binding;
5. workspace creation and persistence;
6. guardian identity and worker PID persistence;
7. worker exit and each proposal artifact;
8. verification start, command logs, and seal;
9. terminal attempt and queue completion;
10. review snapshot creation;
11. external-resource registration, start, cleanup, and release;
12. lease creation, renewal, steal, and release.

Randomize and repeat races for duplicate start, dispatcher ownership,
cancel/start, cancel/finish, retry/late callback, lease renew/release, idempotent
submission, source polling/revision change, review retrieval/evidence mutation,
cleanup/recovery, and lineage composition/parent mutation.

Every case must prove:

- at most one live worker per attempt;
- terminal state never regresses;
- automatic retry never occurs while cleanup is unproven;
- no job or attempt disappears from reconciliation;
- every workspace and external resource is actively owned, deliberately
  retained, quarantined, or removed;
- every reviewable claim remains reconstructable from sealed evidence.

## Go/no-go gates

### Attended runtime canary

Go after Phases 1–3 pass the targeted race, process, and evidence tests. Use one
worker and one generic fixture contract; this is not yet a Vesserin product
run.

### Attended Vesserin leaf canary

Go after Phases 1–6, the committed architect preparation revision, the pinned
Vesserin verifier canary, graph dry-run, and disposable success/scope/
`needs-input` fixtures pass. Run only `observation.legal-actions`.

### Full Observation Projection pilot

Go after the attended Vesserin leaf canary passes, Docker's configured security
floor is met, and the complete aggregate graph and clean-clone verifier deck
pass.

### Overnight trusted development

Go only after the package run is reconstructable, process/resource cleanup is
proven, quotas are enforced, model-facing tools are profile-bound, and a full
run completes with no invisible or permanently blocked work.

### Hostile generated-code or engine-lineage experiment

No-go until a hypervisor-backed private-clone/microVM executor exists with an
immutable evaluator, deny-by-default network, no shared skills or credentials,
validated size/schema/hash import, lineage budgets, and deliberate containment
canaries. A successful trusted-development pilot does not satisfy this gate.

## Implementation order

Keep each item independently testable and commit it separately:

1. truth reconciliation and hardening register;
2. transition engine and scheduler-only launch — completed by `a84e8fc`;
3. dispatch journal, lease repair, and startup reconciliation — pre-launch
   journal and attempt scan completed by `a84e8fc`; lease repair and public
   dry-run inspection completed by `243b0ec`; schema-readable public state
   convergence completed by `1a3f908`;
4. process-tree ownership and cleanup proof;
5. resource/Git/artifact budgets and garbage collection;
6. typed worker outcome and sealed evidence;
7. package-run schema, aggregate assembly, dispositions, and morning report;
8. profile-bound model-facing control surface;
9. diagnostics event stream, health/explain/reconcile/evidence tools;
10. model/harness profiles and benchmark exporter;
11. Vesserin Impact context-pack command and project compiler;
12. disposable Vesserin qualification fixtures;
13. Observation Projection architect preparation commit;
14. one-leaf canary, then the full concurrency-two pilot;
15. independent-review ablation and bounded correction;
16. deterministic Vesserin report-to-capsule-to-fix-proposal loop;
17. semantic report clustering and batched external review;
18. larger M2 backend package after the world-space decision is repaired.

## Review triggers

Reopen this plan when:

- Observation Projection reveals that protected contract records or pre-created
  stubs consume more premium attention than direct implementation;
- package assembly or review cost exceeds worker generation cost;
- a model/harness/context change invalidates route evidence;
- remote or multi-user access changes the trusted-client assumption;
- Vesserin reaches M4 autonomous play or M6 mechanic generation;
- Sonnet review fails to improve hidden-check survival or review time;
- a deterministic bug-fix loop changes intended behavior despite passing its
  reproducer;
- a microVM/private-clone backend is ready for the executable wish experiment.

Negative results retire or redesign the tested route, evaluator, model,
contract shape, or economic claim. They do not silently erase the owner-authored
wish to keep exploring other routes.
