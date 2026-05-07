import type { AgentSpec, SpecEdge, SpecNode } from "../spec/types.ts";
import type { ScenarioInput } from "../validator/schema.ts";

export type CoverageReport = {
  nodes: { covered: number; total: number; uncovered: string[] };
  edges: {
    covered: number;
    total: number;
    uncovered: { from: string; to: string }[];
  };
  branches: {
    covered: number;
    total: number;
    uncovered: { node: string; condition: string }[];
  };
  vars_write: { covered: number; total: number; uncovered: string[] };
  vars_read: { covered: number; total: number; uncovered: string[] };
  assertion_types_used: string[];
};

type ScenarioPath = {
  titles: string[];
  titleSet: Set<string>;
  edgeKeys: Set<string>;
};

const EDGE_SEPARATOR = "\u0000";

export function computeCoverage(
  spec: AgentSpec,
  scenarios: ScenarioInput[],
): CoverageReport {
  const paths = scenarios.map(scenarioPath);
  const traversedNodes = unionSets(paths.map((path) => path.titleSet));
  const traversedEdges = unionSets(paths.map((path) => path.edgeKeys));
  for (const edge of spec.edges) {
    if (traversedNodes.has(edge.to_node_title)) traversedEdges.add(edgeKey(edge));
  }

  const specNodeTitles = spec.nodes.map((node) => node.title);
  const coveredNodes = specNodeTitles.filter((title) => traversedNodes.has(title));
  const coveredEdges = spec.edges.filter((edge) => traversedEdges.has(edgeKey(edge)));

  const uncoveredNodes = specNodeTitles.filter((title) => !traversedNodes.has(title));
  const uncoveredEdges = spec.edges
    .filter((edge) => !traversedEdges.has(edgeKey(edge)))
    .map((edge) => ({ from: edge.from_node_title, to: edge.to_node_title }));

  const branches = branchEdges(spec);
  const coveredBranches = branches.filter((edge) => traversedEdges.has(edgeKey(edge)));
  const uncoveredBranches = branches
    .filter((edge) => !traversedEdges.has(edgeKey(edge)))
    .map((edge) => ({
      node: edge.from_node_title,
      condition: branchCondition(edge),
    }));

  const writableVars = writableVariableNames(spec);
  const writtenVars = writtenVariableNames(spec, scenarios, paths);
  const coveredWriteVars = writableVars.filter((name) => writtenVars.has(name));
  const uncoveredWriteVars = writableVars.filter((name) => !writtenVars.has(name));

  const readableVars = readableVariableNames(spec);
  const assertedReadVars = assertedVariableMentions(scenarios, readableVars);
  const coveredReadVars = readableVars.filter((name) => assertedReadVars.has(name));
  const uncoveredReadVars = readableVars.filter((name) => !assertedReadVars.has(name));

  return {
    nodes: {
      covered: coveredNodes.length,
      total: specNodeTitles.length,
      uncovered: uncoveredNodes,
    },
    edges: {
      covered: coveredEdges.length,
      total: spec.edges.length,
      uncovered: uncoveredEdges,
    },
    branches: {
      covered: coveredBranches.length,
      total: branches.length,
      uncovered: uncoveredBranches,
    },
    vars_write: {
      covered: coveredWriteVars.length,
      total: writableVars.length,
      uncovered: uncoveredWriteVars,
    },
    vars_read: {
      covered: coveredReadVars.length,
      total: readableVars.length,
      uncovered: uncoveredReadVars,
    },
    assertion_types_used: assertionTypesUsed(scenarios),
  };
}

