import { describe, expect, it } from "vitest";

import { buildLaneContexts, walkNode } from "../src/spec/walker.ts";
import type { NodeContext, SpecNode, SpecStep } from "../src/spec/types.ts";

type NodeContextOverrides = Partial<Omit<NodeContext, "node">> & {
  node?: Partial<SpecNode>;
};

function makeStep(overrides: Partial<SpecStep> = {}): SpecStep {
  return {
    id: 0,
    step_type: "speak",
    resourcetype: "speak",
    order: 0,
    ...overrides,
  };
}

function makeSpeak(order: number, content = "Hello", mode = "exact"): SpecStep {
  return makeStep({ order, content, mode });
}

function makeCollect(order: number, variable_name: string): SpecStep {
  return makeStep({
    step_type: "collect",
    resourcetype: "collect",
    order,
    variable_name,
  });
}

function makeSetValue(order: number, variable_name: string, value: string): SpecStep {
  return makeStep({
    step_type: "set_value",
    resourcetype: "set_value",
    order,
    variable_name,
    value,
  });
}

function makeTransfer(order: number): SpecStep {
  return makeStep({
    step_type: "transfer",
    resourcetype: "transfer",
    order,
  });
}

function makeEnd(order: number, goodbye_message = "Goodbye"): SpecStep {
  return makeStep({
    step_type: "end_conversation",
    resourcetype: "end_conversation",
    order,
    goodbye_message,
  });
}

function makeNodeCtx(overrides: NodeContextOverrides = {}): NodeContext {
  const { node: nodeOverrides, ...ctxOverrides } = overrides;
  const node: SpecNode = {
    id: 1,
    title: "TestNode",
    resourcetype: "LLMNode",
    is_entrypoint: true,
    is_end: false,
    block_type: "llm",
    prompt: null,
    instruction_steps: [],
    variables: [],
    ...nodeOverrides,
  };

  return {
    agent: {
      title: "Test Agent",
      bot_name: "Ava",
      system_prompt_excerpt: "Test prompt",
      total_nodes: 1,
    },
    node,
    outgoing: [],
    incoming: [],
    upstream_variables: [],
    ...ctxOverrides,
  };
}

function stepTypes(lane: { steps: SpecStep[] }): string[] {
  return lane.steps.map((step) => step.step_type);
}

function stepVariables(lane: { steps: SpecStep[] }): (string | undefined)[] {
  return lane.steps.map((step) => step.variable_name);
}

function laneAt<T>(lanes: T[], index: number): T {
  const lane = lanes[index];
  if (lane == null) {
    throw new Error(`Expected lane at index ${index}`);
  }
  return lane;
}

