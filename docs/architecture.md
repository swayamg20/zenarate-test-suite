# Architecture

> A guided walk-through. Read top to bottom — each section sets up the next.

---

## 1. The job

> Given any voice agent on the Zenarate platform, generate a complete test suite for it and publish it back into the platform.

**Input:** a workflow id (the agent).
**Output:** a populated test suite live in the dashboard, ready to run.

That's it. One thing in, one thing out.

---

## 2. Mapping the platform first

Two phases of discovery gave us a complete, verified understanding of the Zenarate API.

**Phase 1 — Playwright exploration.** Before writing any service code, I drove the Zenarate dashboard with Playwright and captured every API call it makes. The dashboard is a thin layer over a clean REST API, so this gave us a complete, verified endpoint map and sample responses.

**Phase 2 — Official SDK.** Zenarate provided their **ZenLabs SDK** (Fern-generated from the OpenAPI spec, TypeScript + Python). This gives us a typed client for every endpoint — workflows, nodes, edges, variables, test suites, scenarios, runs, results — plus programmatic auth via BasicAuth. The SDK replaces the hand-written API client we built from Playwright captures.

```
Phase 1:  [Playwright]  →  docs/samples/  (verified contracts, still useful as reference)
Phase 2:  [ZenLabs SDK]  →  typed client for all reads + writes (runtime dependency)
```

Three reasons this matters:

- **Verified contracts at the start.** Playwright captured exactly what the platform accepts. The SDK confirms and extends this.
- **Typed client from the source.** The SDK is auto-generated from Zenarate's own OpenAPI spec — no field name guessing, types stay in sync with the platform.
- **Programmatic auth.** The SDK supports BasicAuth login (username + password → token), eliminating manual token scraping from the browser.

---

## 3. The whole picture

```
        ┌─────────────────────────────────────────────────┐
        │                                                  │
        │   Microservice (this project)                    │
        │                                                  │
        │   ┌─────────────────────────────────────────┐   │
        │   │  Deterministic shell                    │   │
        │   │  - Reads agent from Zenarate            │   │
        │   │  - Validates output                     │   │
        │   │  - Writes test suite back to Zenarate   │   │
        │   └─────────────────────────────────────────┘   │
        │                     │                            │
        │                     ▼                            │
        │   ┌─────────────────────────────────────────┐   │
        │   │  LLM Agent (OpenAI Responses API)       │   │
        │   │  - Reasons about what to test           │   │
        │   │  - Produces scenarios per node          │   │
        │   │  - Has 5 tools, no HTTP access          │   │
        │   └─────────────────────────────────────────┘   │
        │                                                  │
        └──────┬─────────────────────────┬─────────────────┘
               │                         │
       reads/writes                  reasoning
               │                         │
               ▼                         ▼
       ┌────────────────┐       ┌────────────────┐
       │   Zenarate     │       │   OpenAI       │
       │   REST API     │       │   API          │
       └────────────────┘       └────────────────┘
```

Two external services, one microservice in the middle. The microservice has a clear inside/outside split: **deterministic code** does all the I/O; the **LLM agent** only reasons.

---

## 4. What happens when you call it

A single request flows through five steps, in order. Each step's output is the next step's input.

```
POST /agents/<wfId>/generate-suite
        │
        ▼
  ┌──────────────────────────────────┐
  │  1. LOAD                         │   read the agent
  │     fetch workflow + nodes +     │   from Zenarate
  │     edges + steps + variables    │
  └──────────────────────────────────┘
        │
        ▼
  ┌──────────────────────────────────┐
  │  2. NORMALIZE                    │   shape it into a
  │     raw API → AgentSpec          │   clean brief
  │     AgentSpec → NodeContext[]    │
  └──────────────────────────────────┘
        │
        ▼
  ┌──────────────────────────────────┐
  │  3. GENERATE   (per node)        │   the LLM does its
  │     LLM proposes scenarios       │   thinking here
  │     LLM self-validates           │
  │     LLM finalizes                │
  └──────────────────────────────────┘
        │
        ▼
  ┌──────────────────────────────────┐
  │  4. SCORE                        │   flag weak tests
  │     non-triviality check         │   (don't reject)
  └──────────────────────────────────┘
        │
        ▼
  ┌──────────────────────────────────┐
  │  5. PUBLISH                      │   create suite +
  │     POST /testsuite/suites/      │   scenarios in
  │     POST /testsuite/scenarios/×N │   Zenarate
  └──────────────────────────────────┘
        │
        ▼
RESPONSE: { suite_id, suite_url, scenarios, summary }
```

Every step except step 3 is plain code with no LLM in the loop. The LLM is contained.

---

## 5. Why an agent inside a microservice

