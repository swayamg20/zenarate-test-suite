import type { AgentSpec } from "../spec/types.ts";
import type { ScenarioInput } from "../validator/schema.ts";
import type { CoverageReport } from "../coverage/index.ts";
import { computeCoverage } from "../coverage/index.ts";
import { toNodeContexts } from "../spec/normalize.ts";
import { generateForNode } from "./agent.ts";

export interface PerNodeResult {
  node: string;
  scenarios: ScenarioInput[];
  trivial_count: number;
}

export interface GenerateAllResult {
  perNode: PerNodeResult[];
  allScenarios: ScenarioInput[];
  coverage: CoverageReport;
}

export async function generateAll(
  spec: AgentSpec,
  abortSignal?: AbortSignal,
  maxConcurrency = parseInt(process.env.GENERATOR_MAX_CONCURRENCY ?? "3", 10),
): Promise<GenerateAllResult> {
  const contexts = toNodeContexts(spec);
  const results: PerNodeResult[] = [];

  // Simple concurrency limiter via a sliding window
  const queue = [...contexts];
  const inflight = new Set<Promise<void>>();

  while (queue.length > 0 || inflight.size > 0) {
    while (inflight.size < maxConcurrency && queue.length > 0) {
      const ctx = queue.shift()!;
      const p = generateForNode(ctx, spec, abortSignal)
        .then(r => {
          results.push({
            node: ctx.node.title,
            scenarios: r.scenarios,
            trivial_count: r.trivial_count,
          });
        })
        .catch(err => {
          // Log and continue — one node failing shouldn't kill the whole run
          console.error(
            JSON.stringify({
              step: "generate",
              node: ctx.node.title,
              error: String(err),
            }),
          );
          results.push({ node: ctx.node.title, scenarios: [], trivial_count: 0 });
        })
        .finally(() => {
          inflight.delete(p);
        });
      inflight.add(p);
    }
    if (inflight.size > 0) await Promise.race(inflight);
  }

  const allScenarios = results.flatMap(r => r.scenarios);
  const coverage = computeCoverage(spec, allScenarios);
  return { perNode: results, allScenarios, coverage };
}
