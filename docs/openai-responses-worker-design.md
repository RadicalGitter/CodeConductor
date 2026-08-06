# OpenAI Responses worker adapter

- Status: approved bootstrap design; implementation delegated as a proposal
- Owner intent: make GPT-5.6 Luna a measurable Conductor worker without giving
  the model new authority
- First profiles: `luna-medium-v1` and `luna-max-v1`
- Comparison authority: the later matched Vesserin experiment, not this adapter
  implementation

## Observable promise

A source-authored Conductor job selects one owner-controlled provider profile.
Conductor launches a worker in the ordinary isolated worktree, sends only the
job prompt and positively selected context to the OpenAI Responses API, permits
only bounded file reads and writes, and retains enough typed evidence to compare
the run with a local worker. The resulting repository mutation remains an
unaccepted proposal and passes through the existing scope, acceptance, review,
and integration boundaries.

## Authority boundary

- A job may name only a provider-profile ID. It may not supply an endpoint,
  credential, model, reasoning effort, rate card, or provider budget.
- The owner-controlled profile file is outside source-authored job authority and
  is fingerprinted as worker configuration evidence.
- The API key is read from the environment name declared by the selected owner
  profile. Its value must never appear in process arguments, contracts, prompts,
  logs, evidence, patches, or error messages.
- The worker may read only exact `contextRefs` and `allowedPaths`. It may write
  only exact `allowedPaths`. It receives no shell or general command tool.
- Existing Conductor post-run scope checks and owner-authored acceptance commands
  remain authoritative. Provider success never means canonical acceptance.

## Owner provider profile

The loader accepts strict JSON with schema
`conductor.provider-profiles/v1`. Each profile binds:

- provider `openai-responses`, base URL, model, and reasoning effort;
- the API-key environment variable name;
- request timeout, request count, retry count, tool-call count, input-token,
  output-token, and micro-USD ceilings;
- a dated USD rate card expressed as integer micro-USD per million tokens for
  uncached input, cached input, cache writes when reported, and output.

Unknown properties fail validation. Profiles are selected by ID before any
network request. The example file documents Luna medium and max but contains no
secret.

## Responses protocol

Use `POST <baseUrl>/responses` with `store: false`,
`parallel_tool_calls: false`, the profile-bound model and reasoning effort, and
the profile-bound maximum output tokens. Preserve every returned output item in
the next request so reasoning/function-call continuity works when storage is
disabled.

Expose strict custom function tools with `additionalProperties: false`:

- `read_file(path)` for an exact positively selected path;
- `write_file(path, content)` for an exact allowed path.

All properties are required. Reject malformed JSON, unknown tools, traversal,
absolute paths, symlink escapes, out-of-scope paths, oversized tool payloads,
and calls beyond the profile ceiling before mutation. Writes should be atomic.
The final response may summarize work but cannot widen the proposal.

Retry only transient transport failures, HTTP 408/409/429, and HTTP 5xx within
the profile retry/request ceilings. Other provider errors are typed failures.
Do not include authorization headers or response bodies in errors.

## Retained run evidence

The worker writes one bounded JSONL terminal record to stdout with schema
`conductor.openai-responses-run/v1`. It includes:

- status and a secret-safe error classification/message when failed;
- provider-profile ID and fingerprint, provider, requested and returned model,
  reasoning effort, and dated rate-card identity;
- request/response IDs, request and retry counts, tool-call counts, and elapsed
  milliseconds;
- accumulated input, cached-input, cache-write, output, and reasoning tokens;
- deterministic integer micro-USD cost and the budget ceiling.

Conductor already seals worker stdout with the attempt evidence. A future
schema slice may project this record into the attempt manifest; the first route
must not weaken the existing manifest or review seal to do so.

Cost uses the dated profile rate card. Cached input is not also charged as
uncached input. Reasoning tokens are informational because they are included in
reported output tokens. Unknown usage fields are retained as zero plus an
explicit evidence limitation, never guessed. Before the first request, reject a
conservative upper-bound estimate that exceeds input, output, or currency
ceilings. Recheck cumulative actual usage before every continuation request.

## Required verification

Offline tests use a local fake HTTP server and a temporary Git worktree. They
must prove:

1. profile parsing is strict and profile ID is the only job-level selector;
2. a missing key or over-budget request fails before network access;
3. the secret is absent from invocation arguments, profile evidence, stdout,
   stderr, and thrown messages;
4. only selected context reaches the request and only allowed files can be read
   or written;
5. the function-call loop preserves output items and applies a bounded write;
6. transient failures retry within budget while permanent/malformed responses
   fail safely;
7. usage accumulation and integer micro-USD calculation are exact;
8. default registry availability reflects the owner profile binding without
   affecting Kode or Codex behavior.

No paid request belongs in the test suite. The first paid call is a separately
identified canary after this proposal is reviewed and integrated.

## Non-goals for this slice

- no hosted shell, hosted `apply_patch`, web search, MCP, or arbitrary tools;
- no streaming requirement;
- no automatic merge or self-review;
- no provider routing decision from generic benchmark claims;
- no package-level benchmark exporter yet;
- no use of Luna as an independent reviewer of Luna-authored work.

## Escalation conditions

Stop with `needs-input` if the implementation requires changing job authority,
the command/event-style proposal boundary, process containment, scope checking,
acceptance semantics, or the sealed-review contract. Stop rather than embedding
the credential or moving provider-controlled values into a source contract.
