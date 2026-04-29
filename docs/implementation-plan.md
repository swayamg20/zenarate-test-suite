# Implementation Plan

> The architecture doc says *what* to build. This says *how*, in order.
> Hand this to an engineer (or Codex) and they should be able to build it without further input.

---

## 0. Session resume — read this first

If you're picking this up cold (new session, new contributor, future-you), this is everything you need to know in 90 seconds.

### What this is
A take-home assignment for **Zenarate** — a voice-agent platform. Given any voice agent on their platform, build a microservice that generates a complete test suite for it and publishes the suite back into the platform via API.

### What we're building
A microservice (Node + TypeScript + Hono) with an LLM agent inside. Deterministic shell does HTTP / schema / publishing. The LLM agent (OpenAI Responses API, `gpt-4.1-mini`, temperature 0.3) reasons about what to test, per node. Reads agent → produces 3-6 scenarios per node → validates → publishes to Zenarate's `/testsuite/` API.

### What's NOT in scope
- iPaaS workflow tests (different generator, deferred — `docs/architecture.md` §12)
- Voice channel / execution mode (text + simulation only)
- Conversation-level multi-node scenarios (per-node only)
- Deployment, auth on our service (localhost demo)

### Locked decisions
- **Language:** TypeScript, Node 20+
- **HTTP framework:** Hono
- **LLM:** OpenAI Responses API, `gpt-4.1-mini`, temperature 0.3
- **Generation unit:** per-node, parallel max 3 concurrent
- **Coverage per node:** 1 happy path + 1 per outgoing branch + 1 for `is_else` + 1 for end-state ≈ 3-6 scenarios
- **Few-shot bank:** 4-5 hand-picked seed scenarios in the system prompt (from `docs/samples/scenarios-suite34.json`)
- **Triviality check:** post-generation, flag don't reject
- **Broken agent handling:** none — generate what we can, no warnings
- **Endpoint:** `POST /agents/:wfId/generate-suite`, optional `body: { dry_run: true }`
- **State:** stateless service, no DB

