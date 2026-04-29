/**
 * OpenAI Responses API tool definitions for the 4 generator tools.
 * Used with openai.responses.create({ tools: TOOL_DEFS }).
 */
export const TOOL_DEFS: any[] = [
  {
    type: "function",
    name: "propose_scenario",
    description:
      "Stage a candidate test scenario for the current node. " +
      "Always validate immediately after proposing using validate_scenario.",
    parameters: {
      type: "object",
      properties: {
        scenario: {
          type: "object",
          description: "A test scenario matching the ScenarioInput schema.",
          properties: {
            name: {
              type: "string",
              description:
                "Short snake_case identifier, e.g. 'auth_happy_path_confirmed'.",
            },
            description: {
              type: "string",
              description: "One-line summary of what this scenario tests.",
            },
            description_long: {
              type: "string",
              description:
                "Detailed markdown documentation showing the asserted path through nodes and instruction steps, with ASCII diagrams and sample conversation transcript.",
            },
            personality: {
              type: "string",
              description:
                "1-2 sentence sketch of the simulated user persona.",
            },
            node_codes: {
              type: "array",
              description: "Scoped to this node.",
              items: {
                type: "object",
                properties: {
                  node_title: { type: "string" },
                  order: { type: "integer", minimum: 0 },
                  python_code: { type: "string" },
                },
                required: ["node_title"],
              },
            },
            turns: {
              type: "array",
              description: "Simulated customer turns.",
              items: {
                type: "object",
                properties: {
                  text: {
                    type: "string",
                    description: "What the customer says.",
                  },
                  expected_replies: {
                    type: "integer",
                    minimum: 0,
                    description:
                      "Number of bot replies expected after this turn.",
                  },
                },
                required: ["text"],
              },
              minItems: 1,
            },
            assertions: {
              type: "object",
              description:
                "Machine-checkable assertions for the scenario. " +
                "Use the appropriate keys to express what the scenario should verify.",
              properties: {
                min_responses: {
                  type: "integer",
                  minimum: 0,
                  description:
                    "Minimum total bot turns expected in the conversation.",
                },
                initial_bot_replies: {
                  type: "integer",
                  minimum: 0,
                  description:
                    "Number of bot turns before the first user turn. Count speak steps before the first collect step.",
                },
                greeting_contains: {
                  type: "string",
                  description:
                    "Substring that the first bot turn must contain.",
                },
                no_raw_jinja: {
                  type: "boolean",
                  description:
                    "If true, asserts that no raw Jinja2/template syntax like {{uuid:...}} appears in bot output. Should be true for any workflow using variable interpolation.",
                },
                tts_say: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Array of EXACT bot utterances expected, in order. Use for speak steps with mode=exact. Each entry is the verbatim content from the speak step.",
                },
                variable_types: {
                  type: "object",
                  description:
                    "Map of variable_name to expected type: 'bool', 'int', 'float', 'str'. Use when set_value steps coerce types.",
                },
                any_response_contains: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Bot said at least one of these substrings somewhere in any response. Use for flexible speak steps or when checking variable interpolation.",
                },
                no_response_contains: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Bot must NOT say any of these substrings. Use for private variables whose values should never appear in speech.",
                },
                excluded_variables: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "These variables must NOT be set/extracted. Use for private variables or variables on untaken branches.",
                },
                extracted_variables: {
                  type: "object",
                  description:
                    "Map of variable_name to expected value. Values can be strings, numbers, booleans, or '!not_none' (meaning the variable must be set but exact value is flexible).",
                },
              },
            },
            initial_state: {
              type: "object",
              description:
                "Pre-populated variable values. Use for testing scenarios where private variables need initial values.",
            },
            workflow_config: {
              type: "object",
              description: "Optional workflow configuration for future use.",
            },
          },
          required: ["name", "turns"],
        },
      },
      required: ["scenario"],
    },
  },
  {
    type: "function",
    name: "validate_scenario",
    description:
      "Run schema, consistency, and triviality checks on a staged scenario.",
    parameters: {
      type: "object",
      properties: {
        index: {
          type: "integer",
          description: "Index of the staged scenario to validate.",
        },
      },
      required: ["index"],
    },
  },
  {
    type: "function",
    name: "remove_scenario",
    description:
      "Remove a staged scenario by index. Use when a scenario repeatedly fails validation " +
      "and cannot be fixed. This unblocks finalize.",
    parameters: {
      type: "object",
      properties: {
        index: {
          type: "integer",
          description: "Index of the staged scenario to remove.",
        },
      },
      required: ["index"],
    },
  },
  {
    type: "function",
    name: "list_proposed",
    description:
      "List all currently staged scenarios with their validation status and errors.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "finalize",
    description:
      "End generation for this node. Returns only validated scenarios. " +
      "Unvalidated scenarios are automatically dropped.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
];
