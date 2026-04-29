import type { ScenarioInput } from "./schema.ts";

/**
 * A scenario is trivial if its assertions do not actually verify anything
 * meaningful about bot behavior. Trivial scenarios should be regenerated.
 */
export function isTrivial(scenario: ScenarioInput): boolean {
  const a = scenario.assertions ?? {};
  const keys = Object.keys(a);

  // No assertions at all -> trivial
  if (keys.length === 0) return true;

  // Only min_responses <= 1 and nothing else -> trivial
  if (keys.length === 1 && keys[0] === "min_responses") {
    const n = a.min_responses;
    if (typeof n === "number" && n <= 1) return true;
  }

  // A scenario is trivial if it lacks ALL of the meaningful assertion types
  const hasExtractedVariables = a.extracted_variables && Object.keys(a.extracted_variables).length > 0;
  const hasTtsSay = a.tts_say && a.tts_say.length > 0;
  const hasAnyResponseContains = a.any_response_contains && a.any_response_contains.length > 0;
  const hasNoResponseContains = a.no_response_contains && a.no_response_contains.length > 0;

  if (!hasExtractedVariables && !hasTtsSay && !hasAnyResponseContains && !hasNoResponseContains) {
    return true;
  }

  return false;
}