describe("walkNode", () => {
  it("returns empty for EndCallNode", () => {
    const ctx = makeNodeCtx({
      node: {
        resourcetype: "EndCallNode",
        instruction_steps: [makeSpeak(1)],
      },
    });

    expect(walkNode(ctx)).toEqual([]);
  });

  it("returns empty for node with no steps", () => {
    const ctx = makeNodeCtx({ node: { instruction_steps: [] } });

    expect(walkNode(ctx)).toEqual([]);
  });

  it("single collect: [speak, collect] with 1 edge -> 1 lane", () => {
    const edge = {
      to_node_title: "Next",
      conditional_description: "",
      is_else: false,
    };
    const ctx = makeNodeCtx({
      node: {
        instruction_steps: [makeSpeak(1), makeCollect(2, "name")],
      },
      outgoing: [edge],
    });

    const lanes = walkNode(ctx);
    const lane = laneAt(lanes, 0);

    expect(lanes).toHaveLength(1);
    expect(lane.steps).toHaveLength(2);
    expect(lane.edge).toEqual(edge);
    expect(lane.test_focus).toBe("collect(name)");
    expect(lane.start_index).toBe(1);
    expect(lane.end_index).toBe(2);
  });

  it("multiple collects no branching: [speak, collect(a), collect(b)] with 1 edge -> 2 lanes", () => {
    const edge = {
      to_node_title: "Next",
      conditional_description: "ready",
      is_else: false,
    };
    const ctx = makeNodeCtx({
      node: {
        instruction_steps: [
          makeSpeak(1),
          makeCollect(2, "a"),
          makeCollect(3, "b"),
        ],
      },
      outgoing: [edge],
    });

    const lanes = walkNode(ctx);
    const firstLane = laneAt(lanes, 0);
    const secondLane = laneAt(lanes, 1);

    expect(lanes).toHaveLength(2);
    expect(stepTypes(firstLane)).toEqual(["speak", "collect"]);
    expect(stepVariables(firstLane)).toEqual([undefined, "a"]);
    expect(firstLane.edge).toBeNull();
    expect(firstLane.test_focus).toBe("collect(a)");
    expect(stepTypes(secondLane)).toEqual(["collect"]);
    expect(stepVariables(secondLane)).toEqual(["b"]);
    expect(secondLane.edge).toEqual(edge);
    expect(secondLane.test_focus).toBe('collect(b) + edge "ready"');
  });

  it("multiple collects + 3 edges: last lane multiplied x 3", () => {
    const autoEdge = {
      to_node_title: "AutoApproved",
      conditional_description: "auto",
      is_else: false,
    };
    const homeEdge = {
      to_node_title: "Home",
      conditional_description: "home",
      is_else: false,
    };
    const elseEdge = {
      to_node_title: "Fallback",
      conditional_description: "",
      is_else: true,
    };
    const ctx = makeNodeCtx({
      node: {
        instruction_steps: [
          makeSpeak(1),
          makeCollect(2, "a"),
          makeCollect(3, "b"),
        ],
      },
      outgoing: [autoEdge, homeEdge, elseEdge],
    });

    const lanes = walkNode(ctx);

    expect(lanes).toHaveLength(4);
    expect(stepTypes(laneAt(lanes, 0))).toEqual(["speak", "collect"]);
    expect(stepVariables(laneAt(lanes, 0))).toEqual([undefined, "a"]);
    expect(laneAt(lanes, 0).edge).toBeNull();

    expect(stepTypes(laneAt(lanes, 1))).toEqual(["collect"]);
    expect(stepVariables(laneAt(lanes, 1))).toEqual(["b"]);
    expect(laneAt(lanes, 1).edge).toEqual(autoEdge);
    expect(laneAt(lanes, 2).edge).toEqual(homeEdge);
    expect(laneAt(lanes, 3).edge).toEqual(elseEdge);
    expect(laneAt(lanes, 1).test_focus).toBe('collect(b) + edge "auto"');
    expect(laneAt(lanes, 2).test_focus).toBe('collect(b) + edge "home"');
    expect(laneAt(lanes, 3).test_focus).toBe("collect(b) + edge else");
  });

  it("ClaimsIntake fixture: 5 lanes", () => {
    const autoEdge = {
      to_node_title: "AutoApproved",
      conditional_description: "auto verified",
      is_else: false,
    };
    const homeEdge = {
      to_node_title: "HomeRepair",
      conditional_description: "home claim",
      is_else: false,
    };
    const elseEdge = {
      to_node_title: "ManualReview",
      conditional_description: "",
      is_else: true,
    };
    const ctx = makeNodeCtx({
      node: {
        title: "ClaimsIntake",
        instruction_steps: [
          makeSpeak(1, "Welcome", "exact"),
          makeCollect(2, "caller_name"),
          makeCollect(3, "policy_number"),
          makeSpeak(4, "Thank you", "flexible"),
          makeSetValue(5, "is_verified", "true"),
          makeSetValue(6, "internal_case_id", "CASE-123"),
          makeCollect(7, "claim_type"),
        ],
      },
      outgoing: [autoEdge, homeEdge, elseEdge],
    });

    const lanes = walkNode(ctx);

    expect(lanes).toHaveLength(5);
    expect(stepTypes(laneAt(lanes, 0))).toEqual(["speak", "collect"]);
    expect(stepVariables(laneAt(lanes, 0))).toEqual([undefined, "caller_name"]);
    expect(laneAt(lanes, 0).test_focus).toBe("collect(caller_name)");
    expect(laneAt(lanes, 0).edge).toBeNull();

    expect(stepTypes(laneAt(lanes, 1))).toEqual(["collect"]);
    expect(stepVariables(laneAt(lanes, 1))).toEqual(["policy_number"]);
    expect(laneAt(lanes, 1).test_focus).toBe("collect(policy_number)");
    expect(laneAt(lanes, 1).edge).toBeNull();

    expect(stepTypes(laneAt(lanes, 2))).toEqual([
      "speak",
      "set_value",
      "set_value",
      "collect",
    ]);
    expect(stepVariables(laneAt(lanes, 2))).toEqual([
      undefined,
      "is_verified",
      "internal_case_id",
      "claim_type",
    ]);
    expect(stepTypes(laneAt(lanes, 3))).toEqual(stepTypes(laneAt(lanes, 2)));
    expect(stepVariables(laneAt(lanes, 3))).toEqual(stepVariables(laneAt(lanes, 2)));
    expect(stepTypes(laneAt(lanes, 4))).toEqual(stepTypes(laneAt(lanes, 2)));
    expect(stepVariables(laneAt(lanes, 4))).toEqual(stepVariables(laneAt(lanes, 2)));
    expect(laneAt(lanes, 2).edge).toEqual(autoEdge);
    expect(laneAt(lanes, 3).edge).toEqual(homeEdge);
    expect(laneAt(lanes, 4).edge).toEqual(elseEdge);
  });

  it("node with only speaks (no seal points) -> 1 lane", () => {
    const ctx = makeNodeCtx({
      node: {
        instruction_steps: [makeSpeak(1), makeSpeak(2)],
      },
    });

    const lanes = walkNode(ctx);
    const lane = laneAt(lanes, 0);

    expect(lanes).toHaveLength(1);
    expect(lane.steps).toHaveLength(2);
    expect(lane.edge).toBeNull();
    expect(lane.test_focus).toBe("passthrough");
  });

  it("transfer step seals a lane", () => {
    const ctx = makeNodeCtx({
      node: {
        instruction_steps: [makeSpeak(1), makeTransfer(2)],
      },
    });

    const lanes = walkNode(ctx);
    const lane = laneAt(lanes, 0);

    expect(lanes).toHaveLength(1);
    expect(stepTypes(lane)).toEqual(["speak", "transfer"]);
    expect(lane.test_focus).toBe("transfer");
  });

  it("end_conversation step seals a lane", () => {
    const ctx = makeNodeCtx({
      node: {
        instruction_steps: [
          makeSpeak(1),
          makeCollect(2, "name"),
          makeEnd(3, "Goodbye"),
        ],
      },
    });

    const lanes = walkNode(ctx);

    expect(lanes).toHaveLength(2);
    expect(stepTypes(laneAt(lanes, 0))).toEqual(["speak", "collect"]);
    expect(stepVariables(laneAt(lanes, 0))).toEqual([undefined, "name"]);
    expect(stepTypes(laneAt(lanes, 1))).toEqual(["end_conversation"]);
    expect(laneAt(lanes, 1).test_focus).toBe("end_conversation");
  });

  it("leftover steps after last seal merged into previous lane", () => {
    const ctx = makeNodeCtx({
      node: {
        instruction_steps: [
          makeSpeak(1),
          makeCollect(2, "name"),
          makeSetValue(3, "flag", "true"),
        ],
      },
    });

    const lanes = walkNode(ctx);
    const lane = laneAt(lanes, 0);

    expect(lanes).toHaveLength(1);
    expect(stepTypes(lane)).toEqual(["speak", "collect", "set_value"]);
    expect(stepVariables(lane)).toEqual([undefined, "name", "flag"]);
    expect(lane.end_index).toBe(3);
  });
});

