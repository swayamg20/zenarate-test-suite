/**
 * Verify-by-running loop.
 *
 * After scenarios are published, runs the suite on the platform,
 * compares results, and repairs failed scenarios up to MAX_RETRIES times.
 */

import type { ZenLabsClient } from "zenlabs-web-typescript";
import type { ScenarioInput } from "../validator/schema.ts";
import type { AgentSpec } from "../spec/types.ts";
import type { LaneContext } from "../spec/walker.ts";
import { generateForLane } from "../generator/agent.ts";

const MAX_RETRIES = 2;
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 180_000; // 3 minutes max

const log = (event: object) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), step: "verify", ...event }));

export interface VerifyResult {
  passed: string[];
  failed: string[];
  dropped: { name: string; reason: string }[];
  total_runs: number;
}

interface ScenarioResult {
  scenario_name: string;
  scenario_id: number;
  status: "passed" | "failed" | "error" | "pending" | "running";
  conversation: { text: string; text_src: string }[];
}

/**
 * Run the suite on the platform and poll until complete.
 * Returns the run ID.
 */
async function triggerAndPollRun(
  client: ZenLabsClient,
  suiteId: number,
): Promise<number> {
  // Trigger the run
  const suite = await client.testsuite.suitesRunCreate(suiteId, {
    body: { title: `Verification run` } as any,
  });

  // Find the latest run for this suite
  const runs = await client.testsuite.runsList({ suite: suiteId } as any);
  const runList = (runs as any).results ?? [];
  const latestRun = runList[0];
  if (!latestRun?.id) {
    throw new Error("Could not find run after triggering suite");
  }

  const runId: number = latestRun.id;
  log({ event: "run_triggered", suite_id: suiteId, run_id: runId });

  // Poll until complete
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const run = await client.testsuite.runsRetrieve(runId);
    const status = (run as any).status;

    if (status === "completed" || status === "failed") {
      log({
        event: "run_complete",
        run_id: runId,
        status,
        passed: (run as any).passed_scenarios,
        failed: (run as any).failed_scenarios,
      });
      return runId;
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(`Run ${runId} timed out after ${POLL_TIMEOUT_MS}ms`);
}

/**
 * Get per-scenario results for a run.
 */
async function getResults(
  client: ZenLabsClient,
  runId: number,
): Promise<ScenarioResult[]> {
  const res = await client.testsuite.resultsList({ run: runId });
  const results = (res as any).results ?? [];
  return results.map((r: any) => ({
    scenario_name: r.scenario_name ?? "",
    scenario_id: r.scenario ?? 0,
    status: r.status ?? "error",
    conversation: (r.conversation ?? []).map((c: any) => ({
      text: c.text ?? "",
      text_src: c.text_src ?? "",
    })),
  }));
}

/**
 * Build a corrective prompt from the actual conversation trace.
 */
function buildCorrectiveContext(
  scenarioName: string,
  laneCtx: LaneContext,
  actualConversation: { text: string; text_src: string }[],
): string {
  const transcript = actualConversation
    .map((c) => `${c.text_src}: ${c.text}`)
    .join("\n");

  return (
    `The previous scenario "${scenarioName}" FAILED on the platform.\n\n` +
    `## Actual conversation trace\n\n` +
    "```\n" + transcript + "\n```\n\n" +
    `## What went wrong\n` +
    `The user turns did not drive the agent to the expected swimlane.\n` +
    `Target: ${laneCtx.lane.test_focus}\n\n` +
    `Adjust the user turns so the agent follows the intended path. ` +
    `Use the actual trace above to understand how the agent responded.`
  );
}

/**
 * Run the verify-by-running loop.
 *
 * 1. Run the suite on the platform
 * 2. Check results
 * 3. For failed scenarios, regenerate with corrective context
 * 4. Replace the failed scenarios in the suite
 * 5. Re-run (up to MAX_RETRIES total)
 * 6. Drop scenarios that still fail
 */
export async function verifyAndRepair(
  client: ZenLabsClient,
  suiteId: number,
  spec: AgentSpec,
  scenarioLaneMap: Map<string, LaneContext>,
  abortSignal?: AbortSignal,
): Promise<VerifyResult> {
  const passed = new Set<string>();
  const dropped: { name: string; reason: string }[] = [];
  let totalRuns = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    log({ event: "verify_attempt", attempt: attempt + 1, suite_id: suiteId });
    totalRuns++;

    // 1. Run the suite
    const runId = await triggerAndPollRun(client, suiteId);

    // 2. Get results
    const results = await getResults(client, runId);

    // 3. Check each scenario
    const failedThisRound: ScenarioResult[] = [];
    for (const r of results) {
      if (r.status === "passed") {
        passed.add(r.scenario_name);
      } else if (!passed.has(r.scenario_name)) {
        failedThisRound.push(r);
      }
    }

    log({
      event: "verify_round_result",
      attempt: attempt + 1,
      passed: passed.size,
      failed: failedThisRound.length,
    });

    // All passed? Done.
    if (failedThisRound.length === 0) break;

    // Last attempt? Drop remaining failures.
    if (attempt === MAX_RETRIES) {
      for (const f of failedThisRound) {
        dropped.push({
          name: f.scenario_name,
          reason: `Failed after ${MAX_RETRIES + 1} attempts. Last status: ${f.status}`,
        });
        log({
          event: "scenario_dropped",
          name: f.scenario_name,
          reason: `Failed ${MAX_RETRIES + 1} times`,
          last_conversation: f.conversation.slice(0, 6),
        });
      }
      break;
    }

    // 4. Regenerate failed scenarios with corrective context
    for (const f of failedThisRound) {
      const laneCtx = scenarioLaneMap.get(f.scenario_name);
      if (!laneCtx) {
        dropped.push({
          name: f.scenario_name,
          reason: "No lane context found for repair",
        });
        continue;
      }

      log({ event: "repair_start", name: f.scenario_name, attempt: attempt + 1 });

      try {
        const result = await generateForLane(
          {
            ...laneCtx,
            // Inject corrective context into the lane's test_focus
            lane: {
              ...laneCtx.lane,
              test_focus:
                laneCtx.lane.test_focus +
                "\n\n" +
                buildCorrectiveContext(f.scenario_name, laneCtx, f.conversation),
            },
          },
          spec,
          abortSignal,
        );

        if (result.scenario) {
          // Update the scenario on the platform
          await client.testsuite.scenariosPartialUpdate(f.scenario_id, {
            name: result.scenario.name,
            turns: result.scenario.turns as any,
            assertions: result.scenario.assertions as any,
            initial_state: result.scenario.initial_state as any,
            description: result.scenario.description,
            description_long: result.scenario.description_long,
          } as any);
          log({ event: "repair_done", name: f.scenario_name, new_name: result.scenario.name });
        } else {
          log({ event: "repair_no_scenario", name: f.scenario_name });
        }
      } catch (e) {
        log({
          event: "repair_error",
          name: f.scenario_name,
          error: String(e),
        });
      }
    }
  }

  return {
    passed: [...passed],
    failed: [],
    dropped,
    total_runs: totalRuns,
  };
}
