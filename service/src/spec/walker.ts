import type { SpecStep, NodeContext } from "./types.ts";

export type { SpecStep, NodeContext } from "./types.ts";

export interface SwimlaneEdge {
  to_node_title: string;
  conditional_description: string;
  is_else: boolean;
}

export interface Swimlane {
  id: string;
  node_title: string;
  steps: SpecStep[];
  start_index: number;
  end_index: number;
  edge: SwimlaneEdge | null;
  test_focus: string;
}

export interface LaneContext {
  nodeCtx: NodeContext;
  lane: Swimlane;
  total_lanes: number;
  lane_index: number;
}

interface IndexedStep {
  step: SpecStep;
  /** The step's order value (from instruction_steps) */
  order: number;
}

const SEALING_STEP_TYPES = new Set(["collect", "transfer", "end_conversation"]);

export function walkNode(ctx: NodeContext): Swimlane[] {
  if (ctx.node.resourcetype === "EndCallNode" || ctx.node.instruction_steps.length === 0) {
    return [];
  }

  const sortedSteps = ctx.node.instruction_steps
    .map((step, originalIndex) => ({ step, originalIndex }))
    .sort((a, b) => {
      const orderDiff = a.step.order - b.step.order;
      if (orderDiff !== 0) return orderDiff;

      return a.originalIndex - b.originalIndex;
    })
    .map(({ step }) => ({ step, order: step.order }));

  const lanes: Swimlane[] = [];
  let buffer: IndexedStep[] = [];

  for (const indexedStep of sortedSteps) {
    buffer.push(indexedStep);

    if (isSealingStep(indexedStep.step)) {
      const lane = indexedStepsToLane(ctx.node.title, lanes.length, buffer, null);
      if (lane) {
        lanes.push(lane);
      }
      buffer = [];
    }
  }

  if (buffer.length > 0) {
    if (lanes.length > 0) {
      const previousLane = lanes[lanes.length - 1];
      if (previousLane) {
        lanes[lanes.length - 1] = mergeLaneSteps(previousLane, buffer);
      }
    } else {
      const lane = indexedStepsToLane(ctx.node.title, lanes.length, buffer, null);
      if (lane) {
        lanes.push(lane);
      }
    }
  }

  return applyOutgoingEdges(lanes, ctx.outgoing);
}

export function buildLaneContexts(contexts: NodeContext[]): LaneContext[] {
  return contexts.flatMap((nodeCtx) => {
    const lanes = walkNode(nodeCtx);
    const total_lanes = lanes.length;

    return lanes.map((lane, lane_index) => ({
      nodeCtx,
      lane,
      total_lanes,
      lane_index,
    }));
  });
}

function isSealingStep(step: SpecStep): boolean {
  return SEALING_STEP_TYPES.has(step.step_type);
}

function indexedStepsToLane(
  nodeTitle: string,
  laneIndex: number,
  indexedSteps: IndexedStep[],
  edge: SwimlaneEdge | null,
): Swimlane | null {
  const firstStep = indexedSteps[0];
  const lastStep = indexedSteps[indexedSteps.length - 1];
  if (!firstStep || !lastStep) {
    return null;
  }

  const steps = indexedSteps.map(({ step }) => step);

  return {
    id: laneId(nodeTitle, laneIndex),
    node_title: nodeTitle,
    steps,
    start_index: firstStep.order,
    end_index: lastStep.order,
    edge,
    test_focus: testFocus(lastStep.step, edge),
  };
}

function mergeLaneSteps(lane: Swimlane, indexedSteps: IndexedStep[]): Swimlane {
  const lastStep = indexedSteps[indexedSteps.length - 1];
  if (!lastStep) {
    return lane;
  }

  const steps = [...lane.steps, ...indexedSteps.map(({ step }) => step)];

  return {
    ...lane,
    steps,
    end_index: lastStep.order,
    test_focus: testFocus(lastStep.step, lane.edge),
  };
}

function applyOutgoingEdges(lanes: Swimlane[], outgoing: SwimlaneEdge[]): Swimlane[] {
  if (lanes.length === 0) {
    return [];
  }

  const lastLaneIndex = lanes.length - 1;
  const lastLane = lanes[lastLaneIndex];
  if (!lastLane) {
    return [];
  }

  if (outgoing.length === 0) {
    return lanes.map((lane) => withEdge(lane, null));
  }

  if (outgoing.length === 1) {
    const edge = outgoing[0];
    if (!edge) {
      return lanes.map((lane) => withEdge(lane, null));
    }

    return lanes.map((lane, index) =>
      index === lastLaneIndex ? withEdge(lane, cloneEdge(edge)) : lane,
    );
  }

  const prefix = lanes.slice(0, lastLaneIndex);
  const multiplied = outgoing.map((edge, index) =>
    withEdge(lastLane, cloneEdge(edge), prefix.length + index),
  );

  return [...prefix, ...multiplied];
}

function withEdge(lane: Swimlane, edge: SwimlaneEdge | null, laneIndex?: number): Swimlane {
  const terminalStep = lane.steps[lane.steps.length - 1];

  return {
    ...lane,
    ...(laneIndex == null ? {} : { id: laneId(lane.node_title, laneIndex) }),
    edge,
    test_focus: terminalStep ? testFocus(terminalStep, edge) : lane.test_focus,
  };
}

function cloneEdge(edge: SwimlaneEdge): SwimlaneEdge {
  return {
    to_node_title: edge.to_node_title,
    conditional_description: edge.conditional_description,
    is_else: edge.is_else,
  };
}

function testFocus(terminalStep: SpecStep, edge: SwimlaneEdge | null): string {
  let focus: string;
  switch (terminalStep.step_type) {
    case "collect":
      focus = `collect(${terminalStep.variable_name ?? "unknown"})`;
      break;
    case "transfer":
      focus = "transfer";
      break;
    case "end_conversation":
      focus = "end_conversation";
      break;
    default:
      focus = "passthrough";
      break;
  }

  if (!edge) {
    return focus;
  }

  if (edge.is_else) {
    return `${focus} + edge else`;
  }

  const desc = edge.conditional_description.trim();
  return desc.length > 0 ? `${focus} + edge "${desc}"` : focus;
}

function laneId(nodeTitle: string, laneIndex: number): string {
  return `${nodeTitle}::lane_${laneIndex}`;
}
