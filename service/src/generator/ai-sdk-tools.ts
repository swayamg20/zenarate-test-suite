import { generateObject, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

import { ScenarioSchema } from "../validator/schema.ts";
import type { ScenarioInput } from "../validator/schema.ts";
import type { GeneratorToolset, ScenarioRepair } from "./tools.ts";

export function createScenarioRepair(): ScenarioRepair {
  return async (scenario: ScenarioInput, errors: string[]) => {
    const result = await generateObject({
      model: openai.responses(
        process.env.OPENAI_REPAIR_MODEL ??
          process.env.OPENAI_MODEL ??
          "gpt-5.2",
      ),
      schema: ScenarioSchema,
      system:
        "You will receive a scenario that failed validation. Fix the listed errors. Return ONLY the repaired scenario, schema-valid.",
      prompt:
        "Fix this scenario:\n" +
        JSON.stringify(scenario, null, 2) +
        "\n\nValidation errors:\n" +
        errors.join("\n"),
    });

    return result.object;
  };
}

export function createGeneratorTools(toolset: GeneratorToolset) {
  return {
    propose_scenario: tool({
      description:
        "Stage a candidate test scenario for the current node. " +
        "Always validate immediately after proposing using validate_scenario.",
      inputSchema: z.object({ scenario: ScenarioSchema }),
      execute: async ({ scenario }) => toolset.propose_scenario(scenario),
    }),

    validate_scenario: tool({
      description:
        "Run schema, consistency, and triviality checks on a staged scenario.",
      inputSchema: z.object({ index: z.number().int().min(0) }),
      execute: async (args) => await toolset.validate_scenario(args),
    }),

    list_proposed: tool({
      description:
        "List all currently staged scenarios with their validation status and errors.",
      inputSchema: z.object({}),
      execute: async () => toolset.list_proposed(),
    }),

    remove_scenario: tool({
      description:
        "Remove a staged scenario by index. Use when a scenario repeatedly fails validation " +
        "and cannot be fixed. This unblocks finalize.",
      inputSchema: z.object({ index: z.number().int().min(0) }),
      execute: async (args) => toolset.remove_scenario(args),
    }),

    finalize: tool({
      description:
        "End generation for this node. Returns only validated scenarios. " +
        "Unvalidated scenarios are automatically dropped.",
      inputSchema: z.object({}),
      execute: async () => toolset.finalize(),
    }),
  };
}
