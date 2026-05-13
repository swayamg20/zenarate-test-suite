import { generateText, hasToolCall, stepCountIs } from "ai";
import type { LanguageModel } from "ai";
import { openai } from "@ai-sdk/openai";
import type { AgentSpec } from "../spec/types.ts";
import type { LaneContext } from "../spec/walker.ts";
import type { ScenarioInput } from "../validator/schema.ts";
import { isTrivial } from "../validator/triviality.ts";
import { GeneratorToolset } from "./tools.ts";
import type { ScenarioRepair } from "./tools.ts";
import { createGeneratorTools, createScenarioRepair } from "./ai-sdk-tools.ts";
import { SYSTEM_PROMPT, FEW_SHOT_EXEMPLARS } from "./prompt.ts";

export interface GenerateForLaneResult {
  scenario: ScenarioInput | null;
  trivial: boolean;
  iterations: number;
}

const log = (event: object) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), step: "generate", ...event }));

export async function generateForLane(
  laneCtx: LaneContext,
  spec: AgentSpec,
  abortSignal?: AbortSignal,
  model?: LanguageModel,
  repair?: ScenarioRepair,
): Promise<GenerateForLaneResult> {
  const { nodeCtx, lane } = laneCtx;
  const node = nodeCtx.node.title;
  log({ event: "lane_start", node, lane: lane.id, test_focus: lane.test_focus });

  const toolset = new GeneratorToolset(nodeCtx, spec, repair ?? createScenarioRepair());

  const systemPrompt =
    SYSTEM_PROMPT +
    "\n\n## Examples\n\n" +
    JSON.stringify(FEW_SHOT_EXEMPLARS, null, 2);

  const userMessage =
    `Generate ONE test scenario for swimlane ${lane.id}.\n\n` +
    `## Swimlane\n\n` +
    "```json\n" +
    JSON.stringify(lane, null, 2) +
    "\n```\n\n" +
    `## Full NodeContext\n\n` +
    "```json\n" +
    JSON.stringify(nodeCtx, null, 2) +
    "\n```\n\n" +
    "Trace the steps in this swimlane, generate user turns, compute assertions. " +
    "Propose ONE scenario, validate it, then finalize.";

  let stepIndex = 0;
  const result = await generateText({
    model: model ?? openai.responses(process.env.OPENAI_MODEL ?? "gpt-5.2"),
    temperature: parseFloat(process.env.GENERATOR_TEMPERATURE ?? "0.3"),
    system: systemPrompt,
    prompt: userMessage,
    tools: createGeneratorTools(toolset),
    stopWhen: [hasToolCall("finalize"), stepCountIs(6)],
    prepareStep: ({ steps }) => {
      // After proposing, force a validate/remove/list/finalize step before proposing again.
      if (steps.at(-1)?.toolCalls.some((call) => call.toolName === "propose_scenario")) {
        return {
          activeTools: [
            "validate_scenario",
            "remove_scenario",
            "list_proposed",
            "finalize",
          ],
        };
      }
      return undefined;
    },
    abortSignal,
    experimental_telemetry: { isEnabled: true, functionId: "generateForLane" },
    experimental_repairToolCall: async ({ toolCall, error }) => {
      log({
        event: "tool_repair",
        node,
        lane: lane.id,
        tool: toolCall.toolName,
        error: String(error),
      });
      return null;
    },
    onStepFinish: ({ toolCalls, usage }) => {
      const iteration = stepIndex + 1;
      stepIndex += 1;
      log({
        event: "llm_response",
        node,
        lane: lane.id,
        iteration,
        tool_calls: toolCalls.map((c) => c.toolName),
        usage,
      });
    },
  });

  // Force finalize if the loop ended without one
  const final = toolset.finalize();

  if (final.dropped && final.dropped.length > 0) {
    log({ event: "post_loop_dropped", node, lane: lane.id, dropped: final.dropped });
  }

  const scenario = final.scenarios[0] ?? null;
  const trivial = scenario ? isTrivial(scenario) : false;
  const iterations = result.steps?.length ?? -1;
  log({
    event: "lane_done",
    node,
    lane: lane.id,
    has_scenario: scenario !== null,
    trivial,
    iterations,
  });
  return { scenario, trivial, iterations };
}
