import assert from "node:assert/strict";
import test from "node:test";

import { computeCoverage } from "../src/coverage/index.ts";
import type { AgentSpec, SpecNode } from "../src/spec/types.ts";
import type { ScenarioInput } from "../src/validator/schema.ts";

function node(
  id: number,
  title: string,
  overrides: Partial<SpecNode> = {},
): SpecNode {
  return {
    id,
    title,
    resourcetype: "LLMNode",
    is_entrypoint: id === 1,
    is_end: false,
    block_type: "llm",
    prompt: null,
    instruction_steps: [],
    variables: [],
    ...overrides,
  };
}

function linearSpec(): AgentSpec {
  return {
    id: 1,
    title: "Coverage Fixture",
    description: null,
    bot_name: "Ava",
    system_prompt: "Test fixture.",
    llm_provider: "openai",
    llm_model: "gpt-5.2",
    nodes: [
      node(1, "A", {
        variables: [
          {
            id: 10,
            name: "var_x",
            resourcetype: "StringVariable",
            description: null,
            is_required: false,
            scope: "node",
            access_mode: "settable",
            type: "String",
          },
          {
            id: 11,
            name: "var_y",
            resourcetype: "StringVariable",
            description: null,
            is_required: false,
            scope: "node",
            access_mode: "settable",
            type: "String",
          },
        ],
      }),
      node(2, "B", {
        instruction_steps: [
          {
            id: 20,
            step_type: "speak",
            resourcetype: "SpeakStep",
            order: 0,
            content: "Thanks {{var_x}}.",
          },
        ],
      }),
      node(3, "C", { is_end: true }),
    ],
    edges: [
      {
        id: 100,
        from_node_title: "A",
        to_node_title: "B",
        conditional_description: "",
        is_else: false,
        order: 0,
      },
      {
        id: 101,
        from_node_title: "B",
        to_node_title: "C",
        conditional_description: "",
        is_else: false,
        order: 1,
      },
    ],
  };
}

function branchSpec(): AgentSpec {
  return {
    ...linearSpec(),
    nodes: [
      node(1, "A"),
      node(2, "B"),
      node(3, "C", { is_end: true }),
      node(4, "D", { is_end: true }),
    ],
    edges: [
      {
        id: 100,
        from_node_title: "A",
        to_node_title: "B",
        conditional_description: "",
        is_else: false,
        order: 0,
      },
      {
        id: 101,
        from_node_title: "B",
        to_node_title: "C",
        conditional_description: "claim_type is auto",
        is_else: false,
        order: 1,
      },
      {
        id: 102,
        from_node_title: "B",
        to_node_title: "D",
        conditional_description: "claim_type is home",
        is_else: false,
        order: 2,
      },
    ],
  };
}

function splitSpec(): AgentSpec {
  return {
    ...linearSpec(),
    nodes: [
      node(1, "A"),
      node(2, "B", { is_end: true }),
      node(3, "C", { is_end: true }),
    ],
    edges: [
      {
        id: 100,
        from_node_title: "A",
        to_node_title: "B",
        conditional_description: "",
        is_else: false,
        order: 0,
      },
      {
        id: 101,
        from_node_title: "A",
        to_node_title: "C",
        conditional_description: "",
        is_else: false,
        order: 1,
      },
    ],
  };
}

function scenario(name: string, nodeTitles: string[], assertions = {}): ScenarioInput {
  return {
    name,
    node_codes: nodeTitles.map((nodeTitle, index) => ({
      node_title: nodeTitle,
      order: index,
      python_code: "pass",
    })),
    turns: [{ text: "hello", expected_replies: 1 }],
    assertions,
  };
}

test("computeCoverage reports partial node and edge coverage", () => {
  const report = computeCoverage(linearSpec(), [scenario("only_a", ["A"])]);

  assert.equal(report.nodes.covered, 1);
  assert.equal(report.nodes.total, 3);
  assert.deepEqual(report.nodes.uncovered, ["B", "C"]);
  assert.equal(report.edges.covered, 0);
  assert.equal(report.edges.total, 2);
  assert.deepEqual(report.edges.uncovered, [
    { from: "A", to: "B" },
    { from: "B", to: "C" },
  ]);
});

test("computeCoverage reports full node and edge coverage across scenarios", () => {
  const report = computeCoverage(linearSpec(), [
    scenario("a_to_b", ["A", "B"]),
    scenario("b_to_c", ["B", "C"]),
  ]);

  assert.equal(report.nodes.covered, 3);
  assert.equal(report.nodes.total, 3);
  assert.deepEqual(report.nodes.uncovered, []);
  assert.equal(report.edges.covered, 2);
  assert.equal(report.edges.total, 2);
  assert.deepEqual(report.edges.uncovered, []);
});

test("computeCoverage edge coverage detects target-node arrival even with single-element node_codes", () => {
  const report = computeCoverage(splitSpec(), [scenario("lands_on_b", ["B"])]);

  assert.equal(report.edges.covered, 1);
  assert.deepEqual(report.edges.uncovered, [{ from: "A", to: "C" }]);
});

test("computeCoverage identifies untaken conditional branches", () => {
  const report = computeCoverage(branchSpec(), [
    scenario("auto_branch", ["A", "B", "C"]),
  ]);

  assert.equal(report.branches.covered, 1);
  assert.equal(report.branches.total, 2);
  assert.deepEqual(report.branches.uncovered, [
    { node: "B", condition: "claim_type is home -> D" },
  ]);
});

test("computeCoverage branch coverage detects target-node arrival even with single-element node_codes", () => {
  const report = computeCoverage(branchSpec(), [scenario("lands_on_c", ["C"])]);

  assert.equal(report.branches.covered, 1);
});

test("computeCoverage reports writable variable coverage from extracted_variables", () => {
  const report = computeCoverage(linearSpec(), [
    scenario("writes_x", ["A"], {
      extracted_variables: { var_x: "value" },
    }),
  ]);

  assert.equal(report.vars_write.covered, 1);
  assert.equal(report.vars_write.total, 2);
  assert.deepEqual(report.vars_write.uncovered, ["var_y"]);
});

test("computeCoverage reports assertion type union and best-effort read coverage", () => {
  const report = computeCoverage(linearSpec(), [
    scenario("semantic_assertion", ["A", "B"], {
      min_responses: 1,
      tts_say: ["Thanks var_x."],
    }),
    scenario("negative_assertion", ["B", "C"], {
      no_response_contains: ["internal"],
      excluded_variables: ["secret"],
    }),
  ]);

  assert.deepEqual(report.assertion_types_used, [
    "excluded_variables",
    "min_responses",
    "no_response_contains",
    "tts_say",
  ]);
  assert.equal(report.vars_read.covered, 1);
  assert.equal(report.vars_read.total, 1);
  assert.deepEqual(report.vars_read.uncovered, []);
});
