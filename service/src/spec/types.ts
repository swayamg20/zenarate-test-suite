export interface AgentSpec {
  id: number;
  title: string;
  description: string | null;
  bot_name: string | null;
  system_prompt: string;
  llm_provider: string;
  llm_model: string;
  nodes: SpecNode[];
  edges: SpecEdge[];
}

export interface SpecNode {
  id: number;
  title: string;                // used as node_codes[].node_title
  resourcetype: "LLMNode" | "EndCallNode" | string;
  is_entrypoint: boolean;
  is_end: boolean;
  block_type: string;
  prompt: string | null;
  goodbye_message?: string;
  goodbye_message_mode?: string;
  instruction_steps: SpecStep[];
  variables: SpecVariable[];
}

export interface SpecStep {
  id: number;
  step_type: string;            // speak | collect | condition | set_value | end_conversation | transfer | ...
  resourcetype: string;
  order: number;
  // speak fields
  mode?: string;                // "exact" | "flexible" | "paraphrase"
  content?: string;             // the actual speak text
  // collect fields
  variable_name?: string;
  custom_question?: string;
  // set_value fields (also uses variable_name)
  value?: string;
  // end_conversation / transfer fields
  goodbye_message?: string;
  // condition fields
  condition_groups?: unknown;   // pass through, generator doesn't need to reason inside
}

export interface SpecVariable {
  id: number;
  name: string;
  resourcetype: string;         // BooleanVariable | StringVariable | ...
  description: string | null;
  is_required: boolean;
  scope: "workflow" | "node" | "specific_nodes" | string;
  access_mode: "settable" | "read_only" | "private" | string;
  confirmation_mode?: string;   // "none" | "explicit" | "implicit"
  type?: string;                // "String" | "Boolean" | "Integer" | "Float" | etc
}

export interface SpecEdge {
  id: number;
  from_node_title: string;
  to_node_title: string;
  conditional_description: string;
  is_else: boolean;
  order: number;
}

export interface NodeContext {
  agent: {
    title: string;
    bot_name: string | null;
    system_prompt_excerpt: string;  // first 800 chars
    total_nodes: number;
  };
  node: SpecNode;
  outgoing: {
    to_node_title: string;
    conditional_description: string;
    is_else: boolean;
  }[];
  /** Edges that lead INTO this node (from upstream nodes) */
  incoming: {
    from_node_title: string;
    conditional_description: string;
    is_else: boolean;
  }[];
  /** Variables collected/set by upstream nodes — needed for initial_state seeding */
  upstream_variables: {
    node_title: string;
    variables: {
      name: string;
      type?: string;
      access_mode: string;
      description: string | null;
    }[];
  }[];
}
