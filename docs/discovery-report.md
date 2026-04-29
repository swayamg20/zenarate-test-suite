# Zenarate Discovery Report

**Date:** 2026-04-28
**Scope:** Reverse-engineering the Zenarate platform's product model, API surface, and test framework, ahead of designing a test-suite generation microservice.
**Method:** Headless browser walkthrough of `https://zenarate-prod.vercel.app` + direct API probing.
**Account:** `dev@zenlabs.com` (tenant: `Hiring`, id 6).

> **Security note:** Login credentials were shared in plaintext during this exercise. Rotate `dev@zenlabs.com` password before sharing this report further.

---

## 1. TL;DR

- Zenarate is a **voice agent platform** (think 11labs / Vocode / Retell). Agents are **directed graphs of nodes**, not single prompts.
- The frontend is a Next.js app on Vercel; the real backend is a **Django REST Framework** API on Fly.io: `https://zenarate-web-prod.fly.dev/api/v1/`.
- Auth is **DRF token + multi-tenant header** (`Authorization: Token <64-char>`, `X-Tenant-Id: <numeric>`) — no cookies, no JWT.
- Tests are **first-class API resources**: `TestSuite → Scenarios`, with full CRUD. Runs are async and orchestrated via **Temporal**.
- The UI authors scenarios using **YAML** for `turns` and `assertions` (small DSL). Internally these are stored as JSON.
- Generate's team has shipped **17 seed test suites / 122 scenarios** that exercise platform capabilities (steps, edges, variables, routing, escalation, formatting). These are gold for understanding what "good" tests look like.
- **Building the test-generation service is API-feasible end-to-end.** No browser automation needed at runtime. Publish, run, and read results all over the public API.

---

## 2. Auth & Origin Map

| Item | Value |
|---|---|
| Frontend origin | `https://zenarate-prod.vercel.app` (Next.js on Vercel) |
| Backend origin | `https://zenarate-web-prod.fly.dev` (Fly.io) |
| API base | `/api/v1/` |
| Login endpoint | `POST /api/v1/auth/token-auth/login/` |
| Token storage | `localStorage.auth_token` (64-char DRF token) |
| User storage | `localStorage.user` (JSON) |
| Tenant storage | `localStorage.tenants` (JSON array) |
| Cookies | None (header-only auth) |

**Required headers for any authenticated request:**

```
Authorization: Token <auth_token>
X-Tenant-Id: <tenant.id>     ← numeric, NOT slug. Slug returns "Invalid tenant"
```

The frontend is **not** a BFF — it calls the Fly backend directly from the browser. That makes our service trivial: no scraping of Next.js internals, just hit `zenarate-web-prod.fly.dev`.

---

## 3. Product Model — Agents are Workflows

In the API, "agents" are called **workflows**. The terminology in the dashboard is "Agent" but every endpoint is `/workflow/...`.

### 3.1 Workflow (agent) object

`GET /api/v1/workflow/workflows/`