A reasonable first instinct is to make this a pure microservice with templates: "for each node type, fill in this template." That doesn't work, for two reasons:

- **Every input agent is different.** Different domain, different node titles, different variables, different conditional logic. Templates would either over-fit or fall back to generic prose.
- **Testing requires understanding what the user would *say*.** When an edge is labeled "If authenticated → next node," what do you actually type as a customer to drive that branch? That's a natural-language reasoning problem, not a structural one.

So the **microservice is the shell**, and the **agent is the brain**. The shell handles everything an LLM is bad at — HTTP, schemas, parallelism, retries. The agent handles the one thing it's good at — open-ended reasoning about what to test.

The agent gets only five tools and no HTTP access. It cannot publish on its own. That keeps the LLM's failure modes contained.

---

## 6. The five modules

```
service/src/
├── zenarate/   ←  step 1, 5  (talks to Zenarate)
├── spec/       ←  step 2     (shapes the brief)
├── generator/  ←  step 3     (the LLM agent)
├── validator/  ←  steps 3, 4 (rules)
├── publisher/  ←  step 5     (writes back)
└── http/       ←  the front door
```

`**zenarate/**` — thin factory over the ZenLabs SDK. Handles programmatic auth (BasicAuth login → token) and client initialization. The SDK provides typed methods for all platform reads and writes. One file: `factory.ts`.

`**spec/**` — turns the raw API responses (which are noisy and polymorphic) into a clean shape called `AgentSpec`. Then splits the AgentSpec into one `NodeContext` per node. Each `NodeContext` has just enough information for the agent to reason about that one node — its prompt, its outgoing edges, its variables. Nothing more.

`**generator/**` — the LLM loop. Runs once per node, in parallel (max 3 concurrent). Uses the OpenAI Responses API with tool use. The LLM sees a `NodeContext` and produces 3-6 scenarios for that node.

`**validator/**` — three layers of rules:

