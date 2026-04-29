/**
 * Normalizes raw SDK responses into clean AgentSpec types.
 */

import type { RawWorkflow } from "./load.ts";
import type {
  AgentSpec,
  SpecNode,
  SpecStep,
  SpecVariable,
  SpecEdge,
  NodeContext,
} from "./types.ts";

/**
 * Map raw SDK workflow + sub-resources to our clean AgentSpec shape.
 */
export function normalize(raw: RawWorkflow): AgentSpec {
  const wf = raw.workflow;

  // Build a lookup from node ID → node title for edge resolution
  const nodeIdToTitle = new Map<number, string>();
  for (const n of raw.nodes) {
    if (n.id != null) {
      nodeIdToTitle.set(n.id, n.title ?? `Node #${n.id}`);
    }
  }

  const nodes: SpecNode[] = raw.nodes.map((n: any) => ({
    id: n.id ?? 0,
    title: n.title ?? "",
    resourcetype: n.resourcetype ?? "BaseNode",
    is_entrypoint: n.is_entrypoint ?? false,
    is_end: n.is_end ?? false,
    block_type: n.block_type ?? "task_following",
    prompt: n.prompt ?? null,
    ...(n.goodbye_message != null ? { goodbye_message: n.goodbye_message } : {}),
    ...(n.goodbye_message_mode != null
      ? { goodbye_message_mode: n.goodbye_message_mode }
      : {}),
    instruction_steps: normalizeSteps(n._instruction_steps ?? n.instruction_steps ?? []),
    variables: normalizeVariables(n._accessible_variables ?? n.node_variables ?? []),
  }));

  const edges: SpecEdge[] = raw.edges.map((e: any) => {
    const meta = e.meta ?? {};
    return {
      id: e.id ?? 0,
      from_node_title: nodeIdToTitle.get(e.from_node) ?? `Unknown #${e.from_node}`,
      to_node_title: e.to_node_title ?? nodeIdToTitle.get(e.to_node) ?? `Unknown #${e.to_node}`,
      conditional_description: meta.conditional_description ?? "",
      is_else: e.is_else ?? false,
      order: e.order ?? 0,
    };
  });

  const llmConfig = wf.llm_config ?? {};

  return {
    id: wf.id ?? 0,
    title: wf.title ?? "",
    description: wf.description ?? null,
    bot_name: wf.bot_name ?? null,
    system_prompt: llmConfig.system_prompt ?? "",
    llm_provider: llmConfig.llm_provider ?? "openai",
    llm_model: llmConfig.llm_model_name ?? "gpt-4o",
    nodes,
    edges,
  };
}

function normalizeSteps(steps: any[]): SpecStep[] {
  return steps.map((s: any) => ({
    id: s.id ?? 0,
    step_type: s.step_type ?? s.resourcetype ?? "unknown",
    resourcetype: s.resourcetype ?? "unknown",
    order: s.order ?? 0,
    // speak fields
    ...(s.mode != null ? { mode: s.mode } : {}),
    ...(s.content != null ? { content: s.content } : {}),
    // collect fields
    ...(s.variable_name != null ? { variable_name: s.variable_name } : {}),
    ...(s.custom_question != null ? { custom_question: s.custom_question } : {}),
    // set_value fields
    ...(s.value != null ? { value: s.value } : {}),
    // end_conversation / transfer fields
    ...(s.goodbye_message != null ? { goodbye_message: s.goodbye_message } : {}),
    // condition fields
    ...(s.condition_groups != null ? { condition_groups: s.condition_groups } : {}),
  }));
}

function normalizeVariables(vars: any[]): SpecVariable[] {
  return vars.map((v: any) => ({
    id: v.id ?? 0,
    name: v.name ?? "",
    resourcetype: v.resourcetype ?? "BaseVariable",
    description: v.description ?? null,
    is_required: v.is_required ?? false,
    scope: v.scope ?? "node",
    access_mode: v.access_mode ?? "settable",
    ...(v.confirmation_mode != null ? { confirmation_mode: v.confirmation_mode } : {}),
    ...(v.type != null ? { type: v.type } : {}),
  }));
}

/**
 * Walk backwards from a node to find all upstream nodes that could
 * have been visited before reaching this node. Returns them in
 * topological order (entrypoint first).
 */
function findUpstreamNodes(spec: AgentSpec, nodeTitle: string): string[] {
  const visited = new Set<string>();
  const queue = [nodeTitle];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of spec.edges) {
      if (edge.to_node_title === current && !visited.has(edge.from_node_title)) {
        visited.add(edge.from_node_title);
        queue.push(edge.from_node_title);
      }
    }
  }

  // Return in topological-ish order: entrypoint first
  const nodeOrder = new Map(spec.nodes.map((n, i) => [n.title, i]));
  return [...visited].sort((a, b) => (nodeOrder.get(a) ?? 0) - (nodeOrder.get(b) ?? 0));
}

/**
 * Build one NodeContext per node, with outgoing edges, incoming edges,
 * and upstream variable info for initial_state seeding.
 */
export function toNodeContexts(spec: AgentSpec): NodeContext[] {
  const nodeMap = new Map(spec.nodes.map((n) => [n.title, n]));

  return spec.nodes.map((node) => {
    const outgoing = spec.edges
      .filter((e) => e.from_node_title === node.title)
      .map((e) => ({
        to_node_title: e.to_node_title,
        conditional_description: e.conditional_description,
        is_else: e.is_else,
      }));

    const incoming = spec.edges
      .filter((e) => e.to_node_title === node.title)
      .map((e) => ({
        from_node_title: e.from_node_title,
        conditional_description: e.conditional_description,
        is_else: e.is_else,
      }));

    // For non-entrypoint nodes, find all upstream nodes and their variables
    const upstream_variables = node.is_entrypoint
      ? []
      : findUpstreamNodes(spec, node.title).map((upTitle) => {
          const upNode = nodeMap.get(upTitle);
          return {
            node_title: upTitle,
            variables: (upNode?.variables ?? []).map((v) => ({
              name: v.name,
              type: v.type,
              access_mode: v.access_mode,
              description: v.description,
            })),
          };
        });

    return {
      agent: {
        title: spec.title,
        bot_name: spec.bot_name,
        system_prompt_excerpt: spec.system_prompt.slice(0, 800),
        total_nodes: spec.nodes.length,
      },
      node,
      outgoing,
      incoming,
      upstream_variables,
    };
  });
}