function scenarioPath(scenario: ScenarioInput): ScenarioPath {
  const titles = (scenario.node_codes ?? [])
    .map((node, index) => ({
      title: node.node_title,
      order: node.order ?? index,
      index,
    }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map((node) => node.title);

  const edgeKeys = new Set<string>();
  for (let index = 0; index < titles.length - 1; index += 1) {
    const from = titles[index];
    const to = titles[index + 1];
    if (from != null && to != null) edgeKeys.add(edgeKey({ from, to }));
  }

  return {
    titles,
    titleSet: new Set(titles),
    edgeKeys,
  };
}

function edgeKey(edge: SpecEdge | { from: string; to: string }): string {
  if ("from_node_title" in edge) {
    return `${edge.from_node_title}${EDGE_SEPARATOR}${edge.to_node_title}`;
  }

  return `${edge.from}${EDGE_SEPARATOR}${edge.to}`;
}

function branchEdges(spec: AgentSpec): SpecEdge[] {
  const bySource = new Map<string, SpecEdge[]>();
  for (const edge of spec.edges) {
    const edges = bySource.get(edge.from_node_title) ?? [];
    edges.push(edge);
    bySource.set(edge.from_node_title, edges);
  }

  return [...bySource.values()]
    .filter((edges) => edges.length > 1 && edges.some(hasBranchCondition))
    .flatMap((edges) => edges);
}

function hasBranchCondition(edge: SpecEdge): boolean {
  return edge.is_else || edge.conditional_description.trim().length > 0;
}

function branchCondition(edge: SpecEdge): string {
  const label = edge.conditional_description.trim() || (edge.is_else ? "else" : "unconditional");
  return `${label} -> ${edge.to_node_title}`;
}

function writableVariableNames(spec: AgentSpec): string[] {
  return uniqueSorted(
    spec.nodes.flatMap((node) =>
      node.variables
        .filter((variable) => isWritableAccessMode(variable.access_mode))
        .map((variable) => variable.name),
    ),
  );
}

function isWritableAccessMode(accessMode: string): boolean {
  return !["read_only", "private"].includes(accessMode);
}

function writtenVariableNames(
  spec: AgentSpec,
  scenarios: ScenarioInput[],
  paths: ScenarioPath[],
): Set<string> {
  const written = new Set<string>();

  for (const scenario of scenarios) {
    for (const name of Object.keys(scenario.assertions?.extracted_variables ?? {})) {
      written.add(name);
    }
  }

  const nodesByTitle = new Map(spec.nodes.map((node) => [node.title, node]));
  for (const path of paths) {
    for (const title of path.titles) {
      const node = nodesByTitle.get(title);
      if (node == null) continue;

      for (const step of node.instruction_steps) {
        if (step.step_type === "set_value" && step.variable_name != null) {
          written.add(step.variable_name);
        }
      }
    }
  }

  return written;
}

function readableVariableNames(spec: AgentSpec): string[] {
  const vars = new Set<string>();
  for (const node of spec.nodes) {
    addJinjaVars(vars, node.prompt);
    addJinjaVars(vars, node.goodbye_message);

    for (const step of node.instruction_steps) {
      if (step.step_type === "speak" || step.step_type === "condition") {
        addJinjaVars(vars, step.content);
        addJinjaVars(vars, step.custom_question);
        addJinjaVars(vars, step.goodbye_message);
        addJinjaVars(vars, step.value);
        addJinjaVars(vars, step.condition_groups);
      }
    }
  }

  return [...vars].sort();
}

function addJinjaVars(vars: Set<string>, value: unknown): void {
  if (value == null) return;

  // Best-effort only: condition_groups is an SDK-specific object and scenarios do
  // not expose response-to-step provenance, so we can detect referenced Jinja
  // names but can only proxy read coverage through semantic assertions.
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const pattern = /{{\s*([A-Za-z_][A-Za-z0-9_.]*)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) != null) {
    const rawName = match[1];
    const rootName = rawName?.split(".")[0];
    if (rootName != null && rootName.length > 0) vars.add(rootName);
  }
}

function assertedVariableMentions(
  scenarios: ScenarioInput[],
  readableVars: string[],
): Set<string> {
  const mentioned = new Set<string>();
  for (const scenario of scenarios) {
    const assertions = scenario.assertions;
    if (assertions == null) continue;

    const assertionText = [
      ...(assertions.tts_say ?? []),
      ...(assertions.any_response_contains ?? []),
    ].join("\n");

    for (const variableName of readableVars) {
      if (assertionText.includes(variableName)) mentioned.add(variableName);
    }
  }

  return mentioned;
}

function assertionTypesUsed(scenarios: ScenarioInput[]): string[] {
  const keys = new Set<string>();
  for (const scenario of scenarios) {
    for (const key of Object.keys(scenario.assertions ?? {})) {
      if (scenario.assertions?.[key] !== undefined) keys.add(key);
    }
  }

  return [...keys].sort();
}

function unionSets(sets: Set<string>[]): Set<string> {
  const result = new Set<string>();
  for (const set of sets) {
    for (const value of set) result.add(value);
  }
  return result;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
