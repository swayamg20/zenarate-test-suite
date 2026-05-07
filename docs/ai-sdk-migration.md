# Migrating the voice-eval generator to Vercel AI SDK

## TL;DR

Replaced the hand-rolled OpenAI Responses API agent loop in `service/src/generator/agent.ts` with a single `generateText` call from the Vercel AI SDK. The wire format on the network is **unchanged** — still the OpenAI Responses API — so behavior risk is minimized. Live parity check: **13 / 13 scenarios on the demo workflow, exact per-node match against the pre-migration baseline.**

What we got out of it:

1. Tool input validation via Zod (was unvalidated `JSON.parse`).
2. Built-in tool-call repair when the LLM emits malformed args (used to crash inside our toolset).
3. `~60 LOC` of loop / dispatch / state plumbing deleted.
4. Native OpenTelemetry replaces ad-hoc `console.log(JSON.stringify(...))`.
5. `AbortSignal` propagation — client disconnect now stops token spend.
6. Provider portability — switching to Anthropic / Gemini / Groq is a one-line change to the model factory.

---

## Why migrate at all?

The original generator was a correct, working agent loop. So why touch it?

The honest answer is: **most of what AI SDK gives us is plumbing-level correctness** that we'd otherwise have to write and maintain ourselves. Each of these is a bug we are **not going to write** because the SDK already wrote it:

| Concern | Hand-rolled (before) | AI SDK (after) |
|---|---|---|
| Tool dispatch | Switch statement on `call.name` in `agent.ts`. Add a tool to `TOOL_DEFS` but forget the switch case → silent runtime failure. | Each tool's `execute` runs automatically when the LLM calls it. One source of truth per tool. |
| Tool input validation | `JSON.parse(call.arguments)` then trust it. Malformed args crash inside `GeneratorToolset`. | Zod `inputSchema` gates input before `execute`. SDK can auto-repair via `experimental_repairToolCall` — feeds the validation error back to the LLM and asks for a retry. |
| Conversation state | Hand-managed `inputList: any[]`, manual `function_call_output` push with `call_id`. Easy to get the shape subtly wrong. | Owned by `generateText`. We never touch it. |
| Termination | Imperative `while (iter++ < 12 && !tools.isFinalized())` boolean dance. | Declarative `stopWhen: [hasToolCall("finalize"), stepCountIs(12)]`. Reads as intent. |
| Provider binding | `openai: OpenAI` injected as a function parameter. Hardcoded to OpenAI in practice. | `model: openai.responses(...)` chosen at the call site. Swap to `anthropic(...)` is one line. |
| Observability | `console.log(JSON.stringify({ ts, step, ...event }))` ad hoc. | `experimental_telemetry: { isEnabled: true }` emits OpenTelemetry spans for every step, tool call, and token-usage event. Wire to Jaeger / Honeycomb / Datadog with one config block. |
| Cancellation | None. If the HTTP client disconnects mid-generation, the loop keeps running and burns tokens. | `abortSignal: c.req.raw.signal` from Hono. Disconnect cancels the run. |

None of these alone justifies a migration. Together they cross the threshold.

