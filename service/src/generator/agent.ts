import { generateText, hasToolCall, stepCountIs } from "ai";
import type { LanguageModel } from "ai";
import { openai } from "@ai-sdk/openai";
import type { NodeContext, AgentSpec } from "../spec/types.ts";
import type { ScenarioInput } from "../validator/schema.ts";
import { isTrivial } from "../validator/triviality.ts";
import { GeneratorToolset } from "./tools.ts";
import { createGeneratorTools } from "./ai-sdk-tools.ts";
import { SYSTEM_PROMPT, FEW_SHOT_EXEMPLARS } from "./prompt.ts";

export interface GenerateForNodeResult {
  scenarios: ScenarioInput[];
  trivial_count: number;
  iterations: number;
}

const log = (event: object) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), step: "generate", ...event }));

export async function generateForNode(
  ctx: NodeContext,
  spec: AgentSpec,
  abortSignal?: AbortSignal,
  model?: LanguageModel,
): Promise<GenerateForNodeResult> {
  const node = ctx.node.title;
  log({ event: "node_start", node, outgoing: ctx.outgoing.length });

  const toolset = new GeneratorToolset(ctx, spec);

  const systemPrompt =
    SYSTEM_PROMPT +
    "\n\n## Examples\n\n" +
    JSON.stringify(FEW_SHOT_EXEMPLARS, null, 2);

  const userMessage =
    `Generate test scenarios for this node. NodeContext:\n\n` +
    "```json\n" +
    JSON.stringify(ctx, null, 2) +
    "\n```\n\n" +
    "Cover the buckets I described. Validate each scenario. Then finalize.";

  let stepIndex = 0;
  const result = await generateText({
    model: model ?? openai.responses(process.env.OPENAI_MODEL ?? "gpt-5.2"),
    temperature: parseFloat(process.env.GENERATOR_TEMPERATURE ?? "0.3"),
    system: systemPrompt,
    prompt: userMessage,
    tools: createGeneratorTools(toolset),
    stopWhen: [hasToolCall("finalize"), stepCountIs(12)],
    abortSignal,
    experimental_telemetry: { isEnabled: true, functionId: "generateForNode" },
    experimental_repairToolCall: async ({ toolCall, error }) => {
      log({
        event: "tool_repair",
        node,
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
        iteration,
        tool_calls: toolCalls.map((c) => c.toolName),
        usage,
      });
    },
  });

  // If the loop ended without a finalize call, force finalize now
  // finalize() now drops unvalidated scenarios instead of blocking
  const final = toolset.isFinalized()
    ? toolset.finalize()
    : toolset.finalize();

  if (final.dropped && final.dropped.length > 0) {
    log({ event: "post_loop_dropped", node, dropped: final.dropped });
  }

  const trivial_count = final.scenarios.filter((s) => isTrivial(s)).length;
  const iterations = result.steps?.length ?? -1;
  log({
    event: "node_done",
    node,
    scenarios: final.scenarios.length,
    trivial_count,
    iterations,
  });
  return { scenarios: final.scenarios, trivial_count, iterations };
}
