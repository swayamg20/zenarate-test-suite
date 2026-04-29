import OpenAI from "openai";
import type { NodeContext, AgentSpec } from "../spec/types.ts";
import type { ScenarioInput } from "../validator/schema.ts";
import { isTrivial } from "../validator/triviality.ts";
import { GeneratorToolset } from "./tools.ts";
import { TOOL_DEFS } from "./tool-defs.ts";
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
  openai: OpenAI,
): Promise<GenerateForNodeResult> {
  const node = ctx.node.title;
  log({ event: "node_start", node, outgoing: ctx.outgoing.length });

  const tools = new GeneratorToolset(ctx, spec);

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

  // Running input list — accumulates over the conversation
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

    // Append model output to the running input list
    const functionCalls = response.output.filter(
      (item): item is OpenAI.Responses.ResponseFunctionToolCall =>
        item.type === "function_call",
    );

    // Add all output items to input list for next turn
    inputList.push(...response.output);

    log({
      event: "llm_response",
      node,
      iteration: iter,
      tool_calls: functionCalls.map((c) => c.name),
      usage: response.usage,
    });

    if (functionCalls.length === 0) {
      log({ event: "no_tool_calls", node, iteration: iter });
      break; // LLM stopped calling tools without finalizing
    }

    // Execute each tool call and append results to input list
    for (const call of functionCalls) {
      const args = JSON.parse(call.arguments);
      let result: unknown;
      switch (call.name) {
        case "propose_scenario":
          result = tools.propose_scenario(args.scenario);
          break;
        case "validate_scenario":
          result = tools.validate_scenario(args);
          break;
        case "list_proposed":
          result = tools.list_proposed();
          break;
        case "remove_scenario":
          result = tools.remove_scenario(args);
          break;
        case "finalize":
          result = tools.finalize();
          break;
        default:
          result = { error: `unknown tool ${call.name}` };
      }
      log({ event: "tool_result", node, tool: call.name, result: typeof result === "object" && result !== null && "ok" in result ? { ok: (result as any).ok } : "ok" });

      inputList.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(result),
      });
    }
  }

  // If the loop ended without a finalize call, force finalize now
  // finalize() now drops unvalidated scenarios instead of blocking
  const final = tools.isFinalized()
    ? tools.finalize()
    : tools.finalize();

  if (final.dropped && final.dropped.length > 0) {
    log({ event: "post_loop_dropped", node, dropped: final.dropped });
  }

  const trivial_count = final.scenarios.filter((s) => isTrivial(s)).length;
  log({
    event: "node_done",
    node,
    scenarios: final.scenarios.length,
    trivial_count,
    iterations: iter,
  });
  return { scenarios: final.scenarios, trivial_count, iterations: iter };
}
