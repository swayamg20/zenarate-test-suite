import type { AgentSpec } from "../spec/types.ts";
import type { ScenarioInput } from "../validator/schema.ts";
import type { CoverageReport } from "../coverage/index.ts";
import { computeCoverage } from "../coverage/index.ts";
import { toNodeContexts } from "../spec/normalize.ts";
import { buildLaneContexts } from "../spec/walker.ts";
import type { LaneContext } from "../spec/walker.ts";
import { generateForLane } from "./agent.ts";

export interface PerNodeResult {
  node: string;
  scenarios: ScenarioInput[];
  trivial_count: number;
}

export interface GenerateAllResult {
  perNode: PerNodeResult[];
  allScenarios: ScenarioInput[];
  coverage: CoverageReport;
  /** Maps scenario name → LaneContext for the verifier's repair loop */
  scenarioLaneMap: Map<string, LaneContext>;
}

export async function generateAll(
  spec: AgentSpec,
  abortSignal?: AbortSignal,
  maxConcurrency = parseInt(process.env.GENERATOR_MAX_CONCURRENCY ?? "3", 10),
): Promise<GenerateAllResult> {
  const contexts = toNodeContexts(spec);
  const lanes = buildLaneContexts(contexts);

  // Accumulate per-lane results, then group by node
  const laneResults: { node: string; scenario: ScenarioInput | null; trivial: boolean; laneCtx: LaneContext }[] = [];

  // Simple concurrency limiter via a sliding window
  const queue = [...lanes];
  const inflight = new Set<Promise<void>>();

  while (queue.length > 0 || inflight.size > 0) {
    while (inflight.size < maxConcurrency && queue.length > 0) {
      const laneCtx = queue.shift()!;
      const p = generateForLane(laneCtx, spec, abortSignal)
        .then(r => {
          laneResults.push({
            node: laneCtx.lane.node_title,
            scenario: r.scenario,
            trivial: r.trivial,
            laneCtx,
          });
        })
        .catch(err => {
          console.error(
            JSON.stringify({
              step: "generate",
              node: laneCtx.lane.node_title,
              lane: laneCtx.lane.id,
              error: String(err),
            }),
          );
          laneResults.push({ node: laneCtx.lane.node_title, scenario: null, trivial: false, laneCtx });
        })
        .finally(() => {
          inflight.delete(p);
        });
      inflight.add(p);
    }
    if (inflight.size > 0) await Promise.race(inflight);
  }

  // Group lane results by node to produce PerNodeResult[]
  const nodeMap = new Map<string, { scenarios: ScenarioInput[]; trivial_count: number }>();
  for (const lr of laneResults) {
    let entry = nodeMap.get(lr.node);
    if (!entry) {
      entry = { scenarios: [], trivial_count: 0 };
      nodeMap.set(lr.node, entry);
    }
    if (lr.scenario) {
      entry.scenarios.push(lr.scenario);
      if (lr.trivial) entry.trivial_count += 1;
    }
  }

  const perNode: PerNodeResult[] = [];
  for (const [node, entry] of nodeMap) {
    perNode.push({ node, scenarios: entry.scenarios, trivial_count: entry.trivial_count });
  }

  // Build scenario → LaneContext map for verifier
  const scenarioLaneMap = new Map<string, LaneContext>();
  for (const lr of laneResults) {
    if (lr.scenario) {
      scenarioLaneMap.set(lr.scenario.name, lr.laneCtx);
    }
  }

  const allScenarios = perNode.flatMap(r => r.scenarios);
  const coverage = computeCoverage(spec, allScenarios);
  return { perNode, allScenarios, coverage, scenarioLaneMap };
}
