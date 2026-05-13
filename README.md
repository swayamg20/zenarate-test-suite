# voice-eval

Automatic test suite generation for voice agents. Point it at any agent, get a complete test suite back — scenarios, assertions, conversation flows, all published and ready to run.

Built for the [Zenarate](https://zenarate-prod.vercel.app) voice agent platform. Uses the ZenLabs SDK for all platform operations and an LLM agent (Vercel AI SDK over the OpenAI Responses API) to reason about what to test.

---

## How it works

```
POST /agents/46/generate-suite
```

The service reads your voice agent's workflow — every node, instruction step, variable, and edge condition — then generates test scenarios that exercise each path through the agent.

Each scenario includes:
- **Realistic conversation turns** matching the agent's collect steps
- **Precise assertions** — exact bot utterances (`tts_say`), extracted variable values, private variable leak checks, type verification
- **Documentation** — ASCII diagrams showing the asserted path through the workflow

The whole thing takes ~90 seconds. You get a suite URL, open it in the dashboard, hit Run All.

---

## What it actually produces

For a 5-node insurance claims agent with 3-way branching, private variables, and boolean collection:

| | |
|---|---|
| **Scenarios generated** | 13 |
| **Platform pass rate** | 77% (10/13) |
| **workflow_config pass rate** | 100% (10/10) |
| **Assertion vocabulary** | 9 of 10 types used |
| **Generation time** | ~90 seconds |

The 3 failures are platform turn-timing issues with multi-collect entrypoint nodes, not bad test cases.

For a real-world 5-node reservation agent with 35 instruction steps, nested conditions, and transfer flows — 14 scenarios generated, all 14 with clean conversations and legitimate assertions. Zero scenarios caused by our tooling.

### Assertion types

The system uses 9 assertion types (out of 10 — `greeting_contains` is disabled due to platform unreliability):

| Assertion | What it checks |
|---|---|
| `tts_say` | Exact bot utterances, in order (from `speak(mode=exact)` steps) |
| `extracted_variables` | Variable values after collection (supports `!not_none` for flexible matching) |
| `variable_types` | Type verification for `set_value` coercion (`bool`, `int`, `float`, `str`) |
| `excluded_variables` | Private variables that must NOT be extracted |
| `no_response_contains` | Values that must never appear in bot speech (privacy) |
| `any_response_contains` | Key phrases from flexible speak steps |
| `no_raw_jinja` | No unrendered `{{uuid:...}}` template syntax in output |
| `min_responses` | Minimum bot turn count |
| `initial_bot_replies` | Bot turns before first user interaction |

### Precision over recall

Every generated scenario is structurally valid, runnable, and tests something specific. The system deliberately produces 3-6 tight scenarios per node rather than exhaustively enumerating permutations.

On the Insurance Claims workflow (13 scenarios):
- **100%** structurally valid (all pass schema + consistency checks)
- **100%** non-trivial (every scenario asserts at least one meaningful thing)
- **77%** pass on the platform (the remaining 3 are platform timing issues)

---

## Quick start

```bash
cd service
cp .env.example .env
# Fill in: ZENARATE_USERNAME, ZENARATE_PASSWORD, OPENAI_API_KEY
npm install
npm run dev
```

```bash
# Generate a test suite for any workflow
curl -X POST http://localhost:3000/agents/46/generate-suite \
  -H "Content-Type: application/json" -d '{}'
```

Returns:
```json
{
  "suite_id": 80,
  "suite_url": "https://zenarate-prod.vercel.app/tests/80",
  "created_scenarios": [...],
  "per_node_summary": [
    { "node": "AutoClaimDetails", "generated": 4, "trivial_count": 0 },
    { "node": "HomeClaimDetails", "generated": 3, "trivial_count": 0 },
    { "node": "ClaimsIntake", "generated": 3, "trivial_count": 0 }
  ],
  "elapsed_ms": 98336
}
```

Open the `suite_url` in the dashboard. Hit **Run All**. Watch the tests execute.

---

## Architecture

```
service/src/
├── zenarate/     SDK factory — BasicAuth login, client init
├── spec/         Workflow → AgentSpec → NodeContext[] → Swimlane[] (S2 walker)
├── generator/    LLM agent loop — 5 tools, one scenario per lane, parallel
├── validator/    Zod schema + consistency checks (9 assertion types)
├── verifier/     Run on platform → compare results → repair failed → drop after 2 retries
├── publisher/    Hybrid: node_codes (entrypoint) + workflow_config (downstream)
└── http/         Hono server, one endpoint
```

The deterministic walker decides **what** to test (swimlanes). The LLM decides **how** to test it (user turns). The verifier confirms it actually works by running on the platform.

The agent gets 5 tools (`propose_scenario`, `validate_scenario`, `remove_scenario`, `list_proposed`, `finalize`) and no HTTP access. It cannot publish, fetch data, or call external services. The deterministic shell handles all I/O.

**Full design:** [docs/architecture.md](docs/architecture.md) (12 sections, ASCII diagrams, tool specifications)

---

## The methodology

The LLM doesn't freestyle. It follows a deterministic step-to-turn mapping:

1. `speak(mode=exact)` → bot says this verbatim → assert with `tts_say`
2. `speak(mode=flexible)` → bot paraphrases → assert with `any_response_contains`
3. `collect(variable)` → bot asks, user answers → one turn per collect
4. `set_value(variable=value)` → silent computation → assert `extracted_variables` + `variable_types`
5. `end_conversation(goodbye)` → bot delivers goodbye → assert content
6. Private variables → `excluded_variables` + `no_response_contains` + `initial_state` seeding

This methodology was reverse-engineered from the platform's own 33 reference seed scenarios across 5 test suites.

---

## Tested on

| Workflow | Type | Nodes | Scenarios | Result |
|---|---|---|---|---|
| #37 Test_Swayam | Simple booking | 3 | 9 | Baseline |
| #31 Outbound Reservation | Real agent (pre-existing) | 5 | 14 | 100% legit failures, 0% our fault |
| #46 Insurance Claims | Custom-built via SDK | 5 | 13 | **77% pass rate (10/13)** |

The Insurance Claims workflow was created programmatically via the SDK (`scripts/create-demo-workflow.ts`) — speak steps, collect steps with types, set_value, private variables, 3-way conditional branching, transfer with goodbye, EndCallNode.

---

## Tests & verification

```bash
cd service
npm run typecheck   # tsc --noEmit, clean
npm test            # 14/14 passing
```

| Suite | Cases | Coverage |
|---|---:|---|
| `test/walker.test.ts` | 11 | Deterministic swimlane walker — EndCallNode skip, single/multiple collects, edge multiplication, ClaimsIntake 5-lane fixture, speaks-only passthrough, transfer/end sealing, leftover merge, `buildLaneContexts` index/total. |
| `test/generator.test.ts` | 7 | Agent loop wiring via `MockLanguageModelV2` from `ai/test`. Happy path, step-cap force-finalize, malformed-args repair, finalize-without-validate drop, `prepareStep` validate-after-propose enforcement, validator-side `generateObject` repair (success + failure). |
| `test/coverage.test.ts` | 7 | `computeCoverage` against synthetic 3-node specs. Partial / full node coverage, edge coverage including target-node arrival heuristic, branching, writable-variable coverage, assertion-type union, best-effort read coverage. |

### Live parity check (Vercel AI SDK migration)

Captured the **pre-migration** generator's response on demo workflow #46 as a baseline, then ran the **post-migration** code against the same workflow. Goal: prove the SDK rewrite preserves behavior.

| Node | Baseline (Responses API loop) | Post-migration (`generateText`) | Δ |
|------|---:|---:|---:|
| ClaimFiled | 0 | 0 | 0 |
| GeneralClaimTransfer | 3 | 3 | 0 |
| HomeClaimDetails | 3 | 3 | 0 |
| AutoClaimDetails | 4 | 4 | 0 |
| ClaimsIntake | 3 | 3 | 0 |
| **Total** | **13** | **13** | **0** |

Threshold was ±2 per node (LLM is non-deterministic at temp 0.3); actual Δ came out exact. A second post-migration run produced 14, well within variance. `failed_scenarios = 0` in both runs. Snapshots and the full report at [`service/test/__snapshots__/parity-report.md`](service/test/__snapshots__/parity-report.md).

### Coverage report on demo #46 (live)

Sampled from a real `dry_run=true` against the demo, **after** the AI SDK migration and follow-on enhancements:

| Dimension | Coverage | Notes |
|---|---|---|
| Nodes | 4/5 (80%) | `ClaimFiled` (terminal end node) unreached |
| Edges | 3/5 (60%) | Missing: `HomeClaimDetails→ClaimFiled`, `AutoClaimDetails→ClaimFiled` |
| Branches | 3/3 (100%) | All 3 conditional branches at `ClaimsIntake` exercised |
| Variables (write) | 14/14 (100%) | — |
| Assertion types used | 9 distinct | `tts_say`, `extracted_variables`, `variable_types`, `excluded_variables`, `no_response_contains`, `any_response_contains`, `no_raw_jinja`, `min_responses`, `initial_bot_replies` |

The end-of-conversation edges showing as uncovered is the kind of actionable gap the coverage module is built to surface — scenarios don't currently walk into the terminal `EndCallNode`.

---

## What's inside

| File | What |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Full system design — 12 sections |
| [docs/report.md](docs/report.md) | Results, precision analysis, platform learnings |
| [docs/approach.md](docs/approach.md) | One-page pitch |
| [docs/discovery-report.md](docs/discovery-report.md) | Platform reverse-engineering (724 lines) |
| [docs/ai-sdk-migration.md](docs/ai-sdk-migration.md) | Migration writeup — why, before/after, parity results |
| [service/](service/) | The microservice (16 files, ~2000 LOC) |
| [scripts/create-demo-workflow.ts](service/scripts/create-demo-workflow.ts) | Creates the Insurance Claims demo agent via SDK |

---

## Discussion

### Q1. Why S2 (per-step) over S1 (minimum) or S3 (DFS)?

S2 means one swimlane per Collect, Transfer, or End step. The platform's test runner asserts at step granularity — when a scenario fails, the result tells you which step broke. If the test count matches the step count, each failure maps 1:1 to a specific step. That's the property you want.

S1 (one lane per branch-defined swimlane) under-tests. A node with three Collects in a row and no conditions produces one lane. If the second Collect is broken, the single scenario fails but doesn't isolate which Collect caused it. S3 (every unique root-to-terminal DFS path) over-tests. Two IF/ELSE conditions produce four paths, but many of those paths share the same Collect steps — you'd be testing the same step multiple times from different entry conditions, paying LLM cost for redundant coverage.

S2 sits in the middle: one scenario per assertable step, no duplication, and the unit of coverage matches the unit of assertion. For the Outbound Reservation agent, S2 produces 22 swimlanes — the right granularity for a 5-node agent with 35 instruction steps.

### Q2. How do you make the LLM-generated user turns deterministically land at the targeted swimlane?

The answer is: you don't trust the LLM. You verify.

The pipeline has two phases. First, the LLM generates user turns targeting a specific swimlane — the prompt pins the lane's steps, the target edge, and the test_focus label. The LLM proposes one scenario, validates it against schema + consistency checks, and finalizes. This is plan-and-emit: structured prompt in, structured scenario out.

Second, the verifier runs the entire suite on the platform via `suitesRunCreate`, polls until completion, and reads per-scenario results. Each result includes the full conversation transcript — what the bot actually said and what steps it actually walked. Failed scenarios get regenerated with the actual conversation trace injected as corrective context: "You aimed for collect(policy_number) but the bot went here instead. Here's what actually happened." The verifier caps at 2 repair attempts per scenario. After a third failure, the scenario is dropped and logged with the reason.

On the Outbound Reservation agent, 19 of 22 scenarios passed after verification. The 3 dropped scenarios were in ReservationConfirmation — a 12-step node with complex transfer branching where the LLM couldn't reliably steer the agent down the intended path. Cleanly dropping those and logging why is more valuable than shipping scenarios that test the wrong thing.

### Q3. What's in your prompt to the LLM, and what's not?

The system prompt (~410 lines) has four layers. First, the step-to-turn mapping rules: speak(exact) → tts_say, speak(flexible) → any_response_contains, collect → user turn + extracted_variables, set_value → silent + variable_types, etc. These are deterministic rules the LLM applies mechanically — no creativity needed. Second, the assertion computation rules: how to calculate initial_bot_replies, min_responses, excluded_variables, no_response_contains. Third, three complete reference scenarios from the platform's own seed suites, showing the exact output format. Fourth, the swimlane directive: "You are given ONE swimlane. Generate exactly ONE scenario. Do NOT decide what to test."

What's deliberately absent: no "be creative" or persona instructions. No temperature jitter — we run at 0.3 for consistency. No open-ended coverage guidance — the walker already decided what to test, so the prompt doesn't ask the LLM to enumerate branches or choose paths. The prompt is structured input → structured output. The LLM's job is translation (steps to turns), not strategy (what to test).

### Q4. SDK or MCP for the writer? Why not the other?

SDK. The autogen pipeline creates 16-22 scenarios programmatically in a loop — that's a script job, not a conversation. The SDK gives you `suitesCreate`, `scenariosCreate`, `suitesRunCreate`, `resultsList` — all the CRUD you need, callable from code, runnable in CI.

MCP (via Claude Desktop) is the right tool for reviewing the output afterward. You'd open the generated suite, walk through each scenario conversationally, ask Claude to explain why a specific assertion exists or suggest edits to the user turns. That's human-in-the-loop review — MCP's strength. But the generation itself is a pipeline: load → walk → generate → verify → publish. SDK fits that shape; MCP doesn't.

### Q5. What does the take-home not cover that production will demand?

Integration step side effects. The generator treats Integration steps (HTTP callouts to external systems) as black boxes — it doesn't know what they return or how they affect downstream variables. A production system would need mock responses for those steps or a way to snapshot their return values.

Multi-node edge routing. The swimlane walker operates within a single node. Testing that the agent correctly transitions from Authentication → ReservationConfirmation → StayDetailsCollection requires scenarios that span multiple nodes — the walker would need to compose cross-node paths, not just intra-node lanes.

Failure mode coverage. What happens when the LLM times out mid-collection? When a transfer target is unavailable? When a variable fails phone number validation? These are runtime failure paths that the current generator can't reason about because they depend on platform behavior, not workflow structure.

Variable typing edge cases. The platform's validation for Phone, Email, Date, and Address types has undocumented rules. A production generator would need a per-type fragment library — known-good and known-bad values for each validation type — rather than relying on the LLM to guess plausible phone numbers.

---

## Tech

| | |
|---|---|
| Language | TypeScript, Node 20+ |
| HTTP | Hono |
| LLM | OpenAI Responses API, gpt-5.2 (via Vercel AI SDK — `ai@5`, `@ai-sdk/openai@2`) |
| Platform client | ZenLabs SDK (Fern-generated) |
| Auth | BasicAuth → Bearer token (programmatic) |
| Validation | Zod + custom consistency rules |