### Where the design lives
| Doc | Purpose |
|---|---|
| `docs/architecture.md` | Final architecture, 12 sections, top-to-bottom read |
| `docs/discovery-report.md` | Full reverse-engineering of the Zenarate platform (724 lines) |
| `docs/samples/` | Verified API responses (don't guess shapes — read these) |
| `docs/samples/api-write-examples/README.md` | Verified POST bodies for suite + scenario |
| `docs/approach.md` | Pitch summary (for sharing, can be ignored when building) |
| `discovery/` | Playwright script — one-time, not a runtime dependency |
| `scripts/rebuild_workflow.py` | Recovery tool for a platform sync bug we hit |

### Status — what's done

```
✓ Discovery (Playwright + dashboard walkthrough)
✓ Architecture locked (docs/architecture.md)
✓ Implementation plan written (this doc, §1+ below)
✓ service/ scaffolded (package.json, tsconfig, .env.example)
✓ ZenLabs SDK obtained (at ~/Downloads/zenlabs-sdk-master/)
✓ SDK explored — all methods mapped to our pipeline operations
✓ Auth flow verified — BasicAuth login → token works
✓ Base URL confirmed — must override to zenarate-web-prod.fly.dev
```

**Superseded (delete during Step 0):**
```
✗ service/src/zenarate/types.ts — replaced by SDK types
✗ service/src/zenarate/client.ts — replaced by SDK + factory.ts
```

### Status — what's next

```
↳ Step 0: SDK setup + auth factory               ← START HERE
  Step 1: spec module (load via SDK + normalize)
  Step 2: validator (schema + consistency + triviality)
  Step 3: generator tools (the 4-tool class + OpenAI tool defs)
  Step 4: generator agent loop (system prompt, agent.ts, orchestrate.ts)
  Step 5: publisher (via SDK, possibly single bulk call)
  Step 6: HTTP layer (Hono, one endpoint)
  Step 7: smoke test on workflow #37
```

Each step has full file paths, exports, and concrete code below.

### How to authenticate when running locally

The ZenLabs SDK supports **programmatic auth via BasicAuth**. No more manual token scraping from the browser.

**Option A — Programmatic login (preferred):**
Set credentials in `service/.env`:
```
ZENARATE_USERNAME=dev@zenlabs.com
ZENARATE_PASSWORD=<password>
ZENARATE_TENANT_ID=6
```
The factory calls `tokenAuthLoginCreate()` with BasicAuth headers → gets a fresh token on every startup.

**Option B — Direct token (fallback):**
If you already have a token, pass it directly:
```
ZENARATE_TOKEN=<64-char DRF token>
ZENARATE_TENANT_ID=6
```
The factory skips login and uses the token as-is.

**Important:** `ZENARATE_TENANT_ID` must be numeric (6), NOT the slug ("hiring") — slug returns "Invalid tenant".

**Base URL:** SDK default (`api.zenlabs.com`) doesn't resolve. Override with `ZENARATE_API_BASE=https://zenarate-web-prod.fly.dev` (SDK adds `/api/v1/` internally).

### Demo target

Workflow **#37** ("Test_Swayam (rebuilt)"). It's a small 3-node booking-flow agent that the user rebuilt earlier (the original wf #33 had a sync bug — see `scripts/rebuild_workflow.py`). Good for a first end-to-end smoke. For richer demos, workflow **#31** (Outbound Reservation Confirmation) has 5 nodes and real conditional logic.

### When you resume — the literal first action

```bash
cd /Users/swayam.gupta/Documents/GitHub/voice-eval/service
# Install deps (including SDK)
npm install
npm run typecheck
# Then start Step 0 below: install SDK, create factory.ts, delete old client
```

---

## What's already done

```
voice-eval/
├── docs/
│   ├── architecture.md             ✓ design (updated for SDK)
│   ├── discovery-report.md         ✓ platform reverse-engineering
│   ├── samples/                    ✓ verified API responses (reference)
│   └── samples/api-write-examples/ ✓ verified write contracts (reference)
├── discovery/                      ✓ Playwright script (one-time, not runtime)
├── scripts/
│   └── rebuild_workflow.py         ✓ recovery tool for the voice-runtime sync bug
└── service/
    ├── package.json                ✓ scaffolded
    ├── tsconfig.json               ✓ scaffolded
    ├── .env.example                ✓ scaffolded (needs update for SDK auth)
    ├── .gitignore                  ✓ scaffolded
    └── src/
        └── zenarate/
            ├── types.ts            ✗ TO DELETE — replaced by SDK types
            └── client.ts           ✗ TO DELETE — replaced by SDK + factory.ts

~/Downloads/zenlabs-sdk-master/     ✓ ZenLabs SDK (TypeScript + Python, Fern-generated)
```

The captured samples in `docs/samples/` remain useful as a reference for field shapes, but the runtime client is now the SDK.

---

## Build order (dependency tree)

```
0. SDK setup + auth factory ── depends on: ZenLabs SDK
1. Spec module             ── depends on: SDK client, SDK types
2. Validator (schema part) ── depends on: spec types
3. Generator tools         ── depends on: spec, validator
4. Generator agent loop    ── depends on: tools, OpenAI SDK
5. Validator (full)        ── depends on: nothing new (but used by generator)
6. Publisher               ── depends on: SDK client
7. HTTP layer              ── depends on: all of the above
8. End-to-end smoke test   ── needs a real workflow id
```

Each step below specifies file paths, exports, and verification.

---

## Step 0 — SDK setup + auth factory

**Actions:**

1. Install the ZenLabs TypeScript SDK as a local dependency:
   ```bash
   cd service
   npm install ../../../Downloads/zenlabs-sdk-master/web/typescript
   ```

2. Delete the hand-written client (replaced by SDK):
   ```bash
   rm src/zenarate/types.ts src/zenarate/client.ts
   ```

3. Create the auth factory:

**File to create:**

```
service/src/zenarate/
└── factory.ts      SDK client initialization + optional BasicAuth login
```

### `zenarate/factory.ts` — exports

```ts
import { ZenLabsClient } from "zenlabs-web-typescript";

export interface ClientConfig {
  baseUrl: string;
  tenantId: string;
  token?: string;           // direct token (Option B)
  username?: string;         // for BasicAuth login (Option A)
  password?: string;
}

export async function createClient(cfg?: ClientConfig): Promise<ZenLabsClient> {
  const baseUrl = cfg?.baseUrl ?? process.env.ZENARATE_API_BASE ?? "https://zenarate-web-prod.fly.dev";
  const tenantId = cfg?.tenantId ?? process.env.ZENARATE_TENANT_ID;
  if (!tenantId) throw new Error("ZENARATE_TENANT_ID is required (numeric, NOT slug)");

  // Option B: direct token
  let token = cfg?.token ?? process.env.ZENARATE_TOKEN;

  // Option A: programmatic login via BasicAuth
  if (!token) {
    const username = cfg?.username ?? process.env.ZENARATE_USERNAME;
    const password = cfg?.password ?? process.env.ZENARATE_PASSWORD;
    if (!username || !password) {
      throw new Error("Either ZENARATE_TOKEN or ZENARATE_USERNAME + ZENARATE_PASSWORD required");
    }
    const tempClient = new ZenLabsClient({ baseUrl });
    const basic = Buffer.from(`${username}:${password}`).toString("base64");
    const login = await tempClient.auth.tokenAuthLoginCreate({
      headers: { Authorization: `Basic ${basic}` },
    });
    if (!login.token) throw new Error("Login succeeded but no token returned");
    token = login.token;
  }

  return new ZenLabsClient({ token, baseUrl, tenantId });
}

export function clientFromEnv(): Promise<ZenLabsClient> {
  return createClient();
}
```

### `service/.env.example` — updated

```
# Option A: Programmatic login (preferred)
ZENARATE_USERNAME=dev@zenlabs.com
ZENARATE_PASSWORD=
ZENARATE_TENANT_ID=6

# Option B: Direct token (fallback)
# ZENARATE_TOKEN=your_64_char_drf_token_here

# Base URL (SDK default doesn't resolve, override required)
ZENARATE_API_BASE=https://zenarate-web-prod.fly.dev

# OpenAI
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
GENERATOR_TEMPERATURE=0.3
GENERATOR_MAX_CONCURRENCY=3

PORT=3000
```

### Verification

```bash
# Quick smoke — does the factory connect and auth?
npx tsx -e "
  import { clientFromEnv } from './src/zenarate/factory.ts';
  const c = await clientFromEnv();
  const wf = await c.workflow.workflowsRetrieve(37);
  console.log('Connected:', wf.title);
"
```

---

## Step 1 — Spec module

**Files to create:**

```
service/src/spec/
├── types.ts        AgentSpec, NodeContext type definitions
├── load.ts         loadWorkflow(client, wfId) → raw + sub-resources
└── normalize.ts    normalize(raw) → AgentSpec; toNodeContexts(spec) → NodeContext[]
```

### `spec/types.ts` — exports

```ts
export interface AgentSpec {
  id: number;
  title: string;
  description: string | null;
  bot_name: string | null;
  system_prompt: string;
  llm_provider: string;
  llm_model: string;
  nodes: SpecNode[];
  edges: SpecEdge[];
}

export interface SpecNode {
  id: number;
  title: string;                // used as node_codes[].node_title
  resourcetype: "LLMNode" | "EndCallNode";
  is_entrypoint: boolean;
  is_end: boolean;
  block_type: string;
  prompt: string | null;
  goodbye_message?: string;
  goodbye_message_mode?: string;
  instruction_steps: SpecStep[];
  variables: SpecVariable[];
}

export interface SpecStep {
  id: number;
  step_type: string;            // speak | collect | condition | set_value | ...
  resourcetype: string;
  order: number;
  variable_name?: string;
  custom_question?: string;
  value?: string;
  condition_groups?: unknown;   // pass through, generator doesn't need to reason inside
}

export interface SpecVariable {
  id: number;
  name: string;
  resourcetype: string;         // BooleanVariable | StringVariable | ...
  description: string | null;
  is_required: boolean;
  scope: "workflow" | "node" | "specific_nodes";
  access_mode: "settable" | "read_only" | "private";
}

export interface SpecEdge {
  id: number;
  from_node_title: string;
  to_node_title: string;
  conditional_description: string;
  is_else: boolean;
  order: number;
}

export interface NodeContext {
  agent: {
    title: string;
    bot_name: string | null;
    system_prompt_excerpt: string;  // first 800 chars
    total_nodes: number;
  };
  node: SpecNode;
  outgoing: {
    to_node_title: string;
    conditional_description: string;
    is_else: boolean;
  }[];
}
```

### `spec/load.ts` — exports

```ts
import { ZenLabsClient } from "zenlabs-web-typescript";

export interface RawWorkflow {
  workflow: any;          // SDK Workflow type
  nodes: any[];           // SDK Node type, each with instruction_steps + variables attached
  edges: any[];           // SDK Edge type
  systemVariables: any[]; // system-level variables (always available)
}

export async function loadWorkflow(
  client: ZenLabsClient,
  wfId: number,
): Promise<RawWorkflow>;
```

Implementation: in parallel, call:
- `client.workflow.workflowsRetrieve(wfId)`
- `client.workflow.workflowsNodesList(wfId)`
- `client.workflow.workflowsEdgesList(wfId)`
- `client.workflow.systemVariablesList()`

Then for each node, fetch in parallel (max concurrency 5):
- `client.workflow.workflowsNodesInstructionStepsList(wfId, nodeId)`
- `client.workflow.workflowsNodesAccessibleVariablesList(wfId, nodeId)` ← NEW: gives all in-scope variables, not just node-local

Attach results to each node object.

### `spec/normalize.ts` — exports

```ts
export function normalize(raw: RawWorkflow): AgentSpec;
export function toNodeContexts(spec: AgentSpec): NodeContext[];
```

`normalize`: maps SDK response shapes → AgentSpec shape. Edges' `from_node` / `to_node` (numeric ids) are resolved to `from_node_title` / `to_node_title` by joining with nodes.

`toNodeContexts`: one NodeContext per node. For each node, find outgoing edges by matching `from_node_title === node.title`.

### Verification

```ts
// in test/spec.test.ts
import { clientFromEnv } from "../src/zenarate/factory.ts";
import { loadWorkflow } from "../src/spec/load.ts";
import { normalize, toNodeContexts } from "../src/spec/normalize.ts";

// Live test against workflow #37
// Pass through normalize.
// Assert: nodes present, edges present, entrypoint exists, etc.
```

---

## Step 2 — Validator (schema part)

**Files to create:**

```
service/src/validator/
├── schema.ts       schema check against ScenarioCreate shape
├── consistency.ts  self-consistency rules
├── triviality.ts   non-triviality scoring
└── index.ts        validate(scenario, ctx) → { ok, errors, trivial }
```

### `validator/schema.ts`

Use `zod` (already in package.json). Define a schema matching the verified `ScenarioCreate` body:

```ts
import { z } from "zod";

export const ScenarioSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  description_long: z.string().optional(),
  personality: z.string().optional(),
  node_codes: z.array(z.object({
    node_title: z.string().min(1),
    order: z.number().int().min(0).optional(),
    python_code: z.string().optional(),
  })).optional(),
  turns: z.array(z.object({
    text: z.string().min(1),
    expected_replies: z.number().int().min(0).optional(),
  })).min(1),
  assertions: z.record(z.unknown()).optional(),
  initial_state: z.record(z.unknown()).optional(),
});

export type ScenarioInput = z.infer<typeof ScenarioSchema>;
```

### `validator/consistency.ts`

Returns an array of error strings. Empty = OK.

```ts
export function checkConsistency(
  scenario: ScenarioInput,
  ctx: NodeContext,
): string[] {
  const errors: string[] = [];

  // Rule 1: every node_codes[].node_title must exist in the agent
  const validTitles = new Set([ctx.node.title, ...ctx.outgoing.map(e => e.to_node_title)]);
  // Plus we probably want all nodes from the AgentSpec — pass in as additional arg
  for (const nc of scenario.node_codes ?? []) {
    if (!validTitles.has(nc.node_title)) {
      errors.push(
        `node_title "${nc.node_title}" not found on agent. ` +
        `Valid options for this node context: ${[...validTitles].join(", ")}`
      );
    }
  }

  // Rule 2: min_responses cannot exceed plausible bot replies
  // Bot replies ≈ turns + initial_bot_replies. Roughly.
  const minResponses = scenario.assertions?.min_responses;
  if (typeof minResponses === "number" && minResponses > scenario.turns.length + 2) {
    errors.push(
      `min_responses=${minResponses} is unrealistic with ${scenario.turns.length} turns`
    );
  }

  // Rule 3: extracted_variables references must match real variable names on the node
  const validVars = new Set(ctx.node.variables.map(v => v.name));
  const extracted = scenario.assertions?.extracted_variables;
  if (extracted && typeof extracted === "object") {
    for (const k of Object.keys(extracted)) {
      // Allow dotted keys; first segment is the variable name
      const top = k.split(".")[0];
      if (top && !validVars.has(top)) {
        errors.push(
          `extracted_variables.${k}: variable "${top}" not declared on node "${ctx.node.title}". ` +
          `Available: ${[...validVars].join(", ") || "(none)"}`
        );
      }
    }
  }

  return errors;
}
```

### `validator/triviality.ts`

```ts
export function isTrivial(scenario: ScenarioInput): boolean {
  // Heuristic: a scenario is trivial if its assertions don't actually check anything specific.
  const a = scenario.assertions ?? {};
  const keys = Object.keys(a);

  // Only checks min_responses and nothing else → trivial
  if (keys.length === 0) return true;
  if (keys.length === 1 && keys[0] === "min_responses") {
    const n = a.min_responses as number;
    if (n <= 1) return true;
  }

  // No extracted_variables AND no greeting_contains AND no initial_bot_replies > 1
  const hasMeaningful =
    a.extracted_variables ||
    a.greeting_contains ||
    (typeof a.initial_bot_replies === "number" && a.initial_bot_replies >= 1);

  return !hasMeaningful;
}
```

### `validator/index.ts`

```ts
export interface ValidationResult {
  ok: boolean;
  errors: string[];
  trivial: boolean;
}

export function validate(
  raw: unknown,
  ctx: NodeContext,
  agentSpec: AgentSpec,
): ValidationResult {
  const parsed = ScenarioSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`),
      trivial: false,
    };
  }
  const consistency = checkConsistency(parsed.data, ctx, agentSpec);
  if (consistency.length > 0) {
    return { ok: false, errors: consistency, trivial: false };
  }
  return { ok: true, errors: [], trivial: isTrivial(parsed.data) };
}
```

---

## Step 3 — Generator tools

**Files to create:**

```
service/src/generator/
├── tools.ts        the four tools as a class with state
├── tool-defs.ts    OpenAI tool schema definitions
```

### `generator/tools.ts`

The tools share state per-node (an in-memory working set). Implement as a class instantiated per generation call.

```ts
export interface StagedScenario {
  index: number;
  scenario: ScenarioInput;
  validated: boolean;
  validation_errors: string[];
}