1. *Schema* — does this scenario match the API contract?
2. *Self-consistency* — e.g., does `min_responses: 4` work given only 2 turns?
3. *Non-triviality* — does this test actually check anything? (Flag, don't reject.)

`**publisher/`** — creates the suite and scenarios via the SDK. May use `suitesBulkSeedCreate()` for a single-call publish, or fall back to sequential `scenariosCreate()` with SDK's built-in retries. Returns a partial-success report if some fail.

`**http/*`* — Hono server, one endpoint, one job.

---

## 7. The data shapes between modules

The boundaries between modules are typed. Here are the three shapes that matter:

`**AgentSpec**` — the flat brief, derived from the raw API:

```ts
{
  id: number,
  title: string,
  bot_name: string | null,
  system_prompt: string,
  nodes: Node[],     // each with prompt, instruction_steps, node_variables
  edges: Edge[],     // with conditional_description, is_else
}
```

`**NodeContext**` — what one generator call sees. Tight on purpose:

```ts
{
  agent: { bot_name, system_prompt_excerpt, total_nodes },
  node:  Node,                     // this node, full
  outgoing: {
    to_node_title: string,
    conditional_description: string,
    is_else: boolean,
  }[],
}
```

We don't pass the whole graph to the agent. The agent reasons about one node at a time.

`**Scenario**` — what the agent produces (matches the verified Zenarate API):

```ts
{
  name: string,
  description: string,
  description_long: string,
  node_codes: [{ node_title: string, order?: number }],
  turns: [{ text: string, expected_replies?: number }],
  assertions: {
    min_responses?: number,
    initial_bot_replies?: number,
    greeting_contains?: string,
    extracted_variables?: { [name: string]: string | number | boolean },
    tts_say?: string[],                // exact bot utterances, in order
    variable_types?: { [name: string]: 'bool' | 'int' | 'float' | 'str' },
    excluded_variables?: string[],     // variables that must NOT be set
    no_response_contains?: string[],   // substrings the bot must never say
    any_response_contains?: string[],  // at least one of these must appear
    no_raw_jinja?: boolean,            // true → no {{ }} leaks in output
  },
  initial_state?: object,
}
```

---

## 8. The agent loop, zoomed in

Inside step 3, for each node, this happens:

```
                              ┌─────────────┐
                              │ NodeContext │
                              └──────┬──────┘
                                     │
                                     ▼
                ┌──────────────────────────────────┐
                │  System prompt (fixed)           │
                │  + 4-5 seed scenarios as         │
                │    exemplars (few-shot)          │
                └──────────────┬───────────────────┘
                               │
                               ▼
                  ┌────────────────────────┐
                  │   OpenAI Responses     │
                  │   API (gpt-5.2,   │
                  │   temperature 0.3)     │
                  └─────────┬──────────────┘
                            │
                            │  loop, ~5-10 turns
                            ▼
            ┌─────────────────────────────────┐
            │  LLM picks one of 5 tools:      │
            │                                  │
            │   propose_scenario(json)         │
            │   validate_scenario(idx)         │
            │   remove_scenario(idx)           │
            │   list_proposed()                │
            │   finalize()                     │
            │                                  │
            └─────────┬───────────────────────┘
                      │
                      ▼
              ┌───────────────────┐
              │  3-6 scenarios    │
              │  for this node    │
              └───────────────────┘
```

The LLM is required to call `validate_scenario` after every `propose_scenario`. If validation fails, the error is fed back into the conversation and the LLM revises. The loop ends when the LLM calls `finalize()` or hits a 10-turn cap.

**Coverage per node** (deterministic, not LLM judgment):

```
1 happy path
+ 1 per outgoing branch
+ 1 for is_else fallback (if exists)
+ 1 for end-state correctness (if EndCallNode)
≈ 3-6 scenarios per node
```

This is how we get **recall** without trusting the LLM. The LLM is responsible for **precision** within each scenario; the deterministic loop is responsible for not skipping nodes.

### Step-to-turn mapping

The system prompt teaches the LLM a precise methodology for converting workflow instruction steps into conversation turns and assertions. Each step type has deterministic mapping rules:

- `speak(mode=exact)` → bot turn + add to `tts_say`
- `speak(mode=flexible)` → bot turn + extract key phrases to `any_response_contains`
- `collect` → bot turn (the question) + one user turn (the answer) + optionally a second user turn if `confirmation_mode=explicit`
- `set_value` → silent, no turns — but populates `extracted_variables` and `variable_types`
- `condition` → silent, determines which outgoing edge is taken
- `end_conversation` → bot turn + goodbye assertion

The LLM walks the `instruction_steps` array in order, counting bot turns and user turns separately, then derives `initial_bot_replies`, `min_responses`, `tts_say`, `extracted_variables`, and all other assertion keys from the trace. The methodology lives entirely in the prompt — not in templates or post-processing.

### The assertion vocabulary (10 keys)

| Key | What it checks |
|---|---|
| `min_responses` | Total bot turns across the asserted path |
| `initial_bot_replies` | Bot turns before the first user turn |
| `greeting_contains` | Substring in the first bot utterance |
| `tts_say` | Exact bot utterances in order (speak mode=exact) |
| `extracted_variables` | Variable name → expected value map |
| `variable_types` | Variable name → coerced type (bool/int/float/str) |
| `excluded_variables` | Variables that must NOT be set (private vars, untaken branches) |
| `no_response_contains` | Substrings the bot must never say (private data leaks) |
| `any_response_contains` | At least one of these substrings must appear somewhere |
| `no_raw_jinja` | No raw `{{ }}` template syntax leaks into bot output |

### The five tools

The LLM gets exactly five tool calls. No HTTP, no Zenarate API, no filesystem. Anything outside this list, the LLM cannot do.

`**propose_scenario(scenario)`**

Stages a candidate scenario in an in-memory working set for this node. Returns the index it was stored at.

```ts
input:  Scenario  // full scenario object as defined in §7
output: { index: number }
```

The LLM is expected to call this once per scenario it wants to add, not in a batch.

`**validate_scenario(index)**`

Runs the same deterministic checks the validator module uses, on the staged scenario at `index`. Returns either `ok: true` or a list of errors the LLM should fix.

```ts
input:  { index: number }
output: { ok: true } | { ok: false, errors: string[] }
```

Errors are concrete and actionable: "node_title 'VerifyUser' does not exist on this agent — valid options: Authentication, ReservationConfirmation, ..." or "min_responses: 4 cannot be satisfied with only 2 turns." The LLM uses these to revise via another `propose_scenario`.

`**remove_scenario(index)**`

Removes a staged scenario by index. Used when a scenario repeatedly fails validation and cannot be fixed — this unblocks `finalize` without leaving unvalidated scenarios in the working set.

```ts
input:  { index: number }
output: { removed: true }
```

`**list_proposed()**`

Returns the LLM's current working set, with each scenario's name, target nodes, and validation status. Useful when the LLM has produced a few scenarios and wants to check coverage before continuing.

```ts
input:  {}
output: { scenarios: { index, name, node_codes, validated }[] }
```

`**finalize()**`

Ends the loop for this node. Only validated scenarios are returned. If any are unvalidated when `finalize` is called, the loop returns an error and asks the LLM to validate them first.

```ts
input:  {}
output: { scenarios: Scenario[] }
```

### Why these five (and not more)

- **No `get_agent_spec` tool.** The relevant `NodeContext` is included in the system prompt for that call. Tools are for actions the LLM performs, not for re-fetching context.
- **No `list_seed_scenarios` tool.** The 4-5 exemplars live in the system prompt as few-shot. Making it a tool tempts the LLM to spend turns browsing instead of generating.
- **No `publish` tool.** Publish is the deterministic shell's job, after the agent finishes. The LLM cannot write to Zenarate by design.
- **No `revise(index, scenario)` tool.** Revising is just `propose_scenario` again with the same name. Adding a separate tool doubles the surface area for marginal value. `remove_scenario` exists only as an escape hatch for unfixable validation failures.

The tool set is small on purpose. Every additional tool is another thing the LLM can do wrong.

---

## 9. The response body

```json
{
  "suite_id": 38,
  "suite_url": "https://zenarate-prod.vercel.app/tests/38",
  "scenarios": [
    {
      "id": 247,
      "name": "auth_happy_path_confirmed",
      "node_codes": [{"node_title": "Authentication"}],
      "trivial": false
    }
  ],
  "per_node_summary": [
    { "node": "Authentication", "generated": 4, "trivial_count": 0 },
    { "node": "ReservationConfirmation", "generated": 5, "trivial_count": 1 }
  ],
  "failed_scenarios": [],
  "elapsed_ms": 12500
}
```

`failed_scenarios` carries any scenarios that exhausted retries during publish, so the caller knows what's missing. The suite is left in place even if some scenarios failed — partial output is more useful than a rollback.

---

## 10. Trade-offs I'm explicitly making

- **One agent, no orchestration.** Single LLM loop, no critic, no multi-agent handoff. If quality isn't enough, add a critic — but not now.
- **Per-node generation, no full-flow scenarios.** Tests are scoped to a single node. Conversation-spanning tests are a known gap; the platform's own seeds skip them too.
- **For now Stateless service.** No database, no history. Each request is independent.
- **Quality is proportional to workflow complexity.** Simple workflows (one speak, one collect) produce simple tests. The system shines on complex workflows with multiple step types, conditional branches, private variables, and type coercion — because the step-to-turn mapping methodology in the prompt has more to reason about. The methodology comes from the prompt, not from templates or code-level heuristics.
- **Hybrid publishing.** Entrypoint nodes use `node_codes` (tests the live agent). Downstream nodes use `workflow_config` (self-contained mini workflow where the target node is the entrypoint). This is because the platform always starts conversations from the workflow's entrypoint — there's no way to jump to a downstream node with `node_codes`.
- **Platform assertion limitations.** `greeting_contains` is unreliable (0% pass rate even on the platform's own reference seed scenarios). Disabled in generation. Best pass rate achieved: 77% (10/13) on the custom Insurance Claims workflow.

---

## 11. Logging

Every meaningful event emits a structured JSON log line to stdout. Enough to trace a single request without a logging service:

```jsonc
{ "ts": "...", "req_id": "...", "step": "load",      "wf_id": 31, "ms": 2400 }
{ "ts": "...", "req_id": "...", "step": "normalize", "nodes": 5, "edges": 3 }
{ "ts": "...", "req_id": "...", "step": "generate",  "node": "Authentication",
  "tool": "propose_scenario", "iteration": 1 }
{ "ts": "...", "req_id": "...", "step": "generate",  "node": "Authentication",
  "tokens_in": 4200, "tokens_out": 1100, "ms": 5300, "scenarios": 4 }
{ "ts": "...", "req_id": "...", "step": "publish",   "scenario": "auth_happy_path",
  "attempt": 1, "status": 201 }
{ "ts": "...", "req_id": "...", "step": "done",      "suite_id": 38,
  "total_ms": 12500, "trivial_count": 1, "failed": 0 }
```

Costs almost nothing to add and makes the demo self-explanatory — if anything looks wrong, the logs show exactly where.

---

## 12. iPaaS support — the same shell, new content

The platform has a parallel system for iPaaS workflow tests (data orchestration, not voice conversations). The same agent loop and tool design carry over; the prompts and validators are new content.


| Layer                       | Reuse   | Changes for iPaaS                                                                              |
| --------------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `zenarate/`                 | Reuse   | Add `/ipaas/scenarios/` endpoints                                                              |
| `spec/`                     | Rewrite | Input is `definition_yaml`, not a graph — needs a YAML parser → `IpaasSpec`                    |
| `generator/` loop + tools   | Reuse   | Same loop shape, same 4 tools                                                                  |
| Generator prompt + few-shot | Rewrite | Different reasoning ("what data shape would each node need?" not "what would a customer say?") |
| `validator/`                | Rewrite | Different fields (`mock_nodes`, `mock_trigger_input` instead of `turns`/`assertions`)          |
| `publisher/`                | Reuse   | Different endpoint, same shape                                                                 |


The architecture's reach extends naturally; the content does not.