Top-level fields (sample workflow #31, "Outbound Reservation Confirmation"):

| Field | Notes |
|---|---|
| `id`, `title`, `description` | Identity |
| `bot_name`, `company_name`, `company_description` | Persona/branding |
| `llm_config` | `{llm_provider, llm_model_name, system_prompt, temperature, top_p, top_k, max_tokens, extra_args}` |
| `business_hours_config` | Days/timezone/holidays/out-of-hours message |
| `escalation_config` | Counter, pushback prompts, transfer number, transcription |
| `fatal_error_escalation_config` | Fallback transfer + error message |
| `global_listener` | Always-on phrases (e.g. "speak to a human") |
| `voicemail_action`, `voicemail_message`, `enable_voicemail_detection` | Voicemail handling |
| `enable_dtmf_support`, `allow_interruptions` | Voice channel knobs |

Variable interpolation uses `{{uuid:Variable:<uuid>}}` syntax in messages.

### 3.2 Nodes — `GET /api/v1/workflow/workflows/<id>/nodes/`

Polymorphic via `resourcetype` (Django REST polymorphic). Observed types:

- `LLMNode` — an LLM-driven step (most common)
- `EndCallNode` — terminal node, has `goodbye_message` + `goodbye_message_mode` (`exact` | `paraphrase`)

Likely additional types (inferred from seed suite names — `steps-collection`, `steps-confirmation`, `steps-transfer`, `steps-spellout`, `steps-speak`, `steps-branching`): `CollectionNode`, `TransferNode`, etc. To enumerate definitively we'd need to inspect a richer agent or read backend source.

Common node fields:

| Field | Purpose |
|---|---|
| `title`, `description` | Authoring metadata |
| `is_entrypoint`, `is_end` | Graph role |
| `outcome_type` | e.g. `prompt_based` |
| `pre_actions`, `post_actions` | Hooks |
| `respond_immediately` | Whether bot speaks before listening |
| `canvas_layout` | UI position (`{x, y}`) |
| `goodbye_message`, `goodbye_message_mode` | EndCallNode only |
| `is_resolution_driving` | Whether this node closes the task |

### 3.3 Edges — `GET /api/v1/workflow/workflows/<id>/edges/`

| Field | Purpose |
|---|---|
| `from_node`, `to_node`, `to_node_title` | Connectivity |
| `meta.conditional_description` | Free-text rule for the LLM (e.g. `"Confirmed → collect stay details"`) |
| `condition_groups` | Programmatic conditions (empty in samples — likely typed rule trees) |
| `is_else` | Default/fallback branch |
| `order` | Edge evaluation order |

### 3.4 Sample agent shape (workflow #31)

```
Authentication (LLMNode, entrypoint)
  ├── on "authenticated" → ReservationConfirmation (LLMNode)
  │                          └── on "Confirmed" → StayDetailsCollection (LLMNode)
  └── else → FallbackEndCall (EndCallNode)

DNCNode (EndCallNode, orphan in this sample — likely reachable in production via global_listener)
```

---

## 4. Test Model

The most important section. The platform has a complete, opinionated test framework already.

### 4.1 Hierarchy

```
TestSuite                 ← named bundle, ties to a workflow OR is platform-level
  └── Scenario[]          ← individual test case (the "YAML file")
        ├── turns         ← list of user inputs
        ├── assertions    ← post-run checks
        ├── personality   ← simulated user persona (optional)
        ├── initial_state ← starting variables (optional)
        ├── workflow_config ← inline mini-workflow (for platform tests) OR
        └── node_codes    ← references to a real workflow's nodes
TestSuiteRun              ← async execution, Temporal-backed
  └── Result[]            ← per-scenario outcome + full transcript
```

### 4.2 TestSuite — `/api/v1/testsuite/suites/`

| Field | Notes |
|---|---|
| `id`, `title`, `description`, `description_long` | Identity. `description_long` is markdown — supports tables and code |
| `workflow`, `workflow_name` | Optional FK to a real agent. Empty = platform-level suite |
| `channel` | `text` (more likely later: `voice`) |
| `mode` | `simulation` (chat-bot replay) — likely future modes for voice |
| `scenario_count` | Aggregate |
| `is_active`, `is_deleted` | Soft delete + active flag |
| `polymorphic_ctype` | DRF polymorphic — different suite subtypes likely exist |

### 4.3 Scenario — `/api/v1/testsuite/scenarios/?suite=<id>`

This is the unit a test-generator will produce.

```jsonc
{
  "id": 244,
  "suite": 34,
  "name": "specific_nodes_scope",
  "description": "var {name} scope=specific_nodes ids=[{n1},{n2}]...",
  "description_long": "# specific_nodes_scope ... (markdown with ASCII diagrams)",
  "node_codes": [],                    // empty = platform test (uses workflow_config). For agent tests, references nodes.
  "has_workflow_config": true,
  "workflow_config": {                 // INLINE workflow for the scenario to run against
    "nodes": [...],                    // same shape as /workflow/<id>/nodes/
    "edges": [...]
  },
  "personality": null,                 // simulated user persona (string or object)
  "initial_state": null,               // pre-set variables
  "turns": [                           // YAML-authored list
    { "text": "My name is Alice", "expected_replies": 2 },
    { "text": "Continue", "expected_replies": 2 },
    { "text": "Continue" }
  ],
  "assertions": {                      // YAML-authored dict
    "min_responses": 4,
    "extracted_variables": { "customer_name": "Alice" },
    "initial_bot_replies": 1
  }
}
```

**Two flavors of scenario, distinguished by `node_codes` vs `workflow_config`:**

1. **Platform/seed tests** — bring their own `workflow_config` (a tiny synthetic agent), assert the runtime handles the feature correctly. This is what all 17 current seeds are.
2. **Agent-bound tests** — `suite.workflow` points at a real agent, `scenario.node_codes` lists the nodes under test, no `workflow_config` (real agent is used).

### 4.4 The YAML DSL (from the UI authoring form)

The dashboard form has two YAML fields. These map directly to JSON internally — the YAML is purely an authoring convenience.

**`turns` placeholder:**

```yaml
- "My name is Alice"
- "I need to book a room"
```

Or richer per-turn objects with `expected_replies`:

```yaml
- text: "My name is Alice"
  expected_replies: 2
- text: "Continue"
```

**`assertions` placeholder:**

```yaml
min_responses: 2
greeting_contains: Welcome to Zenafide
extracted_variables.customer_name: Alice
no_raw_jinja: true
```

**Assertion vocabulary observed:**

| Key | Meaning |
|---|---|
| `min_responses` | Minimum bot reply count |
| `initial_bot_replies` | Expected number of opening bot turns |
| `greeting_contains` | Substring match on the first bot turn |
| `extracted_variables.<name>: <value>` | Dotted-key match on extracted variable |
| `extracted_variables` (block form) | `{var_name: expected_value}` |
| `no_raw_jinja` | Bot output must not contain unrendered `{{...}}` |

(Vocabulary is almost certainly larger; these are the ones we observed in placeholders + samples.)

### 4.5 Seed test suites — the goldmine

Generate's team ships **17 seed suites / 122 scenarios** that exercise the platform itself. Available via `POST /api/v1/testsuite/suites/seed-summary/` (read) and a UI flow to materialize them into your tenant.

| Slug | Title | Scenarios |
|---|---|---:|
| `advanced-escalation` | Agent Escalation | 6 |
| `edges-routing` | Edges — Rule-Based Routing | 3 |
| `output-formatting` | Output Formatting | 7 |
| `routing` | Workflow Routing | 7 |
| `speech-formatting` | Speech Formatting | 9 |
| `steps-branching` | Steps — Condition Branching | 3 |
| `steps-collection-callerintent` | Caller Intent & Options | 11 |
| `steps-collection-core` | Collection Core | 9 |
| `steps-collection-dynamicoptions` | Dynamic Options | 2 |
| `steps-collection-str` | Collection String | 11 |
| `steps-collection-typevalidation` | Type Validation | 16 |
| `steps-confirmation` | Confirmation Step | 5 |
| `steps-endcall` | End Call | 4 |
| `steps-speak` | Speak Step | 11 |
| `steps-spellout` | Spell Out | 8 |
| `steps-transfer` | Transfer | 2 |
| `variables-scoping` | Variables — Scoping & Access Modes | 8 |

These seeds are the **single best dataset for few-shot prompting** a generator. Each scenario's `description_long` is a hand-written ASCII schematic of the asserted path. Mining these:

- Tells us exactly what assertion types are valid.
- Anchors the generator on Zenarate's own authoring style.
- Provides ready-made coverage buckets (collection / branching / escalation / variables / routing / formatting).

---

## 5. Run & Eval

### 5.1 Trigger a run

```
POST /api/v1/testsuite/suites/<suite_id>/run/
→ 202 Accepted (~800ms)
```

Returns the new run object. Backend orchestrates via **Temporal Cloud** — each run is a Temporal workflow with a child workflow per scenario. Temporal links are returned in the response (`temporal_link`, `temporal_workflow_id`).

### 5.2 List runs

```
GET /api/v1/testsuite/runs/?suite=<suite_id>
```

Run object:

```jsonc
{
  "id": 3,
  "suite": 34,
  "status": "completed",          // queued | running | completed | failed
  "started_at": "...",
  "completed_at": "...",
  "total_scenarios": 8,
  "passed_scenarios": 7,
  "failed_scenarios": 1,
  "temporal_workflow_id": "test-suite-run-3",
  "temporal_link": "https://cloud.temporal.io/..."
}
```

### 5.3 Per-scenario results

```
GET /api/v1/testsuite/results/?run=<run_id>
```

Result object:

```jsonc
{
  "id": 17,
  "run": 3,
  "scenario": 237,
  "scenario_name": "global_scope_persists",
  "status": "passed",             // passed | failed
  "duration_seconds": 6,
  "metric_results": [],           // extensible — currently empty for these tests
  "conversation": [               // FULL transcript
    { "id": 74, "text": "My name is Alice", "text_src": "User", "created_at": "..." },
    { "id": 75, "text": "Hello! What is your name?", "text_src": "Assistant", ... },
    ...
  ]
}
```

The conversation array is invaluable: a generator can **read failed-test transcripts to learn how the bot actually behaved** and propose better tests next iteration.

---

## 6. Other endpoints worth knowing

Captured in passing — useful for future work:

| Endpoint | Purpose |
|---|---|
| `GET /workflow/workflows/retired-count/` | Versioning/lifecycle |
| `GET /testsuite/suites/retired-count/` | Same for tests |
| `GET /testsuite/suites/seed-summary/` | List bundled seed suites |
| `POST /testsuite/suites/seed/` (inferred) | Materialize seeds into tenant |
| `GET /voice/dashboard-sessions/` | Live preview (voice playground) sessions |
| Side-nav reveals also: `/knowledge-base`, `/tools`, `/integrations`, `/connections`, `/conversations`, `/analytics`, `/phone-numbers`, `/outbound` | Out of scope for this pass |

---

## 7. Recommendation for the test-generation microservice

**The platform is API-complete for our needs.** No browser automation required at runtime. The architecture we discussed earlier holds, with these refinements:

### 7.1 Architecture (finalized post-discovery)

```
┌────────────────────────────────────────────────────────────────┐
│  Microservice (Node/TS)                                        │
│                                                                 │
│  Layer 1 — Zenarate API client (deterministic)                 │
│    auth.login()                                                 │
│    workflows.list / get / nodes / edges                         │
│    testsuite.listSuites / createSuite / listScenarios           │
│    testsuite.createScenario / runSuite                          │
│    testsuite.listRuns / getRun / listResults                    │
│                                                                 │
│  Layer 2 — Tool wrappers exposed to the LLM agent              │
│    get_agent_spec(workflow_id)                                  │
│    list_seed_scenarios(slug)                                    │
│    propose_scenario(json)                                       │
│    validate_scenario(json) → schema + dry-run rules             │
│    list_proposed_scenarios()                                    │
│    finalize_suite()                                             │
│                                                                 │
│  Layer 3 — Generator agent (OpenAI Responses API)              │
│    Single agent loop: read agent → seed few-shot → propose     │
│    → self-validate → revise → finalize. No publish in tools.   │
│                                                                 │
│  Layer 4 — HTTP API                                            │
│    POST /agents/:id/discover    → returns AgentSpec             │
│    POST /agents/:id/generate    → returns staged scenarios      │
│    POST /scenarios/validate     → schema + lint                 │
│    POST /suites/:id/publish     → human-gated, calls Zenarate   │
└────────────────────────────────────────────────────────────────┘
```

### 7.2 Internal AgentSpec (input to the generator)

Built by reading `/workflow/workflows/<id>/`, `/nodes/`, `/edges/`. Roughly:

```ts
type AgentSpec = {
  id: number;
  title: string;
  description: string;
  bot_name: string;
  company: { name: string; description: string };
  llm: { provider: string; model: string; system_prompt: string };
  policies: {
    business_hours: BusinessHoursConfig;
    escalation: EscalationConfig;
    voicemail: VoicemailConfig;
    interruptions: boolean;
  };
  graph: {
    entry_node_id: number;
    nodes: Array<{ id: number; type: NodeType; title: string; description: string; ... }>;
    edges: Array<{ from: number; to: number; rule: string; isElse: boolean }>;
  };
};
```

### 7.3 What the generator emits (output)

A `TestSuite` plus `Scenario[]` payloads matching Zenarate's schema. For agent-bound tests:

```jsonc
{
  "suite": {
    "title": "auth-routing",
    "description": "Coverage for the Authentication entry node",
    "workflow": 31,
    "channel": "text",
    "mode": "simulation"
  },
  "scenarios": [
    {
      "name": "auth_happy_path",
      "node_codes": ["Authentication"],
      "turns": [
        { "text": "Yes, this is John Doe.", "expected_replies": 1 }
      ],
      "assertions": {
        "min_responses": 2,
        "extracted_variables": { "customer_verified": true }
      }
    },
    // ... refusal, ambiguity, repeat-asks, escalation, etc.
  ]
}
```

### 7.4 Coverage buckets (informed by seed suite categories)

The generator should target buckets the seeds taught us are real:

- happy path
- collection / type validation (string, options, dynamic options)
- caller intent
- branching / conditional routing
- confirmation
- escalation (counter-based, pushback)
- end-call / DNC handling
- speech & output formatting (voice channel correctness)
- variable scoping (private/read-only/settable, scope=workflow/node/specific_nodes)
- transfer
- speak / spell-out

### 7.5 Build order (single agent v1)

1. **Layer 1** — Zenarate client. Trivial: maybe 8 endpoints, 200 lines. Token + tenant in headers.
2. **Layer 2** — tool wrappers + AgentSpec normalizer. Pull seed suites once, cache as few-shot bank.
3. **Layer 3** — single OpenAI Responses-API agent with a fixed loop (read → propose 5 → validate → revise → finalize). No publish tool.
4. **Layer 4** — minimal HTTP service (Hono / Fastify, your call).
5. **Human review** — staged scenarios written to a folder or DB. Approve → call `createScenario` against Zenarate.

### 7.6 Open question — staging location

Now that we know publish is automatable via API, two reasonable choices:

- **Files in a Git repo** — diff-reviewable, version-controlled, free. Cheap to start.
- **Small DB** (Postgres/SQLite) — better for a UI later, queryable.

Recommend Git-tracked files for v1. Promote to DB only if the review UI grows.

---

## 8. What we did NOT explore (deferred)

- Voice channel preview / live agent runs (`/voice/dashboard-sessions/`) — out of scope for v1 (we only need text-mode tests).
- `/tools`, `/knowledge-base`, `/integrations`, `/connections` — agent capabilities beyond core node graph. Worth a follow-up pass when we want richer AgentSpecs.
- The full set of `resourcetype` node subclasses. We saw `LLMNode`, `EndCallNode`. Others (`CollectionNode`, `TransferNode`, etc.) are inferred from seed suite slugs but not enumerated against a real agent yet.
- The `condition_groups` typed-rule tree on edges (was empty in our sample).
- Authorization scope: whether tenant-admin can read/write any agent or just owned ones.
- Rate limits and 429 behavior on the run endpoint.

---

## 9. ADDENDUM — Integrations (`/api/v1/ipaas/`)

**Major correction to §3:** Zenarate has *two parallel workflow systems*, not one.

### 9.1 The two systems

| System | API namespace | Purpose | Authoring | UI |
|---|---|---|---|---|
| **Voice agent workflows** | `/api/v1/workflow/` | LLM conversations with humans | Visual graph editor (canvas with nodes/edges) | "Agents" sidebar |
| **iPaaS workflows** | `/api/v1/ipaas/` | Background data orchestration (Salesforce queries, batch dialing, post-call writebacks) | **YAML files** | "Integrations" sidebar |

A real production deployment uses both: an iPaaS pipeline schedules and dispatches outbound calls, the voice agent runs the actual conversation, and a second iPaaS pipeline writes results back to Salesforce.

### 9.2 iPaaS endpoints

| Endpoint | Purpose |
|---|---|
| `GET /ipaas/suites/` | List integrations (analogous to TestSuite) |
| `GET /ipaas/suites/<id>/` | Integration detail with embedded scenario summaries |
| `GET /ipaas/scenarios/?suite=<id>` | List workflows in an integration |
| `POST /ipaas/scenarios/<id>/run/` (inferred) | Run a single workflow ("Run scenario X" buttons) |

### 9.3 iPaaS Scenario shape

This is the resource type that maps to a `workflow.yaml` file on disk.

```jsonc
{
  "id": 144,
  "suite": 16,
  "name": "orchestrator",
  "description": "End-to-end ResCon outbound pipeline ...",
  "is_atom": false,                 // atomic primitive vs composite
  "is_active": true,
  "version": 1,
  "order": 0,
  "definition_yaml": "...",         // full YAML source (~10KB for orchestrator)
  "definition_parsed": { ... },     // parsed JSON (server-side parse of YAML)
  "trigger_input": { ... },         // schema for trigger
  "mock_trigger_input": { ... },    // sample input for testing
  "mock_nodes": [ ... ],            // mock outputs for nodes (testing primitive!)
  "connections": [ ... ]            // external integrations referenced (Salesforce via Nango)
}
```

**`mock_nodes` and `mock_trigger_input` are first-class fields** — Generate has built mocking into the platform. That's a strong signal that test generation for iPaaS workflows should produce mocks alongside scenarios.

### 9.4 iPaaS YAML DSL — node types

Observed across 34 production workflow YAMLs:

| Node type | Purpose |
|---|---|
| `subflow` | Call another workflow by file path (`workflow_file: ../pre-call-pipeline/workflow.yaml`) |
| `transform` | JSONata expression to reshape data (`$map`, `$filter`, etc.) |
| `nango_proxy` | Call external SaaS via Nango (Salesforce, etc.) |
| `http_proxy` | Generic HTTP call |
| `batch_call` | **Built-in node** — fans out outbound voice calls in parallel, hands rows to a voice agent |
| `loop` | Iterate over a list |
| `response` | Final output of the workflow |

Plus a trigger block (`type: manual` or scheduled) with an `input_schema` that uses JSON-Schema-ish types (`string`, `integer`, `boolean`, `object`, `array`).

**Templating:** Jinja-style `{{ input.x }}`, `{{ nodes.N.output.y }}`. Subflow refs use **filesystem paths** (`../pre-call-pipeline/workflow.yaml`) — so the platform mirrors a Git repo's directory structure server-side.

### 9.5 Sample integration tree (Integration #16, "ResCon Outbound Pipeline")

```
orchestrator                       (iPaaS, composite)
├── subflow → pre-call-pipeline    (iPaaS, composite)
│             ├── subflow → soql-open-cases     (iPaaS atom)
│             ├── subflow → contact-for-account (iPaaS atom)
│             └── transform / nango_proxy nodes
├── transform                       (shape rows for batch_call)
├── batch_call                      (built-in node — calls a VOICE AGENT per row)
│   └── (inside) → Voice agent workflow #31 "Outbound Reservation Confirmation"
└── subflow → post-call-pipeline   (iPaaS, composite)
              ├── subflow → close-case-confirmed     (iPaaS atom)
              └── subflow → close-case-no-contact   (iPaaS atom)
```

**Key insight:** `batch_call` is the bridge between the two systems. iPaaS orchestrates, hands a row to a voice agent, gets per-row outcomes back. **Tests for the orchestrator must mock the voice agent's outcomes.** Tests for the voice agent must simulate the conversation. They're different tests for different layers.

### 9.6 Voice agent node types — confirmed

After scanning all 3 voice agents in this tenant (workflows #31, #32, #33):

| Type | Observed |
|---|---|
| `LLMNode` | ✓ (most common) |
| `EndCallNode` | ✓ |

The seed-suite slug list (`steps-collection-*`, `steps-confirmation`, `steps-transfer`, `steps-spellout`, `steps-speak`, `steps-branching`) implies more node types exist (`CollectionNode`, `TransferNode`, etc.) — but **none appear in the production agents in this tenant**. Either they're authored as `instruction_steps` *inside* an `LLMNode` (the `step_type: speak | collect | spellout | transfer | confirm` we saw in scenario YAMLs), or they're deprecated. The former is more likely — see §9.8.

### 9.7 LLMNode internals — `instruction_steps`

Looking at a sample scenario's inline `workflow_config`, `LLMNode` has an `instruction_steps` array:

```jsonc
{
  "resourcetype": "LLMNode",
  "title": "NodeA",
  "block_type": "task_following",
  "prompt": "Ask the user for their name.",
  "instruction_steps": [
    { "order": 1, "step_type": "speak",   "mode": "exact", "content": "Hello! What is your name?" },
    { "order": 2, "step_type": "collect", "variable_name": "customer_name" }
  ],
  "node_variables": [
    { "name": "customer_name", "type": "String", "scope": "specific_nodes",
      "scope_node_ids": [1,2], "access_mode": "settable", "is_required": true,
      "confirmation_mode": "none", "description": "The customer's name" }
  ]
}
```

So an `LLMNode` is a *container* of typed step primitives (`speak`, `collect`, `spellout`, `confirm`, `transfer`, `branch`, `endcall`). The seed suite slugs map directly to step types, not node types. **This is the level our test generator must reason about.**

### 9.8 Variable scoping (from seed suite `variables-scoping`)

- `scope`: `workflow` (global), `node` (local), `specific_nodes` (allowlist via `scope_node_ids`)
- `access_mode`: `settable` (LLM extracts), `read_only` (rendered, not extracted), `private` (never rendered or extracted)
- `confirmation_mode`: `none` (and presumably `explicit`, `implicit`)
- `type`: `String`, `Boolean`, others likely (`Integer`, `Date`, enums)

---

## 10. ADDENDUM — How would you test agent and workflow creation?

The user asked: *given the complexity, how do you actually test these things?* Here's the testing strategy informed by the deep dive.

### 10.1 What you're actually testing — three different levels

| Level | What | How |
|---|---|---|
| **L1: Step behavior** | Does a `collect` step extract the variable? Does a `speak` step say the right thing? | Inline `workflow_config` mini-tests (Generate's seed suites do this) |
| **L2: Node + edge routing** | Does NodeA correctly transition to NodeB on "confirmed"? | `node_codes` scoped tests against a real workflow |
| **L3: Full agent / pipeline** | Does the orchestrator complete an outbound campaign end-to-end? | iPaaS integration tests with `mock_nodes` for external calls |

A complete test plan for any non-trivial agent needs all three. Our generator should produce all three flavors — different tools, different prompts, but the same loop.

### 10.2 Per-level generation strategy

**L1 (step behavior) — easiest, mostly already covered.**
- Generate's 17 seed suites already exhaustively test step primitives.
- Our generator only needs to *re-run* these whenever the platform's runtime changes. Use them as regression baseline.
- Mining them gives us the assertion vocabulary for L2/L3.

**L2 (node + edge routing) — the main job of the generator.**
- Input: an `AgentSpec` derived from `/workflow/<id>/` + `/nodes/` + `/edges/`.
- For each node, propose scenarios across these buckets:
  - happy path through this node's outgoing edges
  - each branch condition exercised separately (use the `meta.conditional_description` as the hint for what user-input drives that branch)
  - `is_else` fallback
  - missing/ambiguous input → does the node ask again? (`min_responses` assertion)
  - extracted-variable correctness (`extracted_variables.X: Y`)
  - escalation/global-listener triggers (does saying "speak to a human" route to the escalation flow?)
  - end-state correctness (which `EndCallNode` was reached)
- Each scenario sets `node_codes: [<NodeTitle>]` to scope the assertion.

**L3 (pipeline / iPaaS) — different beast.**
- Tests for orchestrators must **mock the voice agent and the external SaaS calls**, otherwise you'd actually dial real numbers and hit Salesforce.
- The platform already supports this via `mock_nodes` + `mock_trigger_input` on iPaaS scenarios.
- Generator strategy: read the `definition_yaml`, identify external nodes (`nango_proxy`, `batch_call`), generate fixture data for each, plus assertions over the final `response` node's shape.
- Coverage buckets: empty input lists, partial failures (one row fails Salesforce write), all rows succeed, schedule-missed-window, dry_run mode, etc.

### 10.3 Recommended generator architecture (refined)

Our service should have **three generator modes**, sharing infrastructure:

```
                    ┌─────────────────────────────┐
                    │  Zenarate API client        │
                    └─────────────────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
  ┌──────────────┐         ┌──────────────┐         ┌──────────────┐
  │ L2 Generator │         │ L3 Generator │         │ L1 Regression│
  │ Voice agent  │         │ iPaaS        │         │ Use seeds    │
  │ tests        │         │ workflow     │         │ as-is        │
  │              │         │ tests        │         │              │
  │ Reads:       │         │ Reads:       │         │ Reads:       │
  │ /workflow/N/ │         │ /ipaas/scen/ │         │ /testsuite/  │
  │ nodes,edges  │         │ definition_  │         │ suites/      │
  │              │         │ yaml         │         │              │
  │ Emits:       │         │ Emits:       │         │ Emits:       │
  │ Scenarios    │         │ Scenarios    │         │ Run results  │
  │ via test-    │         │ with         │         │ + diffs      │
  │ suite API    │         │ mock_nodes   │         │              │
  └──────────────┘         └──────────────┘         └──────────────┘
```

For **v1**, build only the **L2 Generator** (voice agent tests). It's:
- The highest-leverage (most tests, most variation)
- The most LLM-friendly (it's about conversation design)
- The clearest brief from the user
- Reusable as a foundation — L3 inherits the same client + tool wrappers, only the prompts and validators change.

### 10.4 How we *verify* the generator itself

Meta-question: how do we know the generator's output is good? Three checks, in order of cost:

1. **Schema-valid:** can the platform accept it? (cheap, deterministic — call `validate_scenario` against Zenarate's create endpoint with a dry-run flag if it exists, otherwise create-then-delete in a sandbox suite).
2. **Self-consistent:** do the assertions match the turns? (cheap — e.g., if `min_responses: 4`, are there enough turns to plausibly elicit 4 replies?)
3. **Discriminative:** does the test actually fail when the agent is broken? (expensive — perturb the agent's prompt or remove an edge, re-run the test, expect failure). Borrow from mutation testing literature.

A good generator should produce tests that pass on the working agent **and fail on a broken one**. Without check #3, we're just generating prose.

### 10.5 Concrete v1 milestone

For workflow #31 ("Outbound Reservation Confirmation"):

1. Read agent → AgentSpec with 5 nodes, 3 edges.
2. Generator emits ~25 L2 scenarios across the buckets in §10.2:
   - Authentication node: 6 scenarios (verified, wrong number, no answer, confused user, asks-for-human, hangs up)
   - ReservationConfirmation node: 8 scenarios (confirms, denies, asks to reschedule, partial info, etc.)
   - StayDetailsCollection node: 6 scenarios (correct, partial, refusal)
   - Routing: 5 scenarios that exercise the edge conditions explicitly
3. Validate all 25 → publish as a single TestSuite tied to workflow #31.
4. Run the suite. Read results.
5. Mutation check: temporarily remove the `is_else` edge from Authentication. Re-run. Expect ≥1 scenario to fail. (Sanity check that the tests are discriminative.)

That's the demo. Everything beyond is iteration.

---

## 11. Artifacts

Raw API samples saved alongside this report under `docs/samples/`:

**Voice agents (`/workflow/`):**
- `workflows-list.json` — agent list for tenant `Hiring`
- `workflow-detail.json`, `workflow-detail-32.json`, `workflow-detail-33.json` — all 3 agents
- `workflow-nodes.json`, `workflow-nodes-32.json`, `workflow-nodes-33.json` — graph nodes
- `workflow-edges.json` — graph edges

**Tests (`/testsuite/`):**
- `suites-list.json` — all 17 seed test suites
- `scenarios-suite34.json` — 8 scenarios in `variables-scoping` (with full assertions/turns/workflow_config)
- `runs.json` — run record with Temporal links
- `results.json` — per-scenario results with full transcripts

**Integrations (`/ipaas/`):**
- `integrations-list.json` — 4 production integrations
- `integration-detail-16.json` — ResCon Outbound Pipeline detail
- `integration-scenarios-16.json` — 7 workflows that compose Integration #16
- `ipaas-yaml/*.yaml` — **34 production workflow YAMLs** extracted from `definition_yaml` fields. Read these to understand the iPaaS DSL.

These are the canonical reference for the schema and can be diffed against future API changes.
