/**
 * Loads a workflow and all its sub-resources from the ZenLabs API.
 * Returns raw SDK shapes — normalize.ts maps these to our clean types.
 */

import { ZenLabsClient } from "zenlabs-web-typescript";

const log = (event: object) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), step: "load", ...event }));

export interface RawWorkflow {
  workflow: any;
  nodes: any[];
  edges: any[];
  systemVariables: any[];
}

/**
 * Extract an array of results from a paginated SDK response.
 * Some SDK methods return `{ results: T[] }`, others may return `T[]` directly.
 */
function extractResults(response: any): any[] {
  if (Array.isArray(response)) return response;
  if (response && Array.isArray(response.results)) return response.results;
  return [];
}

/**
 * Run an array of async functions with a concurrency limit.
 */
async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const queue = items.map((item, index) => ({ item, index }));
  const inflight = new Set<Promise<void>>();

  while (queue.length > 0 || inflight.size > 0) {
    while (inflight.size < concurrency && queue.length > 0) {
      const entry = queue.shift()!;
      const p = fn(entry.item)
        .then((result) => {
          results[entry.index] = result;
        })
        .finally(() => {
          inflight.delete(p);
        });
      inflight.add(p);
    }
    if (inflight.size > 0) await Promise.race(inflight);
  }

  return results;
}

/**
 * Fetch a workflow and all related sub-resources in parallel.
 *
 * Phase 1: workflow, nodes, edges, system variables (all in parallel)
 * Phase 2: for each node (max 5 concurrent), fetch instruction steps + accessible variables
 */
export async function loadWorkflow(
  client: ZenLabsClient,
  wfId: number,
): Promise<RawWorkflow> {
  log({ event: "phase1_start", wfId });

  // Phase 1: fetch top-level resources in parallel
  const [workflow, nodesResponse, edgesResponse, systemVariables] =
    await Promise.all([
      client.workflow.workflowsRetrieve(wfId),
      client.workflow.workflowsNodesList(wfId),
      client.workflow.workflowsEdgesList(wfId),
      client.workflow.systemVariablesList(),
    ]);

  const nodes = extractResults(nodesResponse);
  const edges = extractResults(edgesResponse);

  log({ event: "phase1_done", workflow: workflow.title, nodes: nodes.length, edges: edges.length });

  // Phase 2: for each node, fetch instruction steps + accessible variables (max 5 concurrent)
  const wfPk = String(wfId);

  const enrichedNodes = await mapConcurrent(nodes, 5, async (node: any) => {
    const nodeId: number = node.id;

    const [stepsResponse, varsResponse] = await Promise.all([
      client.workflow
        .workflowsNodesInstructionStepsList(wfPk, nodeId)
        .catch(() => []),
      client.workflow
        .workflowsNodesAccessibleVariablesList(wfPk, nodeId)
        .catch(() => []),
    ]);

    return {
      ...node,
      _instruction_steps: extractResults(stepsResponse),
      _accessible_variables: extractResults(varsResponse),
    };
  });

  log({ event: "phase2_done", enriched_nodes: enrichedNodes.length });

  return {
    workflow,
    nodes: enrichedNodes,
    edges,
    systemVariables,
  };
}
