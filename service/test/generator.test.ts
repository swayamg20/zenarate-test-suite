import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import test from "node:test";

import type { LanguageModelV2Content } from "@ai-sdk/provider";

import { generateForNode } from "../src/generator/agent.ts";
import type { AgentSpec, NodeContext, SpecNode } from "../src/spec/types.ts";
import type { ScenarioInput } from "../src/validator/schema.ts";

const require = createRequire(import.meta.url);
type ModuleLoad = (
  this: unknown,
  request: string,
  parent: unknown,
  isMain: boolean,
) => unknown;
const moduleWithLoad = Module as unknown as { _load: ModuleLoad };
const originalLoad = moduleWithLoad._load;

moduleWithLoad._load = function (
  this: unknown,
  request: string,
  parent: unknown,
  isMain: boolean,
) {
  if (request === "@ai-sdk/provider-utils/test") {
    return {
      convertArrayToAsyncIterable: (values: unknown[]) => ({
        async *[Symbol.asyncIterator]() {
          yield* values;
        },
      }),
      convertArrayToReadableStream: (values: unknown[]) =>
        new ReadableStream({
          start(controller) {
            values.forEach((value) => controller.enqueue(value));
            controller.close();
          },
        }),
      convertReadableStreamToArray: async (stream: ReadableStream<unknown>) => {
        const reader = stream.getReader();
        const values: unknown[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          values.push(value);
        }
        return values;
      },
      mockId:
        ({ prefix = "id" }: { prefix?: string } = {}) =>
        () =>
          `${prefix}-0`,
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

const { MockLanguageModelV2 } = require("ai/test") as typeof import("ai/test");
moduleWithLoad._load = originalLoad;

const node: SpecNode = {
  id: 1,
  title: "Greeting",
  resourcetype: "LLMNode",
  is_entrypoint: true,
  is_end: false,
  block_type: "llm",
  prompt: "Ask for the caller's first name.",
  instruction_steps: [],
  variables: [
    {
      id: 10,
      name: "first_name",
      resourcetype: "StringVariable",
      description: null,
      is_required: false,
      scope: "node",
      access_mode: "settable",
      type: "String",
    },
  ],
};

const spec: AgentSpec = {
  id: 100,
  title: "Unit Test Agent",
  description: null,
  bot_name: "Ava",
  system_prompt: "You are a helpful test bot.",
  llm_provider: "openai",
  llm_model: "gpt-5.2",
  nodes: [node],
  edges: [],
};

const ctx: NodeContext = {
  agent: {
    title: spec.title,
    bot_name: spec.bot_name,
    system_prompt_excerpt: spec.system_prompt,
    total_nodes: spec.nodes.length,
  },
  node,
  outgoing: [],
  incoming: [],
  upstream_variables: [],
};

const validScenario = (name = "captures_first_name"): ScenarioInput => ({
  name,
  description: "Collects the caller's first name.",
  node_codes: [{ node_title: "Greeting", order: 0, python_code: "pass" }],
  turns: [{ text: "My name is Sam.", expected_replies: 1 }],
  assertions: {
    min_responses: 1,
    extracted_variables: { first_name: "Sam" },
    variable_types: { first_name: "str" },
  },
});

function toolCall(
  toolCallId: string,
  toolName: string,
  input: unknown,
): LanguageModelV2Content {
  return {
    type: "tool-call",
    toolCallId,
    toolName,
    input: JSON.stringify(input),
  };
}

function mockModelForSteps(steps: LanguageModelV2Content[][]) {
  let index = 0;

  return new MockLanguageModelV2({
    doGenerate: async () => {
      const content = steps[index] ?? [];
      index += 1;

      return {
        content,
        finishReason: content.some((part) => part.type === "tool-call")
          ? "tool-calls"
          : "stop",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        warnings: [],
      };
    },
  });
}

async function captureLogs<T>(fn: () => Promise<T>) {
  const originalLog = console.log;
  const logs: unknown[] = [];

  console.log = (message?: unknown, ...optionalParams: unknown[]) => {
    if (typeof message === "string") {
      try {
        logs.push(JSON.parse(message));
      } catch {
        logs.push(message);
      }
    } else {
      logs.push(message);
    }
    if (optionalParams.length > 0) logs.push(optionalParams);
  };

  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.log = originalLog;
  }
}

function logEvents(logs: unknown[]) {
  return logs.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && "event" in entry,
  );
}

test("generateForNode finalizes a validated scenario", async () => {
  const { result, logs } = await captureLogs(() =>
    generateForNode(
      ctx,
      spec,
      undefined,
      // Option B: inject the model because generateForNode owns the production model construction.
      mockModelForSteps([
        [toolCall("call-1", "propose_scenario", { scenario: validScenario() })],
        [toolCall("call-2", "validate_scenario", { index: 0 })],
        [toolCall("call-3", "finalize", {})],
      ]),
    ),
  );

  const events = logEvents(logs);

  assert.equal(result.scenarios.length, 1);
  assert.equal(result.scenarios[0]?.name, "captures_first_name");
  assert.equal(result.iterations, 3);
  assert.equal(events.some((entry) => entry.event === "tool_repair"), false);
  assert.equal(events.some((entry) => entry.event === "validation_failed"), false);
  assert.equal(events.some((entry) => entry.event === "post_loop_dropped"), false);
});

test("generateForNode force-finalizes after the step cap", async () => {
  const steps = Array.from({ length: 12 }, (_, index) => [
    toolCall(`call-${index}`, "propose_scenario", {
      scenario: validScenario(`unvalidated_${index}`),
    }),
  ]);

  const { result } = await captureLogs(() =>
    generateForNode(
      ctx,
      spec,
      undefined,
      mockModelForSteps(steps),
    ),
  );

  assert.equal(result.iterations, 12);
  assert.equal(result.scenarios.length, 0);
});

test("generateForNode repairs malformed tool args without crashing", async () => {
  const malformedScenario = {
    turns: [{ text: "Hello." }],
    assertions: { any_response_contains: ["hello"] },
  };

  const { result, logs } = await captureLogs(() =>
    generateForNode(
      ctx,
      spec,
      undefined,
      mockModelForSteps([
        [toolCall("call-1", "propose_scenario", { scenario: malformedScenario })],
        [toolCall("call-2", "finalize", {})],
      ]),
    ),
  );

  const events = logEvents(logs);

  assert.equal(result.scenarios.length, 0);
  assert.equal(
    events.some(
      (entry) =>
        entry.event === "tool_repair" &&
        entry.tool === "propose_scenario",
    ),
    true,
  );
});

test("generateForNode drops unvalidated scenarios on finalize", async () => {
  const { result, logs } = await captureLogs(() =>
    generateForNode(
      ctx,
      spec,
      undefined,
      mockModelForSteps([
        [toolCall("call-1", "propose_scenario", { scenario: validScenario() })],
        [toolCall("call-2", "finalize", {})],
      ]),
    ),
  );

  const droppedEvents = logEvents(logs).filter(
    (entry) => entry.event === "finalize_dropped",
  );

  assert.equal(result.scenarios.length, 0);
  assert.equal(droppedEvents.length > 0, true);
  assert.deepEqual(droppedEvents[0]?.dropped, ["captures_first_name"]);
});