export class GeneratorToolset {
  private staged: StagedScenario[] = [];
  private finalized = false;

  constructor(
    private ctx: NodeContext,
    private spec: AgentSpec,
  ) {}

  propose_scenario(scenario: unknown): { index: number } {
    const idx = this.staged.length;
    this.staged.push({
      index: idx,
      scenario: scenario as ScenarioInput,
      validated: false,
      validation_errors: [],
    });
    return { index: idx };
  }

  validate_scenario(args: { index: number }): { ok: true } | { ok: false; errors: string[] } {
    const slot = this.staged[args.index];
    if (!slot) return { ok: false, errors: [`no scenario at index ${args.index}`] };
    const r = validate(slot.scenario, this.ctx, this.spec);
    slot.validated = r.ok;
    slot.validation_errors = r.errors;
    return r.ok ? { ok: true } : { ok: false, errors: r.errors };
  }

  list_proposed(): { scenarios: { index: number; name: string; node_codes: unknown; validated: boolean }[] } {
    return {
      scenarios: this.staged.map(s => ({
        index: s.index,
        name: s.scenario.name,
        node_codes: s.scenario.node_codes,
        validated: s.validated,
      })),
    };
  }

  finalize(): { scenarios: ScenarioInput[]; error?: string } {
    const unvalidated = this.staged.filter(s => !s.validated);
    if (unvalidated.length > 0) {
      return {
        scenarios: [],
        error: `${unvalidated.length} scenarios are unvalidated. Validate them or remove them before finalizing. Unvalidated indices: ${unvalidated.map(s => s.index).join(", ")}`,
      };
    }
    this.finalized = true;
    return { scenarios: this.staged.map(s => s.scenario) };
  }

