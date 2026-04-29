/**
 * Builds a workflow_config object for a scenario, making the target node
 * the entrypoint of a self-contained mini workflow.
 *
 * This matches the reference seed scenario format — each scenario carries
 * its own inline workflow definition so the platform runs the test starting
 * directly at the target node.
 */

import type { AgentSpec, SpecNode, SpecEdge } from "../spec/types.ts";

/**
 * Given a target node title and the full agent spec, build a workflow_config
 * that makes the target node the entrypoint. Includes the target node + any
 * directly connected downstream nodes (for edge/transition testing).
 */
export function buildWorkflowConfig(
  spec: AgentSpec,
  targetNodeTitle: string,
): Record<string, unknown> {
  const targetNode = spec.nodes.find((n) => n.title === targetNodeTitle);
  if (!targetNode) {
    throw new Error(`Node "${targetNodeTitle}" not found in spec`);
  }

  // Build a 2-node mini workflow: target LLMNode + one EndCallNode.
  // All passing reference scenarios use exactly this shape.
  // If the target IS an EndCallNode, just include it alone.
  const outgoingEdges = spec.edges.filter(
    (e) => e.from_node_title === targetNodeTitle,
  );

  let includedNodes: SpecNode[];
  if (targetNode.resourcetype === "EndCallNode") {
    // EndCallNode is the entrypoint — just include it alone
    includedNodes = [targetNode];
  } else {
    // LLMNode: include it + find or create an EndCallNode downstream
    const downstreamEnd = outgoingEdges
      .map((e) => spec.nodes.find((n) => n.title === e.to_node_title))
      .find((n) => n?.resourcetype === "EndCallNode");

    if (downstreamEnd) {
      includedNodes = [targetNode, downstreamEnd];
    } else {
      // No direct EndCallNode downstream — create a synthetic one
      const syntheticEnd: SpecNode = {
        id: 9999,
        title: "End",
        resourcetype: "EndCallNode",
        is_entrypoint: false,
        is_end: true,
        block_type: "",
        prompt: null,
        goodbye_message: "Thank you for calling. Goodbye.",
        goodbye_message_mode: "flexible",
        instruction_steps: [],
        variables: [],
      };
      includedNodes = [targetNode, syntheticEnd];
    }
  }

  // Assign sequential IDs (1-based) for the mini workflow
  const nodeIdMap = new Map<string, number>();
  includedNodes.forEach((n, i) => nodeIdMap.set(n.title, i + 1));

  // Build node objects
  const nodes = includedNodes.map((n, i) => {
    const isTarget = n.title === targetNodeTitle;
    const nodeObj: Record<string, unknown> = {
      id: i + 1,
      title: n.title,
      is_end: n.is_end,
      workflow: 1,
      description: n.title,
      resourcetype: n.resourcetype,
      is_entrypoint: isTarget, // target node is the entrypoint
    };

    if (n.resourcetype === "LLMNode") {
      nodeObj.prompt = n.prompt || "";
      nodeObj.block_type = n.block_type;
      nodeObj.respond_immediately = true;

      // Inline instruction steps
      nodeObj.instruction_steps = n.instruction_steps.map((step) => {
        const s: Record<string, unknown> = {
          order: step.order,
          step_type: step.step_type,
        };
        if (step.mode) s.mode = step.mode;
        if (step.content) s.content = step.content;
        if (step.variable_name) s.variable_name = step.variable_name;
        if (step.custom_question) s.custom_question = step.custom_question;
        if (step.value) s.value = step.value;
        if (step.goodbye_message) {
          s.goodbye_message = step.goodbye_message;
          s.goodbye_message_mode = "exact";
        }
        return s;
      });

      // Only include variables that are referenced by this node's instruction steps
      // (collect, set_value) — NOT all accessible variables from the workflow
      const referencedVarNames = new Set(
        n.instruction_steps
          .filter((s) => s.variable_name)
          .map((s) => s.variable_name!),
      );
      // Also include private variables (for leak testing)
      const nodeVars = n.variables.filter(
        (v) => referencedVarNames.has(v.name) || v.access_mode === "private",
      );

      nodeObj.node_variables = nodeVars.map((v) => {
        const varObj: Record<string, unknown> = {
          name: v.name,
          type: v.type || mapResourceTypeToType(v.resourcetype),
          access_mode: v.access_mode,
          description: v.description || v.name,
          is_required: v.is_required,
          confirmation_mode: v.confirmation_mode || "none",
        };
        return varObj;
      });
    }

    if (n.resourcetype === "EndCallNode") {
      nodeObj.goodbye_message = n.goodbye_message || "Goodbye.";
      nodeObj.goodbye_message_mode = n.goodbye_message_mode || "flexible";
    }

    return nodeObj;
  });

  // Build a single edge: target → EndCallNode (if both exist)
  const edges: Record<string, unknown>[] = [];
  if (includedNodes.length === 2) {
    edges.push({
      id: 1,
      workflow: 1,
      from_node: nodeIdMap.get(includedNodes[0]!.title),
      to_node: nodeIdMap.get(includedNodes[1]!.title),
      order: 1,
      is_else: false,
      meta: { conditional_description: "Transition to end" },
    });
  }

  // Build workflow metadata
  const workflow = {
    id: 1,
    title: `Test: ${spec.title} — ${targetNodeTitle}`,
    bot_name: spec.bot_name || "Test Bot",
    llm_config: {
      top_k: 0,
      top_p: 1.0,
      max_tokens: 1000,
      temperature: 0.0,
      llm_provider: spec.llm_provider || "openai",
      system_prompt: spec.system_prompt || "You are a helpful assistant.",
      llm_model_name: spec.llm_model || "gpt-4o-mini",
    },
    description: spec.description || spec.title,
    company_name: spec.bot_name || "Test Company",
    company_description: "",
  };

  // Standard platform config (placeholder values, required by the platform)
  const transcriber = {
    id: 1,
    title: "STT",
    api_key: "<DEEPGRAM_API_KEY>",
    workflow: 1,
    model_slug: "flux-general-en",
    resourcetype: "DeepgramFluxTranscriber",
  };

  const phone_config = {
    id: 1,
    title: "Phone",
    auth_token: "<TWILIO_AUTH_TOKEN>",
    account_sid: "<TWILIO_ACCOUNT_SID>",
    phone_number: "+16508809059",
    resourcetype: "TwilioPhoneNumber",
    inbound_workflow: 1,
    outbound_workflow: 1,
  };

  const voice_provider = {
    id: 1,
    title: "TTS",
    api_key: "<CARTESIA_API_KEY>",
    workflow: 1,
    model_slug: "sonic-3",
    resourcetype: "CartesiaVoiceProvider",
  };

  return {
    nodes,
    edges,
    workflow,
    transcriber,
    phone_config,
    voice_provider,
  };
}

/** Map variable resourcetype to simple type string */
function mapResourceTypeToType(resourcetype: string): string {
  const map: Record<string, string> = {
    StringVariable: "String",
    BooleanVariable: "Boolean",
    IntegerVariable: "Integer",
    FloatVariable: "Float",
    AlphanumericVariable: "String",
    DateVariable: "Date",
    TimeVariable: "Time",
    EmailVariable: "Email",
    PhoneNumberVariable: "PhoneNumber",
  };
  return map[resourcetype] || "String";
}