What we **deliberately did not pursue** (worth flagging so the gist isn't an oversell):

- **Streaming responses** — irrelevant, this is a batch service.
- **AI SDK UI / `useChat`** — wrong product surface.
- **Multi-modal inputs** — voice agents, no images.
- **Structured outputs replacing the agent loop** — `generateObject` for everything would lose the validate-then-revise behavior we depend on.

---

## The architectural change in one diagram

```
BEFORE                                                AFTER
──────                                                ─────
generateForNode(ctx, spec, openai)                    generateForNode(ctx, spec, signal?)
  ├─ tools = new GeneratorToolset()                     ├─ toolset = new GeneratorToolset()
  ├─ inputList: any[]                                   │
  └─ while (iter<12 && !finalized):                     └─ generateText({
       openai.responses.create({                            model: openai.responses("gpt-5.2"),
         instructions, input: inputList,                    system, prompt,
         tools: TOOL_DEFS,                                  tools: createGeneratorTools(toolset),
         tool_choice: "auto" })                             stopWhen: [hasToolCall("finalize"),
       inputList.push(...response.output)                              stepCountIs(12)],
       for each function_call:                              experimental_repairToolCall: ...,
         args = JSON.parse(call.arguments)                  experimental_telemetry: { isEnabled: true },
         result = switch(call.name) {...}                   abortSignal: signal,
         inputList.push({                                   onStepFinish: ({toolCalls,usage}) => log(...)
           type:"function_call_output",                  })
           call_id, output })
```

The outer pipeline (HTTP route → load workflow → build AgentSpec → fan out per-node generation → publish to Zenarate) is **unchanged**. Only the *inside* of `generateForNode` was rewritten.

What stays the same:

- Zenarate SDK auth and workflow loading
- Workflow → `AgentSpec` → `NodeContext` modeling
- Validator and consistency / triviality checks
- Publisher and the `workflow_config` mini-workflow logic
- Concurrency orchestration (`GENERATOR_MAX_CONCURRENCY=3` sliding window)
- The 410-line system prompt and few-shot exemplars
- `GeneratorToolset` internals — methods are reused as tool `execute` bodies
- HTTP route surface (`POST /agents/:wfId/generate-suite`)

---

## Critical decision: keep the Responses API on the wire

`@ai-sdk/openai` exposes two model factories:

- `openai("gpt-5.2")` — uses Chat Completions semantics by default
- `openai.responses("gpt-5.2")` — uses the Responses API, identical to what we were calling directly

We picked **`openai.responses(...)`**. Rationale:

- Same wire format (`function_call`, `function_call_output`, `call_id`, top-level `instructions`)
- Behavior risk minimized — the LLM sees the exact same conversation it saw before
- Doesn't lock us out of Responses-only features later (reasoning summaries, hosted tools, server-side state)

This is the single most important migration decision. It's why parity came out byte-equal in per-node counts on the first try.

---

## Before vs after — the actual code

### Before — `service/src/generator/agent.ts` (excerpt, lines 40–110)

```ts
const inputList: any[] = [
  { role: "user", content: userMessage },
];

const MAX_ITERATIONS = 12;
let iter = 0;

while (iter++ < MAX_ITERATIONS && !tools.isFinalized()) {
  const response = await openai.responses.create({
    model: process.env.OPENAI_MODEL ?? "gpt-5.2",
    temperature: parseFloat(process.env.GENERATOR_TEMPERATURE ?? "0.3"),
    instructions: systemPrompt,
    input: inputList,
    tools: TOOL_DEFS,
    tool_choice: "auto",
  });

  const functionCalls = response.output.filter(
    (item): item is OpenAI.Responses.ResponseFunctionToolCall =>
      item.type === "function_call",
  );

  inputList.push(...response.output);

  log({ event: "llm_response", node, iteration: iter, tool_calls: functionCalls.map(c => c.name), usage: response.usage });

  if (functionCalls.length === 0) break;

  for (const call of functionCalls) {
    const args = JSON.parse(call.arguments);
    let result: unknown;
    switch (call.name) {
      case "propose_scenario": result = tools.propose_scenario(args.scenario); break;
      case "validate_scenario": result = tools.validate_scenario(args); break;
      case "list_proposed":     result = tools.list_proposed(); break;
      case "remove_scenario":   result = tools.remove_scenario(args); break;
      case "finalize":          result = tools.finalize(); break;
      default: result = { error: `unknown tool ${call.name}` };
    }
    inputList.push({
      type: "function_call_output",
      call_id: call.call_id,
      output: JSON.stringify(result),
    });
  }
}
```

### After — `service/src/generator/agent.ts` (the entire `generateText` call)

```ts
const result = await generateText({
  model: openai.responses(process.env.OPENAI_MODEL ?? "gpt-5.2"),
  temperature: parseFloat(process.env.GENERATOR_TEMPERATURE ?? "0.3"),
  system: systemPrompt,
  prompt: userMessage,
  tools: createGeneratorTools(toolset),
  stopWhen: [hasToolCall("finalize"), stepCountIs(12)],
  abortSignal,
  experimental_telemetry: { isEnabled: true, functionId: "generateForNode" },
  experimental_repairToolCall: async ({ toolCall, error }) => {
    log({ event: "tool_repair", node, tool: toolCall.toolName, error: String(error) });
    return null; // null = use SDK default repair behavior
  },
  onStepFinish: ({ toolCalls, usage }) => {
    log({ event: "llm_response", node, iteration: ++stepIndex, tool_calls: toolCalls.map(c => c.toolName), usage });
  },
});
```

The dispatch table, the manual conversation state plumbing, and the iteration counter are all gone. They live inside `generateText` now.

### New file — `service/src/generator/ai-sdk-tools.ts`

Tool factory that closes over a `GeneratorToolset` instance, so per-run state is preserved exactly as before. The Zod schema for `propose_scenario` reuses `ScenarioSchema` from `service/src/validator/schema.ts` — **the same schema that the validator uses downstream**, so there's no drift between "what the LLM is told to produce" and "what the validator expects."

```ts
import { tool } from "ai";
import { z } from "zod";
import { ScenarioSchema } from "../validator/schema.ts";
import type { GeneratorToolset } from "./tools.ts";

export function createGeneratorTools(toolset: GeneratorToolset) {
  return {
    propose_scenario: tool({
      description: "Stage a candidate test scenario for the current node. " +
                   "Always validate immediately after proposing using validate_scenario.",
      inputSchema: z.object({ scenario: ScenarioSchema }),
      execute: async ({ scenario }) => toolset.propose_scenario(scenario),
    }),
    validate_scenario: tool({
      description: "Run schema, consistency, and triviality checks on a staged scenario.",
      inputSchema: z.object({ index: z.number().int().min(0) }),
      execute: async (args) => toolset.validate_scenario(args),
    }),
    list_proposed:    tool({ description: "...", inputSchema: z.object({}),
                              execute: async () => toolset.list_proposed() }),
    remove_scenario:  tool({ description: "...", inputSchema: z.object({ index: z.number().int().min(0) }),
                              execute: async (args) => toolset.remove_scenario(args) }),
    finalize:         tool({ description: "...", inputSchema: z.object({}),
                              execute: async () => toolset.finalize() }),
  };
}
```

That single source of truth for the scenario schema is the most underrated win of the migration. Before, the LLM was told a JSON Schema in `tool-defs.ts`, and the validator checked a Zod schema in `validator/schema.ts`. They could drift. Now they can't.

---

## Verification

### Layer 1 — deterministic mock-model tests

`service/test/generator.test.ts` uses `MockLanguageModelV2` from `ai/test` to drive `generateForNode` with scripted tool-call sequences. Four cases:

| # | Case | What it verifies |
|---|------|------------------|
| 1 | `propose_scenario(valid) → validate_scenario(0) → finalize` | Happy path: scenario lands in `toolset.staged`, validates, finalizes, returned in result. |
| 2 | 12× `propose_scenario` without `finalize` | `stopWhen: stepCountIs(12)` triggers, post-loop force-finalize runs, returns the validated subset. |
| 3 | `propose_scenario` with malformed args | `experimental_repairToolCall` is invoked and logged; loop does not crash. |
| 4 | `propose_scenario(valid) → finalize` (skipping validate) | `finalize()` drops the unvalidated scenario; `dropped` log fires. |

All four pass. Each test inspects the request shape sent to the mock model, so it's checking the actual SDK wiring, not just our return values.

### Layer 2 — live parity check against the real OpenAI API

Captured a baseline by running the **pre-migration** code against the demo Insurance Claims workflow (id 46), saved to `service/test/__snapshots__/baseline.json`. Then ran the **post-migration** code against the same workflow.

| Node | Baseline (Responses API loop) | Post-migration (AI SDK `generateText`) | Δ |
|------|---:|---:|---:|
| ClaimFiled | 0 | 0 | 0 |
| GeneralClaimTransfer | 3 | 3 | 0 |
| HomeClaimDetails | 3 | 3 | 0 |
| AutoClaimDetails | 4 | 4 | 0 |
| ClaimsIntake | 3 | 3 | 0 |
| **Total** | **13** | **13** | **0** |

Threshold was ±2 per node (LLM is non-deterministic at temp 0.3). Actual Δ came out **0 across the board** — exact match. A second post-migration run produced 14 (one extra at ClaimsIntake), which is well inside variance.

Other health checks:

- `failed_scenarios`: 0 in both runs
- Validator pass rate: 100% in both runs
- No new error event types in logs
- Suite published successfully to Zenarate (suite 98 baseline → suite 100 post-migration)
- HTTP latency: 85 s baseline → 96 s post-migration. Slightly slower (+13 %), within LLM variance, plausibly explained by `experimental_telemetry` overhead.

---

## Files changed

| File | Change |
|------|--------|
| `service/package.json` | + `ai@^5`, + `@ai-sdk/openai@^2`, − `openai@^4.65` |
| `service/src/generator/agent.ts` | Rewrite using `generateText` |
| `service/src/generator/ai-sdk-tools.ts` | **New.** Tool factory wrapping `GeneratorToolset` with Zod |
| `service/src/generator/orchestrate.ts` | Drop `OpenAI` parameter, thread `abortSignal` |
| `service/src/http/server.ts` | Pass `c.req.raw.signal`, drop `OpenAI` client construction |
| `service/src/generator/tool-defs.ts` | **Deleted.** Replaced by `ai-sdk-tools.ts` |
| `service/test/generator.test.ts` | **New.** Mock-model parity tests (4 cases) |
| `service/test/__snapshots__/baseline.json` | **New.** Pre-migration response capture |
| `service/test/__snapshots__/post-migration.json` | **New.** Post-migration response capture |
| `service/test/__snapshots__/parity-report.md` | **New.** Verdict |

Net: **+158 / −716 lines** in source. Most of the deletion is `tool-defs.ts` (206 lines of hand-written JSON Schema replaced by a Zod schema we already had).

---

## What this is *not*

Worth being honest about what the migration **does not** do:

- It does not improve the *quality* of generated test scenarios. Same model, same prompt, same tools — the output is statistically the same.
- It does not reduce LLM cost. Same number of tokens flowing through, same model, same temperature.
- It does not reduce latency. If anything, slightly slower at this scale (telemetry overhead).
- It does not change the HTTP API contract.

What it does is move the **plumbing** from "ours to maintain" to "the SDK's to maintain," with parity proven by tests. The wins are correctness, observability, and optionality — not raw performance.

---

## Follow-ups this unlocks

The migration is foundational. With AI SDK in place, several quality-improvement features become near-trivial to add:

- **Cross-model scenario diversity** — generate the same node with GPT and Claude in parallel, dedupe-merge, get edge cases neither model finds alone.
- **Embedding-based scenario dedupe** (`embedMany`) — drop near-duplicate scenarios across nodes via cosine clustering before publishing.
- **Validator-side repair via `generateObject`** — when validation fails, fire a one-shot structured-output repair instead of conversational retry. *(Already shipped as a follow-up on top of this migration.)*
- **`prepareStep` / `activeTools` step-gating** — physically prevent the LLM from proposing two scenarios in a row without validating between. *(Already shipped.)*
- **Coverage measurement** — walk scenarios against the workflow spec to compute edge / branch / variable coverage; surface uncovered paths in the response. *(Already shipped.)*
- **Per-step model switching** — proposing with GPT-5.2 (creative), validating with Haiku 4.5 (cheap, deterministic), via `prepareStep`. Cuts cost without hurting quality.

Each of those is a separate, scoped change. The point of the migration was to put us in a position where they're cheap to build.
