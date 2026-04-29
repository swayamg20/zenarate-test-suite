import type { ScenarioInput } from "../validator/schema.ts";
import { validate } from "../validator/index.ts";
import type { NodeContext, AgentSpec } from "../spec/types.ts";

const log = (event: object) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), step: "tools", ...event }));

export interface StagedScenario {
  index: number;
  scenario: ScenarioInput;
  validated: boolean;
  validation_errors: string[];
}

export class GeneratorToolset {
  private staged: StagedScenario[] = [];
  private _finalized = false;

  constructor(
    private ctx: NodeContext,
    private spec: AgentSpec,
  ) {}

  /**
   * Stage a candidate scenario. If a scenario with the same name already exists,
   * it is REPLACED (overwritten) — this lets the LLM fix validation errors
   * without leaving stale entries that block finalize.
   */
  propose_scenario(scenario: unknown): { index: number; replaced?: boolean } {
    const sc = scenario as ScenarioInput;
    const existingIdx = this.staged.findIndex(
      (s) => s.scenario.name === sc.name,
    );

    if (existingIdx >= 0) {
      // Replace existing scenario with same name
      this.staged[existingIdx] = {
        index: existingIdx,
        scenario: sc,
        validated: false,
        validation_errors: [],
      };
      log({ event: "propose_replaced", node: this.ctx.node.title, name: sc.name, index: existingIdx });
      return { index: existingIdx, replaced: true };
    }

    const idx = this.staged.length;
    this.staged.push({
      index: idx,
      scenario: sc,
      validated: false,
      validation_errors: [],
    });
    log({ event: "propose_new", node: this.ctx.node.title, name: sc.name, index: idx });
    return { index: idx };
  }

  validate_scenario(args: { index: number }): { ok: true } | { ok: false; errors: string[] } {
    const slot = this.staged[args.index];
    if (!slot) return { ok: false, errors: [`no scenario at index ${args.index}`] };
    const r = validate(slot.scenario, this.ctx, this.spec);
    slot.validated = r.ok;
    slot.validation_errors = r.errors;

    if (!r.ok) {
      log({
        event: "validation_failed",
        node: this.ctx.node.title,
        name: slot.scenario.name,
        index: args.index,
        errors: r.errors,
      });
    }

    return r.ok ? { ok: true } : { ok: false, errors: r.errors };
  }

  /**
   * Remove a scenario by index. Useful when the LLM can't fix validation errors
   * and wants to discard a scenario to unblock finalize.
   */
  remove_scenario(args: { index: number }): { ok: boolean; error?: string } {
    if (args.index < 0 || args.index >= this.staged.length) {
      return { ok: false, error: `no scenario at index ${args.index}` };
    }
    const name = this.staged[args.index]!.scenario.name;
    this.staged.splice(args.index, 1);
    // Re-index
    this.staged.forEach((s, i) => { s.index = i; });
    log({ event: "removed", node: this.ctx.node.title, name, index: args.index });
    return { ok: true };
  }

  list_proposed(): { scenarios: { index: number; name: string; node_codes: unknown; validated: boolean; errors: string[] }[] } {
    return {
      scenarios: this.staged.map((s) => ({
        index: s.index,
        name: s.scenario.name,
        node_codes: s.scenario.node_codes,
        validated: s.validated,
        errors: s.validation_errors,
      })),
    };
  }

  /**
   * End generation. Returns ONLY validated scenarios.
   * Unvalidated scenarios are dropped with a warning (not a hard error).
   */
  finalize(): { scenarios: ScenarioInput[]; dropped?: string[] } {
    const validated = this.staged.filter((s) => s.validated);
    const unvalidated = this.staged.filter((s) => !s.validated);

    if (unvalidated.length > 0) {
      log({
        event: "finalize_dropped",
        node: this.ctx.node.title,
        dropped: unvalidated.map((s) => s.scenario.name),
      });
    }

    this._finalized = true;
    return {
      scenarios: validated.map((s) => s.scenario),
      ...(unvalidated.length > 0
        ? { dropped: unvalidated.map((s) => s.scenario.name) }
        : {}),
    };
  }

  isFinalized(): boolean {
    return this._finalized;
  }
}
