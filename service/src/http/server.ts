import { Hono } from "hono";
import { serve } from "@hono/node-server";
import "dotenv/config";

import { clientFromEnv } from "../zenarate/factory.ts";
import { loadWorkflow } from "../spec/load.ts";
import { normalize, toNodeContexts } from "../spec/normalize.ts";
import { generateAll } from "../generator/orchestrate.ts";
import { publishSuite } from "../publisher/publish.ts";

const app = new Hono();

app.post("/agents/:wfId/generate-suite", async (c) => {
  const wfId = parseInt(c.req.param("wfId"), 10);
  if (Number.isNaN(wfId)) return c.json({ error: "invalid wfId" }, 400);

  const body = await c.req.json().catch(() => ({}));
  const dryRun = body.dry_run === true;

  const reqId = crypto.randomUUID();
  const t0 = Date.now();
  const log = (event: object) =>
    console.log(JSON.stringify({ ts: new Date().toISOString(), req_id: reqId, ...event }));

  try {
    log({ step: "start", wf_id: wfId, dry_run: dryRun });

    const client = await clientFromEnv();

    log({ step: "load", wf_id: wfId });
    const raw = await loadWorkflow(client, wfId);

    log({ step: "normalize", nodes: raw.nodes.length, edges: raw.edges.length });
    const spec = normalize(raw);

    log({ step: "generate" });
    const { perNode, allScenarios, coverage } = await generateAll(spec, c.req.raw.signal);

    if (dryRun) {
      log({ step: "done", dry_run: true, total_ms: Date.now() - t0 });
      return c.json({ dry_run: true, spec, perNode, scenarios: allScenarios, coverage });
    }

    log({ step: "publish", count: allScenarios.length });
    const result = await publishSuite(client, spec, allScenarios, {
      title: `Generated tests — ${spec.title} (${new Date().toISOString().slice(0, 16)})`,
    });

    log({ step: "done", suite_id: result.suite_id, total_ms: Date.now() - t0 });

    return c.json({
      ...result,
      per_node_summary: perNode.map((r) => ({
        node: r.node,
        generated: r.scenarios.length,
        trivial_count: r.trivial_count,
      })),
      coverage,
      elapsed_ms: Date.now() - t0,
    });
  } catch (e: any) {
    log({ step: "error", message: e.message, stack: e.stack });
    return c.json({ error: e.message }, 500);
  }
});

app.get("/health", (c) => c.json({ status: "ok" }));

const port = parseInt(process.env.PORT ?? "3000", 10);
console.log(`voice-eval listening on :${port}`);
serve({ fetch: app.fetch, port });
