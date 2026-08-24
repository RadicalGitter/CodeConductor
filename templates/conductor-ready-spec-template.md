---
specification:
  slug: <stable-kebab-case-id>
  status: draft # draft | conductor-ready | superseded
  title: <human-readable title>
  targetProject: <owner-defined project/profile id>
conductor:
  initialPhase: <phase-id>
  scopeHints: [] # repository-relative product/package areas, not permissions
  verificationProfiles: [] # owner-defined names, never executable paths
---

# <Product or capability name>

> Use this template to turn product intent into a specification from which a
> bounded Conductor contract can be compiled. Delete inapplicable optional
> subsections; do not retain placeholder text in a `conductor-ready` document.
>
> A specification may be Conductor-ready while retaining open questions when
> the initial phase is explicitly a spike that resolves them. Do not put worker
> model names, machine-local credentials, executable paths, resource budgets, or
> mutable runtime configuration here; those belong to owner-controlled project
> profiles.

## 1. Request

<!-- REQUIRED
State what should be created or changed in one direct paragraph. Name the user,
operator, or system that benefits and the intended product boundary.
-->

<What are we building?>

## 2. Problem and Evidence

<!-- REQUIRED
Describe the current failure, friction, or missed opportunity. Include concrete
observations, examples, measurements, or prior incidents where available.
Separate observed facts from hypotheses.
-->

### Current behavior

<What happens today?>

### Why it matters

<What cost, risk, or user harm justifies the work?>

### Evidence

- <Observed example, trace, measurement, or source>

## 3. Intended Outcomes

<!-- REQUIRED
Describe observable outcomes rather than implementation activity. Include what
must remain unchanged.
-->

- <Outcome 1>
- <Outcome 2>
- <Preserved behavior or invariant>

## 4. Design Principles and Invariants

<!-- REQUIRED
List the rules that should govern tradeoffs. These are stronger than ordinary
preferences and should be testable or reviewable where possible.
-->

1. **<Principle>** — <meaning and consequence>.
2. **<Invariant>** — <what must never become false>.

## 5. Existing Contracts and Authority

<!-- REQUIRED WHEN INTEGRATING WITH AN EXISTING SYSTEM
Identify canonical state, public extension seams, policies, schemas, and
upstream behavior that must be preserved. Say what this feature may propose or
present but must not own. Require direct source inspection where an assumed seam
has not yet been proven.
-->

### Authoritative sources

- <Repository/API/schema/policy and what it owns>

### Boundaries to preserve

- <This feature owns ...>
- <This feature must not own or mutate ...>

### Unproven assumptions

- <Assumption and how the initial phase will verify it>

## 6. Terminology and Conceptual Model

<!-- OPTIONAL, BUT REQUIRED WHEN ORDINARY WORDS HAVE PRECISE MEANINGS
Define stable terms, entities, states, and relationships before using them in
requirements. Include state diagrams or typed shapes when they remove ambiguity.
-->

### <Term>

<Precise definition and relevant exclusions.>

## 7. User or Operational Workflows

<!-- REQUIRED
Describe the important paths in chronological order. Cover normal operation,
empty/first-use behavior, interruption, retry, and recovery where applicable.
-->

### 7.1 Primary path

1. <Trigger>
2. <System behavior>
3. <Visible or durable result>

### 7.2 Alternate and recovery paths

- **Empty or first use:** <behavior>
- **Interrupted or cancelled:** <behavior>
- **Failure:** <behavior and evidence retained>
- **Retry or resume:** <behavior>

## 8. Detailed Functional Requirements

<!-- REQUIRED
Organize by independently understandable capability, user-visible behavior, or
runtime seam. Repeat the capability subsection as needed. Prefer explicit MUST,
SHOULD, and MUST NOT statements for consequential behavior.
-->

### 8.1 <Capability name>

#### Purpose

<One concise statement.>

#### Inputs or trigger

```ts
// Include a proposed schema only when it clarifies the contract.
interface ExampleInput {
  value: string;
}
```

#### Required behavior

1. <Normal behavior>
2. <Edge case>
3. <State transition or ordering rule>
4. <Behavior that is explicitly prohibited>

#### Result or presentation

<Observable output, durable record, UI state, or typed result.>

#### Configuration

<Defaults, validation, persistence, and live-update behavior, or “None”.>

#### Failure and fallback

<How rejection, incompatibility, partial failure, and unexpected errors appear.
State the safe fallback explicitly.>

## 9. Architecture and Integration

<!-- REQUIRED
Describe the preferred data/control flow and the seams it uses. Keep product
meaning separate from implementation guesses. If a required public seam may not
exist, define a bounded investigation and an honest fallback rather than
silently weakening the product guarantees.
-->

### Preferred flow

```text
<input> -> <classification/validation> -> <state or projection> -> <output>
```

### Integration points

- <Public service, hook, slot, renderer, filesystem provider, event, etc.>

### Required seam investigation

1. <Question to answer through direct source inspection or prototype>
2. <Evidence required to treat the seam as usable>

### Fallback or upstream change

<What happens if the preferred seam is unavailable? What narrowly scoped
upstream extension, if any, is acceptable?>

