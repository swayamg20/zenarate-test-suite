# AI SDK Migration — Parity Report

**Date:** 2026-05-07
**Workflow:** Insurance Claims (id 46)
**Verdict:** ✅ **PASS**

## Per-node scenario count

| Node | Baseline (Responses API loop) | Post-migration (AI SDK `generateText`) | Δ |
|------|---:|---:|---:|
| ClaimFiled | 0 | 0 | 0 |
| GeneralClaimTransfer | 3 | 3 | 0 |
| HomeClaimDetails | 3 | 3 | 0 |
| AutoClaimDetails | 4 | 4 | 0 |
| ClaimsIntake | 3 | 3 | 0 |
| **Total** | **13** | **13** | **0** |

Threshold was ±2 per node (LLM is non-deterministic at temp 0.3). Actual Δ is **0** across the board — exact match.

## Health checks

| Check | Baseline | Post-migration |
|---|---|---|
| HTTP status | 200 | 200 |
| `failed_scenarios` | 0 | 0 |
| Nodes producing ≥1 scenario | 4/5 | 4/5 |
| Suite published successfully | suite 98 | suite 100 |
| Validator-rejected scenarios | 0 | 0 |
| New error events in logs | — | none |

## Timing

- Baseline: 84,863 ms
- Post-migration: 96,513 ms
- Δ: +11.6 s (+13.7%)

Slightly slower. Possible causes: LLM variance at temp 0.3, AI SDK loop overhead, or `experimental_telemetry` being on. Not concerning — still well under any reasonable timeout.

## Scenario-name diff (informational only — names will vary across runs)

Names differ between runs (LLM is non-deterministic), which is expected. The structural shape (count per node, validator pass rate) is what we check.

Both runs produced scenarios covering: happy paths, branch coverage, private-variable leak checks, natural-language variants, and the explicit branch tests at the entrypoint.

## Conclusion

Migration preserves behavior. No nodes regressed, no scenarios failed validation, no new error types in logs. The structural assertions all hold; the per-node counts came out byte-exact (which is stronger than the ±2 threshold required).

**Cleared to proceed to Step 7 (delete `tool-defs.ts`, remove `openai` package).**
