# OpenAI Responses worker adapter

- Status: implemented; offline oracles and paid Medium/Max canaries pass
- Owner intent: make GPT-5.6 Luna a measurable Conductor worker without giving
  the model new authority
- First profiles: `luna-medium-v1` and `luna-max-v1`
- Comparison authority: the matched Vesserin M1.5 experiment; Max produced the
  strongest near-pass, but neither route was promoted

## Bootstrap evidence and package shape

The first monolithic local attempt is retained as a failed route. It changed two
in-scope files, then Kode's accumulated request reached 69,031 tokens against a
65,536-token slot. Conductor recorded a failed worker exit, skipped acceptance,
and left the proposal ineligible; none of it entered the repository.

The replacement package has three independent leaves with protected
architect-authored oracles: provider profiles and cost accounting, the
Responses/tool protocol runner, and the Conductor adapter/registry seam. The
direct llama.cpp server was reconfigured from four 65,536-token slots to two
131,072-token slots within its existing 262,144-token KV allocation. That
removed the runner leaf's previous context ceiling without increasing total KV
memory.

The two-slot local run `source_3b050402fae6a29450c9` is retained as routing
evidence, not accepted implementation. The profile leaf passed its original
oracle but failed architect review because its fingerprint erased nested
configuration and its long-context/cost logic was wrong. The runner and adapter
leaves failed acceptance. The oracles were strengthened, and the reviewed
implementation entered at `007cc7d`; no worker proposal was auto-accepted.

## Implemented and live evidence — 2026-08-06

`007cc7d` adds the strict owner profile, Responses tool loop, adapter registry
seam, secret-safe evidence, integer cost accounting, and paid-canary command.
The complete offline gate passed 102/102 tests through `bun run check` before
the live call.

The first paid probe (`job_97cac1e6ee9a2b4fdea6`) authenticated and completed
four API/tool turns, then failed safely at its four-request ceiling before
writing. It cost 516 micro-USD. Raising only the canary request and tool-call
ceilings to eight was enough for completion; the token and 50,000-micro-USD
ceilings remained unchanged.

The matched `clampHealth` smoke fixture then ran through the same source
contract, context refs, scope, and acceptance test on all three requested test
points:

| Route                                                     | Worker duration | Result                                | Usage/cost                                                                    |
| --------------------------------------------------------- | --------------: | ------------------------------------- | ----------------------------------------------------------------------------- |
| KAT/APEX through direct llama.cpp, one 131,072-token slot |       18,164 ms | eligible; scope and acceptance passed | 9,588 model-reported tokens; local electricity and hardware cost not measured |
| GPT-5.6 Luna Medium                                       |       30,178 ms | eligible; scope and acceptance passed | 3,760 input, 1,038 cache-write, 253 output tokens; 1,108 micro-USD            |
| GPT-5.6 Luna Max                                          |       13,294 ms | eligible; scope and acceptance passed | 3,808 input, 1,050 cache-write, 297 output tokens; 1,171 micro-USD            |

The retained attempts are `job_695562fa89b7552f42ff_a0001`,
`job_45ad5481c8fdc941cbfe_a0001`, and
`job_2704cae2485de3899de4_a0001`. All three produced equivalent minimal
implementations, and all review packets remained advisory only. The Luna
artifact scan found no credential. This tiny fixture proves route operation and
measurement, not relative quality on Vesserin-scale implementation; that still
requires the frozen product package.

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

## Machine-local credential setup

The repository's checked `.env.example` is copied to the ignored `.env.local`
on each machine. A Luna machine uses its own revocable `OPENAI_API_KEY`, an
ignored local copy of `config/provider-profiles.example.json`, and the real Bun
executable already running Conductor. An explicit executable override must be
an absolute `bun.exe`, never a shell shim. The provider JSON contains only
`apiKeyEnvName`; the key value remains in the machine-local environment and is
injected only into the Responses runner process.

The laptop and desktop must not share a populated environment file or key.
`git check-ignore -v .env.local` proves the repository boundary before a key is
entered. `bun run doctor` reports only credential presence and adapter
availability. The paid live canary remains an explicit owner-authorized action;
ordinary `bun run check` uses offline fake-provider tests and proves the key
cannot enter persisted evidence.

The matched M1.5 run also exposed a current efficiency limit: the stateless
direct file-tool loop resends growing Responses context and can exhaust a
cumulative-input budget before a large patch reaches formal acceptance. Split
large designed systems into bounded contracts and use deterministic assembly;
do not respond by silently raising spend or context ceilings.

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

This request shape follows the current OpenAI Responses and function-calling
contracts retrieved on 2026-08-06. GPT-5.6 Luna supports the Responses endpoint,
function calling, a 1,050,000-token context window, and reasoning efforts through
`max`. For `store: false`, the runner preserves and resends every response output
item, including reasoning items, before adding function-call outputs.

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
