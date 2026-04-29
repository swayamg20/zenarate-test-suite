# Approach — Auto-generated test suites for Zenarate voice agents

> One-pager. What I built, how, and why.

## The problem

Given any Zenarate voice agent (a workflow with nodes, edges, instruction steps, and per-node variables), produce a complete test suite that exercises the agent's behavior — covering the happy path, each conditional branch, edge cases, and end-state correctness — and publish it into the platform automatically.

**Input:** a workflow id.
**Output:** a populated test suite live in the dashboard, ready to run.

## How I got here

1. **Reverse-engineered the platform** — drove the dashboard with Playwright, captured every API call, built a verified endpoint map and sample responses (`docs/discovery-report.md`).
2. **Got the ZenLabs SDK** — replaced the hand-written API client with the official Fern-generated TypeScript SDK. Programmatic auth via BasicAuth, typed client for all operations, ~400 lines of hand-written code eliminated.
3. **Studied the quality bar** — analyzed all 33 seed scenarios across 5 reference suites. Extracted the full 10-key assertion vocabulary and the step-to-turn mapping methodology that makes reference scenarios precise.
4. **Encoded the methodology into a system prompt** — the LLM doesn't freestyle. It follows deterministic rules: speak(exact) -> tts_say, collect -> user turn, set_value -> extracted_variables. The prompt teaches it to think like a QA engineer.

## Architecture — deterministic shell, agentic core

The LLM only generates content. Every HTTP call, schema check, and platform write is plain code.

```
service/ (Node + TypeScript + Hono)
├── zenarate/      ZenLabs SDK factory (BasicAuth login, client init)
├── spec/          Workflow -> AgentSpec normalizer (SDK shapes -> clean types)
├── generator/     LLM agent loop (OpenAI Responses API, 5 tools, per-node)
├── validator/     Schema (Zod) + consistency checks (10 assertion types)
├── publisher/     SDK: create suite + scenarios
└── http/          One endpoint: POST /agents/:wfId/generate-suite
```

The LLM agent gets 5 tools (propose, validate, remove, list, finalize) and no HTTP access. It cannot publish, fetch data, or call external services. The deterministic shell is responsible for all I/O.

Full design: [`docs/architecture.md`](architecture.md)

## Results

Tested on **3 workflows** of increasing complexity:

| Workflow | Nodes | Scenarios | Platform Pass Rate |
|---|---|---|---|
| #37 — Test_Swayam (simple booking) | 3 | 9 | N/A (baseline) |
| #31 — Outbound Reservation (real agent) | 5 | 14 | 0% our fault, 100% legit failures |
| #46 — Insurance Claims Intake (custom) | 5 | 13 | **77% (10/13 passed)** |

**Key metrics (Insurance Claims, Suite 80):**
- 9/10 assertion types used (`greeting_contains` disabled — unreliable on platform, 0% pass rate even on reference scenarios)
- Multi-turn: up to 5 turns per scenario
- Private variable leak testing: scenarios seed a private value and assert it never appears in bot speech
- Branch coverage: all 3 conditional paths (auto, home, general) tested
- `workflow_config` scenarios: **100% pass rate** (10/10)
- `node_codes` scenarios: 0/3 (platform turn-timing issue with multi-collect entrypoint)

**Live feedback loop demonstrated:** Generated tests → ran against live agent → identified boolean re-confirmation issue → improved agent (updated system prompt + collect questions via SDK) → re-ran tests → verified improvement.

## Why precision over recall

For test suite generation, **precision is the primary metric**. Every generated scenario must be valid, runnable, and test something real. A false positive (junk scenario) destroys trust faster than a missing edge case. The system deliberately generates 3-6 tight scenarios per node rather than exhaustively enumerating every permutation.

## Trade-offs

- **Quality scales with workflow complexity.** Simple agents produce thin scenarios. The system mirrors the depth it's given.
- **Per-node, not conversation-level.** Tests are scoped to individual nodes. Multi-node end-to-end flows are a v2 feature.
- **Hybrid publishing.** Entrypoint nodes use `node_codes` (tests live agent). Downstream nodes use `workflow_config` (self-contained). This is because the platform always starts from the entrypoint.
- **Platform limitations.** `greeting_contains` assertion is unreliable (0% pass rate on reference scenarios). Reference seed suites themselves don't all pass (suite 34: 7/8, suite 31: 3/11).

## Demo

```bash
cd service
npm run dev
# Point at any workflow:
curl -X POST http://localhost:3000/agents/46/generate-suite \
  -H "Content-Type: application/json" -d '{}'
# Returns: { suite_id, suite_url, per_node_summary, elapsed_ms }
# Open suite_url in the dashboard, hit Run All.
```

End-to-end ~60 seconds from workflow id to published test suite.

## Artifacts

| File | Purpose |
|---|---|
| `docs/architecture.md` | Full system design (12 sections) |
| `docs/report.md` | Assignment report with results and precision analysis |
| `docs/discovery-report.md` | Platform reverse-engineering (724 lines) |
| `docs/samples/` | Verified API responses |
| `archive/playwright-discovery/` | Playwright data preserved for reference |
| `service/` | The microservice (15 files, ~1,700 LOC) |
| `service/scripts/create-demo-workflow.ts` | Script that creates the Insurance Claims workflow via SDK |
