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
  assertions: z.object({
    min_responses: z.number().int().min(0).optional(),
    initial_bot_replies: z.number().int().min(0).optional(),
    greeting_contains: z.string().optional(),
    no_raw_jinja: z.boolean().optional(),
    tts_say: z.array(z.string()).optional(),
    variable_types: z.record(z.string()).optional(),
    any_response_contains: z.array(z.string()).optional(),
    no_response_contains: z.array(z.string()).optional(),
    excluded_variables: z.array(z.string()).optional(),
    extracted_variables: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  }).passthrough().optional(),
  initial_state: z.record(z.unknown()).optional(),
  workflow_config: z.unknown().optional(),
});

export type ScenarioInput = z.infer<typeof ScenarioSchema>;