describe("buildLaneContexts", () => {
  it("wraps lanes with correct index and total", () => {
    const twoLaneCtx = makeNodeCtx({
      node: {
        title: "TwoLaneNode",
        instruction_steps: [
          makeSpeak(1),
          makeCollect(2, "a"),
          makeCollect(3, "b"),
        ],
      },
    });
    const oneLaneCtx = makeNodeCtx({
      node: {
        title: "OneLaneNode",
        instruction_steps: [makeSpeak(1), makeSpeak(2)],
      },
    });

    const laneContexts = buildLaneContexts([twoLaneCtx, oneLaneCtx]);

    expect(laneContexts).toHaveLength(3);
    expect(laneAt(laneContexts, 0).nodeCtx).toBe(twoLaneCtx);
    expect(laneAt(laneContexts, 0).lane_index).toBe(0);
    expect(laneAt(laneContexts, 0).total_lanes).toBe(2);
    expect(laneAt(laneContexts, 1).nodeCtx).toBe(twoLaneCtx);
    expect(laneAt(laneContexts, 1).lane_index).toBe(1);
    expect(laneAt(laneContexts, 1).total_lanes).toBe(2);
    expect(laneAt(laneContexts, 2).nodeCtx).toBe(oneLaneCtx);
    expect(laneAt(laneContexts, 2).lane_index).toBe(0);
    expect(laneAt(laneContexts, 2).total_lanes).toBe(1);
  });
});