  isFinalized(): boolean {
    return this.finalized;
  }
}
```

### `generator/tool-defs.ts`

OpenAI tool schemas for the Responses API:

```ts
export const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "propose_scenario",
      description:
        "Stage a candidate test scenario for the current node. " +
        "Always validate immediately after proposing using validate_scenario.",
      parameters: {
        type: "object",
        properties: {
          scenario: { /* JSON Schema mirroring ScenarioSchema */ },
        },
        required: ["scenario"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "validate_scenario",
      description: "Run schema, consistency, and triviality checks on a staged scenario.",
      parameters: {
        type: "object",
        properties: { index: { type: "integer" } },
        required: ["index"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_proposed",
      description: "List all currently staged scenarios for this node.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "finalize",
      description:
        "End generation for this node. Only validated scenarios are returned. " +
        "If any scenario is unvalidated, this fails — validate them first.",
      parameters: { type: "object", properties: {} },
    },
  },
];
```

---

## Step 4 — Generator agent loop

**Files to create:**

```
service/src/generator/
├── prompt.ts       system prompt + few-shot bank
├── agent.ts        generateForNode(nodeContext, spec, openai) → Scenario[]
└── orchestrate.ts  generateAll(spec, openai) → Scenario[]  (parallel, max 3)
```

### `generator/prompt.ts`

```ts
export const SYSTEM_PROMPT = `You write test scenarios for voice agents on the Zenarate platform.

You will be given ONE node from a voice agent. Your job is to produce 3-6 test scenarios that exercise that node's behavior — happy path, each conditional branch, and edge cases like ambiguity or escalation.

Each scenario simulates a customer interacting with the bot at that node. Write turns the customer would actually say. Write assertions a machine can check.

## The DSL

Every scenario is an object with these fields:
- name: short snake_case identifier ("auth_happy_path_confirmed")
- description: one-line summary
- description_long: optional markdown — useful for documenting the asserted path
- personality: a 1-2 sentence sketch of the simulated user
- node_codes: array, scoped to this node — [{ "node_title": "<title>", "order": 0 }]
- turns: array of { text: string, expected_replies?: number }
- assertions: object — combine these as appropriate:
    min_responses: integer (minimum bot turns)
    initial_bot_replies: integer (expected number of opening bot turns)
    extracted_variables: { var_name: expected_value }
    greeting_contains: substring of first bot turn

## Style notes

- Names should be short and specific. NOT "test_1" or "user_says_yes". USE "auth_confirmed_first_ask", "reservation_denied_then_reschedule".
- Turns should be plausible voice utterances. Short. Direct. NOT "I would like to please confirm my booking" — USE "Yes, that's me".
- Assertions should check something specific. NOT "the bot replies" — USE "extracted_variables.is_authenticated: true".
- description_long is optional but encouraged when the asserted path is non-obvious.

## How to work

For the node you're given:
1. Identify the coverage buckets that apply: happy path, each outgoing branch, the is_else fallback if any, an ambiguity case, and end-state correctness if it's an EndCallNode.
2. For each bucket, propose ONE scenario via propose_scenario, then validate_scenario immediately.
3. If validation fails, fix the issue and propose again with the same name (overwrite is fine — it just stages a new index).
4. When you've covered the buckets, call finalize.

You cannot publish, fetch agent data, or call HTTP. The four tools are your entire surface.

Be tight. 3-6 scenarios per node, each doing one thing.
`;

export const FEW_SHOT_EXEMPLARS = [
  // 4-5 hand-picked seed scenarios, in JSON
  // Pull from docs/samples/scenarios-suite34.json (variables-scoping)
  // and 1-2 from steps-collection-core, 1 from edges-routing
  // Format: { name, description, turns, assertions } — strip workflow_config
];
```

### `generator/agent.ts`

```ts
import OpenAI from "openai";

export async function generateForNode(
  ctx: NodeContext,
  spec: AgentSpec,
  openai: OpenAI,
): Promise<{ scenarios: ScenarioInput[]; trivial_count: number; iterations: number }> {
  const tools = new GeneratorToolset(ctx, spec);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: SYSTEM_PROMPT + "\n\n## Examples\n\n" + JSON.stringify(FEW_SHOT_EXEMPLARS, null, 2),
    },
    {
      role: "user",
      content:
        `Generate test scenarios for this node. NodeContext:\n\n` +
        "```json\n" + JSON.stringify(ctx, null, 2) + "\n```\n\n" +
        "Cover the buckets I described. Validate each scenario. Then finalize.",
    },
  ];

  const MAX_ITERATIONS = 12;
  let iter = 0;

  while (iter++ < MAX_ITERATIONS && !tools.isFinalized()) {
    const resp = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
      temperature: parseFloat(process.env.GENERATOR_TEMPERATURE ?? "0.3"),
      messages,
      tools: TOOL_DEFS as any,
      tool_choice: "auto",
    });

    const msg = resp.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      break;  // LLM stopped calling tools without finalizing
    }

    for (const call of msg.tool_calls) {
      const args = JSON.parse(call.function.arguments);
      let result: unknown;
      switch (call.function.name) {
        case "propose_scenario": result = tools.propose_scenario(args.scenario); break;
        case "validate_scenario": result = tools.validate_scenario(args); break;
        case "list_proposed":     result = tools.list_proposed(); break;
        case "finalize":          result = tools.finalize(); break;
        default:                  result = { error: `unknown tool ${call.function.name}` };
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  const final = tools.finalize();
  if (final.error) {
    throw new Error(`Generation for node ${ctx.node.title} failed: ${final.error}`);
  }

  // Count trivial after generation
  const trivial_count = final.scenarios.filter(s => isTrivial(s)).length;
  return { scenarios: final.scenarios, trivial_count, iterations: iter };
}
```

### `generator/orchestrate.ts`

```ts
export async function generateAll(
  spec: AgentSpec,
  openai: OpenAI,
  maxConcurrency = 3,
): Promise<{
  perNode: { node: string; scenarios: ScenarioInput[]; trivial_count: number }[];
  allScenarios: ScenarioInput[];
}> {
  const contexts = toNodeContexts(spec);
  const results: typeof perNode = [];

  // Simple concurrency limiter via a sliding window
  const queue = [...contexts];
  const inflight = new Set<Promise<void>>();

  while (queue.length > 0 || inflight.size > 0) {
    while (inflight.size < maxConcurrency && queue.length > 0) {
      const ctx = queue.shift()!;
      const p = generateForNode(ctx, spec, openai)
        .then(r => {
          results.push({ node: ctx.node.title, scenarios: r.scenarios, trivial_count: r.trivial_count });
        })
        .catch(err => {
          // Log and continue — one node failing shouldn't kill the whole run
          console.error(JSON.stringify({ step: "generate", node: ctx.node.title, error: String(err) }));
          results.push({ node: ctx.node.title, scenarios: [], trivial_count: 0 });
        })
        .finally(() => { inflight.delete(p); });
      inflight.add(p);
    }
    if (inflight.size > 0) await Promise.race(inflight);
  }

  const allScenarios = results.flatMap(r => r.scenarios);
  return { perNode: results, allScenarios };
}
```

---

## Step 5 — Publisher

**Files to create:**

```
service/src/publisher/
└── publish.ts      publishSuite(client, spec, scenarios, suiteMeta) → result
```

```ts
import { ZenLabsClient } from "zenlabs-web-typescript";

export interface PublishResult {
  suite_id: number;
  suite_url: string;
  created_scenarios: { id: number; name: string }[];
  failed_scenarios: { name: string; error: string }[];
}

export async function publishSuite(
  client: ZenLabsClient,
  spec: AgentSpec,
  scenarios: ScenarioInput[],
  suiteMeta: { title: string; description?: string },
): Promise<PublishResult> {
  // 1. Create the suite via SDK
  const suite = await client.testsuite.suitesCreate({
    title: suiteMeta.title,
    description: suiteMeta.description ?? `Generated test suite for ${spec.title}`,
    workflow: spec.id,
    channel: "text",
    mode: "simulation",
    is_active: true,
  });

  // 2. Create scenarios — sequential, SDK has built-in retry (maxRetries: 2)
  //    We add one extra attempt on top for resilience.
  const created: { id: number; name: string }[] = [];
  const failed: { name: string; error: string }[] = [];

  for (const sc of scenarios) {
    try {
      const res = await client.testsuite.scenariosCreate({
        ...sc,
        suite: suite.id,
      });
      created.push({ id: res.id, name: sc.name });
    } catch (e: any) {
      failed.push({ name: sc.name, error: e.message ?? String(e) });
    }
  }

  return {
    suite_id: suite.id,
    suite_url: `https://zenarate-prod.vercel.app/tests/${suite.id}`,
    created_scenarios: created,
    failed_scenarios: failed,
  };
}
```

**Alternative: Bulk seed (if supported by this tenant).** The SDK has `client.testsuite.suitesBulkSeedCreate()` which can create a suite + all scenarios in one call. Worth testing during Step 7 — if it works, the publisher simplifies to a single API call.

---

## Step 6 — HTTP layer

**Files to create:**

```
service/src/http/
└── server.ts       Hono app, one endpoint
```

```ts
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import "dotenv/config";
import OpenAI from "openai";

import { clientFromEnv } from "../zenarate/factory.ts";
import { loadWorkflow } from "../spec/load.ts";
import { normalize } from "../spec/normalize.ts";
import { generateAll } from "../generator/orchestrate.ts";
import { publishSuite } from "../publisher/publish.ts";

const app = new Hono();

app.post("/agents/:wfId/generate-suite", async (c) => {
  const wfId = parseInt(c.req.param("wfId"), 10);
  if (Number.isNaN(wfId)) return c.json({ error: "invalid wfId" }, 400);

  const body = await c.req.json().catch(() => ({}));
  const dryRun = body.dry_run === true;

  const reqId = crypto.randomUUID();
  const t0 = Date.now();
  const log = (event: object) =>
    console.log(JSON.stringify({ ts: new Date().toISOString(), req_id: reqId, ...event }));

  try {
    log({ step: "start", wf_id: wfId, dry_run: dryRun });

    const client = await clientFromEnv();  // async — may do BasicAuth login
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    log({ step: "load", wf_id: wfId });
    const raw = await loadWorkflow(client, wfId);

    log({ step: "normalize", nodes: raw.nodes.length, edges: raw.edges.length });
    const spec = normalize(raw);

    log({ step: "generate" });
    const { perNode, allScenarios } = await generateAll(spec, openai);

    if (dryRun) {
      log({ step: "done", dry_run: true, total_ms: Date.now() - t0 });
      return c.json({ dry_run: true, spec, perNode, scenarios: allScenarios });
    }

    log({ step: "publish", count: allScenarios.length });
    const result = await publishSuite(client, spec, allScenarios, {
      title: `Generated tests — ${spec.title}`,
    });

    log({ step: "done", suite_id: result.suite_id, total_ms: Date.now() - t0 });

    return c.json({
      ...result,
      per_node_summary: perNode.map(r => ({
        node: r.node,
        generated: r.scenarios.length,
        trivial_count: r.trivial_count,
      })),
      elapsed_ms: Date.now() - t0,
    });
  } catch (e: any) {
    log({ step: "error", message: e.message, stack: e.stack });
    return c.json({ error: e.message }, 500);
  }
});

const port = parseInt(process.env.PORT ?? "3000", 10);
console.log(`voice-eval listening on :${port}`);
serve({ fetch: app.fetch, port });
```

---

## Step 7 — Smoke test

After the service is built and running:

```bash
# 1. Get a fresh token
# (manual: login via dashboard, copy localStorage.auth_token, paste into .env)

# 2. Run the service
cd service && npm install && npm run dev

# 3. In another shell, dry-run against workflow #37 (the rebuilt TestSwayam)
curl -X POST http://localhost:3000/agents/37/generate-suite \
  -H "Content-Type: application/json" \
  -d '{"dry_run": true}' | jq

# 4. If output looks right, do the real run
curl -X POST http://localhost:3000/agents/37/generate-suite \
  -H "Content-Type: application/json" -d '{}' | jq

# 5. Open the returned suite_url in the dashboard, hit Run All
```

### Expected output of dry-run

```jsonc
{
  "dry_run": true,
  "spec": { "id": 37, "title": "Test_Swayam (rebuilt)", "nodes": [...], "edges": [...] },
  "perNode": [
    { "node": "Booking detail", "scenarios": [...], "trivial_count": 0 }
  ],
  "scenarios": [
    {
      "name": "booking_exists_happy_path",
      "node_codes": [{ "node_title": "Booking detail", "order": 0 }],
      "turns": [...],
      "assertions": { "extracted_variables": { "booking": true } }
    }
  ]
}
```

### Things to verify before declaring done

- [ ] Dry-run on workflow #37 produces ≥3 scenarios
- [ ] Each scenario passes schema validation
- [ ] No trivial scenarios for any meaningful node
- [ ] Real run creates a suite + scenarios in the dashboard
- [ ] Dashboard "Run All" actually executes them and produces results
- [ ] At least one scenario passes (proves the test makes sense)
- [ ] At least one scenario can be made to fail by editing the agent (proves discrimination)

---

## Risks and known issues

1. **Token expiry.** DRF tokens may not expire, but if they do, the service surfaces a 401. Re-mint manually.
2. **OpenAI rate limits.** Per-node is 1 generation = ~3-5 LLM calls. A 10-node agent = 30-50 calls. Should stay under per-minute limits but flag if hit.
3. **Scenario name collisions.** Zenarate may reject scenarios with duplicate names within a suite. Validator should add a uniqueness check (left as a small follow-up).
4. **The few-shot bank quality bounds output quality.** If the 4-5 exemplars are weak, the generator will be weak. Pick exemplars carefully — variety across node types and assertion patterns.
5. **No cleanup on partial failure.** If publishing fails mid-suite, the suite is left partially populated. Manual cleanup via DELETE.

---

## File-by-file checklist for the implementer

```
service/src/
├── zenarate/
│   └── factory.ts               — Step 0 (SDK auth + client init)
├── spec/
│   ├── types.ts                 — Step 1
│   ├── load.ts                  — Step 1 (uses SDK client)
│   └── normalize.ts             — Step 1
├── validator/
│   ├── schema.ts                — Step 2
│   ├── consistency.ts           — Step 2
│   ├── triviality.ts            — Step 2
│   └── index.ts                 — Step 2
├── generator/
│   ├── tools.ts                 — Step 3
│   ├── tool-defs.ts             — Step 3
│   ├── prompt.ts                — Step 4
│   ├── agent.ts                 — Step 4
│   └── orchestrate.ts           — Step 4
├── publisher/
│   └── publish.ts               — Step 5 (uses SDK client)
└── http/
    └── server.ts                — Step 6
```

That's 11 new files, ~600 LOC total (down from 12 files / ~800 LOC — SDK eliminated ~200 lines of hand-written client code).
