# voice-eval

Automatic test suite generation for voice agents. Point it at any agent, get a complete test suite back — scenarios, assertions, conversation flows, all published and ready to run.

Built for the [Zenarate](https://zenarate-prod.vercel.app) voice agent platform. Uses the ZenLabs SDK for all platform operations and an LLM agent (OpenAI Responses API) to reason about what to test.

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
├── spec/         Workflow → AgentSpec → NodeContext[] (one per node)
├── generator/    LLM agent loop — 5 tools, per-node, parallel
├── validator/    Zod schema + consistency checks (9 assertion types)
├── publisher/    Hybrid: node_codes (entrypoint) + workflow_config (downstream)
└── http/         Hono server, one endpoint
```

The LLM reasons about what to test. Everything else — HTTP, validation, publishing, turn timing — is deterministic code.

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

## What's inside

| File | What |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Full system design — 12 sections |
| [docs/report.md](docs/report.md) | Results, precision analysis, platform learnings |
| [docs/approach.md](docs/approach.md) | One-page pitch |
| [docs/discovery-report.md](docs/discovery-report.md) | Platform reverse-engineering (724 lines) |
| [service/](service/) | The microservice (16 files, ~2000 LOC) |
| [scripts/create-demo-workflow.ts](service/scripts/create-demo-workflow.ts) | Creates the Insurance Claims demo agent via SDK |

---

## Tech

| | |
|---|---|
| Language | TypeScript, Node 20+ |
| HTTP | Hono |
| LLM | OpenAI Responses API, gpt-5.2 |
| Platform client | ZenLabs SDK (Fern-generated) |
| Auth | BasicAuth → Bearer token (programmatic) |
| Validation | Zod + custom consistency rules |