## 10. Safety, Authority, Privacy, and Data Integrity

<!-- REQUIRED WHEN THE FEATURE MUTATES STATE, HANDLES PRIVATE DATA, OR CROSSES A
TRUST BOUNDARY
State mechanical enforcement, not merely model instructions.
-->

- <Permission and scope enforcement>
- <Canonical versus proposal state>
- <Atomicity, rollback, or partial-failure semantics>
- <Sensitive-data handling and network behavior>
- <Actions that always require separate authority>

## 11. Quality Attributes

<!-- INCLUDE THE SUBSECTIONS THAT MATTER -->

### Accessibility

<Keyboard, focus, semantics, announcements, contrast, motion, or “Not applicable”.>

### Performance

<Bounded work, lazy behavior, limits, large-input behavior, and measurements.>

### Compatibility and error isolation

<Supported versions/environments, unknown-input behavior, and fail-safe behavior.>

### Interaction with other features

<Composition rules, conflicts, precedence, and non-interference requirements.>

## 12. Public Surface and Delivery Shape

<!-- REQUIRED FOR A NEW PACKAGE, PLUGIN, SERVICE, OR USER-FACING ARTIFACT -->

### Identity

- Package or component name: `<name>`
- Plugin/service ID: `<id>`
- License/distribution constraints: <value>

### Conceptual structure

```text
<package>/
├── src/
├── tests/
└── README.md
```

### Documentation requirements

- <Installation and configuration>
- <Authority, limitations, and troubleshooting>
- <Examples, screenshots, compatibility matrix, or operational runbook>

## 13. Verification Matrix

<!-- REQUIRED
List concrete cases before implementation. Cover happy paths, boundaries,
failures, cancellation/retry, compatibility, and invariant preservation. Group
by capability when useful.
-->

### <Capability or workflow>

- <Normal case>
- <Boundary or large-input case>
- <Malformed or unsupported input>
- <Failure injection or recovery case>
- <Proof that protected state remains unchanged>

## 14. Acceptance Criteria

<!-- REQUIRED
Number observable pass/fail statements. Together they define “done” for the
specified scope. Every consequential invariant should be represented here or in
the verification matrix.
-->

1. <Observable criterion>
2. <Observable criterion>
3. <Required checks and documentation are present>

## 15. Implementation Phases

<!-- REQUIRED
Each phase must be independently useful or uncertainty-reducing. State its exit
evidence. The phase named by `conductor.initialPhase` must be executable without
an unresolved owner decision.
-->

### <phase-id> — <phase name>

**Objective:** <bounded outcome>

**Deliverables:**

- <Artifact or behavior>

**Exit evidence:**

- <Test, prototype result, source finding, or reviewable behavior>

## 16. Explicit Non-Goals

<!-- REQUIRED
Prevent plausible but unwanted scope expansion. Do not use this section to hide
a requirement that is necessary for the intended outcome.
-->

- <Not included>
- <Deferred capability>

## 17. Product and Technical Decisions

<!-- REQUIRED WHEN CHOICES HAVE ALREADY BEEN SETTLED
Record the decision and short rationale so implementers do not reopen it.
-->

| Decision   | Resolution      | Rationale |
| ---------- | --------------- | --------- |
| <Question> | <Chosen answer> | <Why>     |

## 18. Open Questions

<!-- ALLOWED IN A CONDUCTOR-READY SPECIFICATION ONLY WHEN EACH QUESTION HAS A
BOUNDED RESOLUTION PATH. Mark whether it blocks the initial phase. Questions
requiring owner taste or authority must be answered before launch.
-->

| Question   | Resolution method                                    | Blocks initial phase? |
| ---------- | ---------------------------------------------------- | --------------------- |
| <Question> | <Source inspection, prototype, owner decision, etc.> | Yes/No                |

## 19. Conductor Handoff

<!-- REQUIRED FOR status: conductor-ready
This is semantic handoff metadata, not machine policy. Project profiles resolve
worker identity, executable commands, resources, and hard permission bounds.
-->

- **Initial contract objective:** <one bounded implementation or investigation objective>
- **Initial phase:** `<phase-id>`
- **Scope hints:** <package or subsystem areas expected to change>
- **Read-only context:** <authoritative documents or examples beyond this specification>
- **Verification intent:** <named test groups or observable evidence>
- **Escalate when:** <conditions under which the worker must stop rather than guess>

---

## Conductor-ready quality gate

Before changing `specification.status` to `conductor-ready`, verify:

- [ ] The request, problem, intended outcomes, and non-goals are explicit.
- [ ] Existing authority and invariants are identified.
- [ ] Normal, edge, failure, and fallback behavior are specified where relevant.
- [ ] Safety and mutation semantics are mechanical rather than aspirational.
- [ ] The verification matrix and acceptance criteria are observable.
- [ ] The initial phase has a bounded objective and exit evidence.
- [ ] No unresolved owner decision blocks the initial phase.
- [ ] Every remaining open question has a resolution path.
- [ ] The Conductor handoff names the initial objective, scope hints, verification intent, and escalation conditions.
- [ ] Machine-local worker/runtime policy has not leaked into the product specification.
