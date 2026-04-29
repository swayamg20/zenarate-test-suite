import { ScenarioSchema } from "./schema.ts";
import type { ScenarioInput } from "./schema.ts";
import { checkConsistency } from "./consistency.ts";
import { isTrivial } from "./triviality.ts";
import type { NodeContext, AgentSpec } from "../spec/types.ts";

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

export { ScenarioSchema } from "./schema.ts";
export type { ScenarioInput } from "./schema.ts";
export { checkConsistency } from "./consistency.ts";
export { isTrivial } from "./triviality.ts";
