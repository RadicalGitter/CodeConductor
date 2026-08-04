# Review evidence seal

- Implementing revision: `657f0ca`
- Packet schema: `conductor.review-packet/v2`
- Result: HARD-007 closed for the provider-neutral review bundle

The review bundle is available only when the attempt is `completed`, its
deterministic verification is `eligible`, cleanup is `not-required` or
`proven`, and the launch-time worker profile is complete. Review remains
advisory: a valid seal does not accept, merge, publish, or establish semantic
correctness.

## Launch-time profile

Before worker launch, Conductor persists a
`conductor.worker-execution-profile/v1` in the attempt transition. It binds:

- the adapter identity and safety/mutation contract;
- the complete adapter-options fingerprint;
- the exact executable, arguments, working directory, and environment-name
  fingerprint recorded in the invocation;
- an explicit model selector for adapters that use a model;
- SHA-256 and byte size for the executable, interpreted harness entry, and
  adapter-declared configuration files;
- adapter attributes such as the Kode turn ceiling or Codex profile name.

Kode binds its configured model selector, compiled entry when present, and
`KODE_CONFIG_DIR/config.json`. Codex requires
`CONDUCTOR_CODEX_CONFIG_FILE` to bind its external profile. A model-bearing
adapter without an explicit model or required config may still run, but its
proposal is deterministically ineligible rather than receiving a review seal.
Changing a bound executable, harness, or config after launch also makes review
unavailable.

## Sealed evidence

The v2 packet embeds the frozen job, complete immutable terminal attempt,
current cleanup record, verification record, changed paths, worker profile,
and reviewer contract. Its file bindings cover:

- job, terminal attempt, and cleanup projections;
- patch, repository status, changed paths, and verification;
- worker stdout and stderr;
- every setup and acceptance stdout/stderr file;
- every lineage contribution patch and verification record;
- worker executable, harness, and configuration evidence.

Each binding has a path, semantic purposes, byte size, and SHA-256. The packet
also inventories every file and directory under the attempt artifact directory
except the derived `review-packet.json` itself. This detects new files and
directories as well as mutation, replacement, or deletion. Symlinks and
unexpected entry types are rejected.

The packet seal hashes its complete normalized content. `sealedAt` is the
terminal attempt time, making same-state creation deterministic; concurrent
callers therefore converge on one packet even across process races. Within one
Conductor instance, first creation is also explicitly serialized.

## Retrieval validation

Every `get_review_bundle` call:

1. reads the authoritative transition journals;
2. checks eligibility and cleanup closure;
3. validates all artifact paths before reading them;
4. requires compact job, attempt, cleanup, verification, and changed-path
   projections to equal authoritative parsed state;
5. revalidates lineage and the launch-time profile;
6. verifies the packet seal, every file binding, and the complete attempt
   inventory;
7. reads the bounded patch;
8. validates the whole seal again before returning.

The final pass prevents an ordinary check-then-read race from returning a patch
after its evidence changed. A cached v1 packet is refused as
`legacy-unsealed`; it is not silently upgraded from evidence whose historical
state cannot be proven. Worktree contents are not part of the bundle, so a v2
packet remains reconstructable after restart when the disposable worktree was
removed only after its required evidence was captured.

## Tamper evidence and boundaries

The adversarial test matrix changes every mutable local binding individually,
performs a same-size replacement, deletes a required file, adds an unsealed
file, changes harness and config files, corrupts the packet, supplies a legacy
packet, redirects a path through the authoritative transition snapshot, and
changes cached lineage. Every case fails closed; exact restoration makes the
same seal available again. Twenty simultaneous first readers produce one seal,
and restart without the worktree reproduces the same packet and bounded patch.
The complete repository gate passed with 82 tests and 1,136 assertions.

This is a deterministic integrity and consistency seal, not a signature against
an administrator who can rewrite every record and recompute every hash. It
binds the exact requested model/harness profile and its local files; attesting
the model actually resident behind a remote inference endpoint throughout a
call belongs to the broader model/runtime provenance work in Phase 3. Review
cost and artifact-size ceilings remain governed by HARD-008.
