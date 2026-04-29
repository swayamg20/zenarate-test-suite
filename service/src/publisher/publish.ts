import { ZenLabsClient } from "zenlabs-web-typescript";
import type { ScenarioInput } from "../validator/schema.js";
import type { AgentSpec } from "../spec/types.js";
import { buildWorkflowConfig } from "./workflow-config.js";

const log = (event: object) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), step: "publish", ...event }));

export interface PublishResult {
  suite_id: number;
  suite_url: string;
  created_scenarios: { id: number; name: string }[];
  failed_scenarios: { name: string; error: string }[];
}

/**
 * Scenarios are generated per-node. Each scenario carries a node_codes reference
 * to its target node. Before publishing, we convert node_codes → workflow_config
 * (a self-contained mini workflow where the target node is the entrypoint).
 * This matches the reference seed scenario format and ensures the platform runs
 * the test starting at the correct node.
 */
function toPublishBody(
  sc: ScenarioInput,
  suiteId: number,
  spec: AgentSpec,
): Record<string, unknown> {
  // Extract target node title from node_codes
  const targetTitle = sc.node_codes?.[0]?.node_title;

  // For node_codes (entrypoint) scenarios, add expected_replies on turns
  // to keep the conversation in sync with the live agent.
  const isEntry = spec.nodes.find(n => n.title === targetTitle)?.is_entrypoint;
  let turns: any[] = sc.turns as any[];
  if (isEntry && turns && turns.length > 0) {
    // Count speak steps before first collect to know how many bot msgs come first
    const nodeSteps = spec.nodes.find(n => n.title === targetTitle)?.instruction_steps ?? [];
    let speaksBefore = 0;
    for (const s of nodeSteps) {
      if (s.step_type === 'collect') break;
      if (s.step_type === 'speak') speaksBefore++;
    }
    turns = [
      { text: turns[0].text, expected_replies: speaksBefore + 1 },
      ...turns.slice(1).map((t: any) => ({ text: t.text, expected_replies: 1 })),
    ];
  }

  // Build scenario body
  const body: Record<string, unknown> = {
    suite: suiteId,
    name: sc.name,
    description: sc.description,
    description_long: sc.description_long,
    turns,
    assertions: sc.assertions,
    initial_state: sc.initial_state || null,
    is_active: true,
  };

  // Entrypoint nodes use node_codes (tests the LIVE agent directly).
  // Non-entrypoint nodes use workflow_config (self-contained mini workflow)
  // because the platform always starts from the entrypoint.
  if (targetTitle && !isEntry) {
    try {
      body.workflow_config = buildWorkflowConfig(spec, targetTitle);
      body.node_codes = [];
    } catch {
      body.node_codes = sc.node_codes;
    }
  } else {
    body.node_codes = sc.node_codes || [];
  }

  return body;
}

export async function publishSuite(
  client: ZenLabsClient,
  spec: AgentSpec,
  scenarios: ScenarioInput[],
  suiteMeta: { title: string; description?: string },
): Promise<PublishResult> {
  // 1. Create the suite bound to the workflow
  const suite = await client.testsuite.suitesCreate({
    title: suiteMeta.title,
    description:
      suiteMeta.description ?? `Generated test suite for ${spec.title}`,
    workflow: spec.id,
    channel: "text",
    mode: "simulation",
    is_active: true,
  });

  const suiteId: number = (suite as any).id;
  log({ event: "suite_created", suite_id: suiteId, title: suiteMeta.title });

  // 2. Create each scenario with workflow_config
  const created: { id: number; name: string }[] = [];
  const failed: { name: string; error: string }[] = [];

  for (const sc of scenarios) {
    try {
      const body = toPublishBody(sc, suiteId, spec);
      const res = await client.testsuite.scenariosCreate(body as any);
      created.push({ id: (res as any).id, name: sc.name });
      log({ event: "scenario_created", name: sc.name, id: (res as any).id });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      failed.push({ name: sc.name, error: message });
      log({ event: "scenario_failed", name: sc.name, error: message });
    }
  }

  log({ event: "publish_done", suite_id: suiteId, created: created.length, failed: failed.length });

  return {
    suite_id: suiteId,
    suite_url: `https://zenarate-prod.vercel.app/tests/${suiteId}`,
    created_scenarios: created,
    failed_scenarios: failed,
  };
}
