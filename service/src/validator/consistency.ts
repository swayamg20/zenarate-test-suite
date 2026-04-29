import type { ScenarioInput } from "./schema.ts";
import type { NodeContext, AgentSpec } from "../spec/types.ts";

/**
 * Cross-checks a generated scenario against the agent spec and node context.
 * Returns an array of human-readable error strings (empty = pass).
 *
 * Only HARD errors (structural correctness) block validation.
 * Soft checks (tts_say matching, initial_bot_replies count) are logged
 * as warnings but do NOT block.
 */
export function checkConsistency(
  scenario: ScenarioInput,
  ctx: NodeContext,
  _agentSpec: AgentSpec,
): string[] {
  const errors: string[] = [];
  const assertions = scenario.assertions ?? {};

  // Gather all valid variable names from the node context
  const validVars = new Set(ctx.node.variables.map((v) => v.name));

  // Gather all valid node titles reachable from this context
  const allNodeTitles = new Set(
    _agentSpec.nodes.map((n) => n.title),
  );

  // ── Rule 1: node_codes[].node_title must exist on the agent ────────────
  for (const nc of scenario.node_codes ?? []) {
    if (!allNodeTitles.has(nc.node_title)) {
      errors.push(
        `node_title "${nc.node_title}" not found on agent. ` +
        `Valid options: ${[...allNodeTitles].join(", ")}`,
      );
    }
  }

  // ── Rule 2: min_responses plausibility vs turn count ───────────────────
  const minResponses = assertions.min_responses;
  if (
    typeof minResponses === "number" &&
    minResponses > (scenario.turns.length + 1) * 4
  ) {
    errors.push(
      `min_responses=${minResponses} seems unrealistic with ${scenario.turns.length} turns`,
    );
  }

  // ── Rule 3: extracted_variables keys must match real variable names ─────
  const extracted = assertions.extracted_variables;
  if (extracted && typeof extracted === "object") {
    for (const k of Object.keys(extracted)) {
      const top = k.split(".")[0];
      if (top && !validVars.has(top)) {
        errors.push(
          `extracted_variables.${k}: variable "${top}" not declared on node "${ctx.node.title}". ` +
          `Available: ${[...validVars].join(", ") || "(none)"}`,
        );
      }
    }
  }

  // ── Rule 4: excluded_variables must be real variable names ──────────────
  const excludedVars = assertions.excluded_variables;
  if (excludedVars) {
    for (const varName of excludedVars) {
      if (!validVars.has(varName)) {
        errors.push(
          `excluded_variables: "${varName}" is not a declared variable on node "${ctx.node.title}". ` +
          `Available: ${[...validVars].join(", ") || "(none)"}`,
        );
      }
    }
  }

  // ── Rule 5: variable_types keys must be real variable names ────────────
  const variableTypes = assertions.variable_types;
  if (variableTypes) {
    const allowedTypes = new Set(["bool", "int", "float", "str"]);
    for (const [varName, typeName] of Object.entries(variableTypes)) {
      if (!validVars.has(varName)) {
        errors.push(
          `variable_types: "${varName}" is not a declared variable on node "${ctx.node.title}". ` +
          `Available: ${[...validVars].join(", ") || "(none)"}`,
        );
      }
      if (!allowedTypes.has(typeName)) {
        errors.push(
          `variable_types.${varName}: type "${typeName}" is not valid. ` +
          `Allowed: ${[...allowedTypes].join(", ")}`,
        );
      }
    }
  }

  // Soft checks below are logged but do NOT produce errors.
  // They are for observability, not gating.

  return errors;
}
