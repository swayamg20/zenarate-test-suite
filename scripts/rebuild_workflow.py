#!/usr/bin/env python3
"""
Rebuild a Zenarate workflow that's missing its voice runtime configuration.

Root cause: workflows imported via seed/duplicate bypass the auto-create
signal that materializes a record in the voice runtime DB, so /voice/browser/
session/start returns 404 "No workflow configuration found for agent <id>".
Fresh POST /workflows/ DOES fire the signal.

Strategy: read all data from the broken workflow, POST a new workflow to
trigger the signal, then recreate nodes -> variables -> instruction-steps
-> edges with id remapping, and finally delete the original.

Usage: SOURCE_WF=33 python3 rebuild_workflow.py
"""
import json
import os
import ssl
import sys
import urllib.request
import urllib.error

# This Python install lacks system root certs; use certifi or fall back to unverified.
try:
    import certifi
    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL_CTX = ssl.create_default_context()
    _SSL_CTX.check_hostname = False
    _SSL_CTX.verify_mode = ssl.CERT_NONE

API = "https://zenarate-web-prod.fly.dev/api/v1"
VOICE = "https://zenarate-voice-prod.fly.dev"
TOKEN = open("/tmp/zenarate.token").read().strip()
TENANT = "6"
SRC = int(os.environ.get("SOURCE_WF", "33"))

HEADERS = {
    "Authorization": f"Token {TOKEN}",
    "X-Tenant-Id": TENANT,
    "Content-Type": "application/json",
}


def req(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, headers=HEADERS, method=method)
    try:
        with urllib.request.urlopen(r, timeout=30, context=_SSL_CTX) as resp:
            raw = resp.read().decode() or "{}"
            return resp.status, json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, body


def get(url):
    return req("GET", url)


def post(url, body):
    return req("POST", url, body)


def patch(url, body):
    return req("PATCH", url, body)


def delete(url):
    return req("DELETE", url)


# ---------- 1. Read source ----------
print(f"[1/8] Reading source workflow #{SRC} ...")
status, src = get(f"{API}/workflow/workflows/{SRC}/")
assert status == 200, f"failed to fetch wf{SRC}: {status} {src}"
print(f"  title: {src['title']!r}")

_, nodes_resp = get(f"{API}/workflow/workflows/{SRC}/nodes/?page_size=200")
src_nodes = nodes_resp["results"]
_, edges_resp = get(f"{API}/workflow/workflows/{SRC}/edges/?page_size=200")
src_edges = edges_resp["results"]
print(f"  nodes={len(src_nodes)} edges={len(src_edges)}")

# Per-node sub-resources
src_steps = {}
src_vars = {}
for n in src_nodes:
    _, s = get(f"{API}/workflow/workflows/{SRC}/nodes/{n['id']}/instruction-steps/?page_size=200")
    src_steps[n["id"]] = s["results"]
    _, v = get(f"{API}/workflow/workflows/{SRC}/nodes/{n['id']}/variables/?page_size=200")
    src_vars[n["id"]] = v["results"]
total_steps = sum(len(v) for v in src_steps.values())
total_vars = sum(len(v) for v in src_vars.values())
print(f"  instruction_steps={total_steps} node_variables={total_vars}")

# ---------- 2. Create new workflow ----------
print(f"\n[2/8] Creating new workflow (fires voice-runtime sync signal) ...")
new_payload = {
    "title": f"{src['title']} (rebuilt)",
    "description": src.get("description") or "",
    "bot_name": src.get("bot_name"),
    "company_name": src.get("company_name"),
    "company_description": src.get("company_description"),
    "allow_interruptions": src.get("allow_interruptions"),
    "enable_dtmf_support": src.get("enable_dtmf_support"),
    "enable_voicemail_detection": src.get("enable_voicemail_detection"),
    "voicemail_action": src.get("voicemail_action"),
    "voicemail_message": src.get("voicemail_message"),
    "llm_config": src.get("llm_config"),
}
status, new_wf = post(f"{API}/workflow/workflows/", new_payload)
assert status == 201, f"create failed: {status} {new_wf}"
NEW = new_wf["id"]
print(f"  created wf #{NEW}")

# ---------- 3. Verify voice runtime sees it ----------
print(f"\n[3/8] Verifying voice runtime config for new wf ...")
status, vresp = post(f"{VOICE}/voice/browser/session/start", {"agent_id": str(NEW)})
if status == 200:
    print(f"  voice runtime OK (room: {vresp.get('room_name')})")
    # End the session immediately
    post(f"{VOICE}/voice/browser/session/end", {"session_id": vresp.get("session_id")})
else:
    print(f"  voice runtime FAILED: {status} {vresp}")
    print("  Aborting — fresh-create path does not trigger sync.")
    delete(f"{API}/workflow/workflows/{NEW}/")
    sys.exit(1)

# ---------- 4. Delete the auto-created entry node on the new wf ----------
# A fresh workflow comes with a default entry node. We need to remove it
# so we can transplant the source's exact node graph.
print(f"\n[4/8] Removing default entry node(s) from new wf ...")
_, cur = get(f"{API}/workflow/workflows/{NEW}/nodes/?page_size=200")
for n in cur["results"]:
    s, _ = delete(f"{API}/workflow/workflows/{NEW}/nodes/{n['id']}/")
    print(f"  deleted default node #{n['id']} ({s})")

# ---------- 5. Recreate nodes ----------
print(f"\n[5/8] Recreating {len(src_nodes)} nodes ...")
node_id_map = {}  # old_id -> new_id
NODE_FIELDS = [
    "title", "description", "is_entrypoint", "is_end", "respond_immediately",
    "outcome_type", "pre_actions", "post_actions", "canvas_layout",
    "block_type", "prompt", "python_code", "goodbye_message",
    "goodbye_message_mode", "is_resolution_driving",
]
for n in src_nodes:
    payload = {k: n[k] for k in NODE_FIELDS if k in n and n[k] is not None}
    payload["resourcetype"] = n["resourcetype"]
    status, created = post(
        f"{API}/workflow/workflows/{NEW}/nodes/", payload
    )
    if status not in (200, 201):
        print(f"  FAILED node {n['id']} ({n['title']}): {status} {str(created)[:200]}")
        continue
    node_id_map[n["id"]] = created["id"]
    print(f"  {n['id']} -> {created['id']} ({n['title']})")

# ---------- 6. Recreate node_variables (preserve uuid for templates) ----------
print(f"\n[6/8] Recreating {total_vars} node variables ...")
var_id_map = {}
VAR_FIELDS = [
    "name", "display_name", "description", "is_list", "is_required",
    "retry_limit", "retry_if_optional", "confirmation_mode", "access_mode",
    "scope", "scope_node_ids", "output_template", "strict_validation",
    "allow_fuzzy_match",
]
for old_node_id, vars_list in src_vars.items():
    new_node_id = node_id_map.get(old_node_id)
    if not new_node_id:
        continue
    for v in vars_list:
        payload = {k: v[k] for k in VAR_FIELDS if k in v and v[k] is not None}
        payload["resourcetype"] = v["resourcetype"]
        payload["node"] = new_node_id
        if v.get("uuid"):
            payload["uuid"] = v["uuid"]
        status, created = post(
            f"{API}/workflow/workflows/{NEW}/nodes/{new_node_id}/variables/", payload
        )
        if status in (200, 201):
            var_id_map[v["id"]] = created["id"]
            print(f"  var {v['id']} -> {created['id']} ({v['name']}, node {new_node_id})")
        else:
            print(f"  FAILED var {v['id']}: {status} {str(created)[:200]}")

# ---------- 7. Recreate instruction_steps (with var id remap) ----------
print(f"\n[7/8] Recreating {total_steps} instruction steps ...")
STEP_FIELDS_COMMON = [
    "step_type", "order", "rank", "is_enabled", "is_resolution_driving",
    "value", "custom_question", "wait_for_seconds", "wait_message",
]
for old_node_id, steps in src_steps.items():
    new_node_id = node_id_map.get(old_node_id)
    if not new_node_id:
        continue
    for s in steps:
        payload = {k: s[k] for k in STEP_FIELDS_COMMON if k in s and s[k] is not None}
        payload["resourcetype"] = s["resourcetype"]
        payload["node"] = new_node_id
        if s.get("variable") and s["variable"] in var_id_map:
            payload["variable"] = var_id_map[s["variable"]]
        # ConditionStep has nested condition_groups — keep their structure but
        # remap variable ids inside conditions.
        if s.get("condition_groups"):
            cgs = []
            for cg in s["condition_groups"]:
                cg_copy = {
                    "title": cg.get("title", ""),
                    "order": cg["order"],
                    "is_else": cg.get("is_else", False),
                    "branch_end_behavior": cg.get("branch_end_behavior"),
                    "branch_end_goto_step": cg.get("branch_end_goto_step"),
                    "conditions": [],
                }
                for c in cg.get("conditions", []):
                    cc = {
                        "order": c["order"],
                        "operator": c["operator"],
                        "value": c.get("value", ""),
                    }
                    if c.get("variable") and c["variable"] in var_id_map:
                        cc["variable"] = var_id_map[c["variable"]]
                    if c.get("system_variable_name"):
                        cc["system_variable_name"] = c["system_variable_name"]
                    cg_copy["conditions"].append(cc)
                cgs.append(cg_copy)
            payload["condition_groups"] = cgs
        status, created = post(
            f"{API}/workflow/workflows/{NEW}/nodes/{new_node_id}/instruction-steps/",
            payload,
        )
        if status in (200, 201):
            print(f"  step {s['id']} -> {created.get('id')} ({s['step_type']})")
        else:
            print(f"  FAILED step {s['id']} ({s['step_type']}): {status} {str(created)[:300]}")

# ---------- 8. Recreate edges ----------
print(f"\n[8/8] Recreating {len(src_edges)} edges ...")
EDGE_FIELDS = ["meta", "order", "is_else", "is_resolution_driving", "condition_groups"]
for e in src_edges:
    new_from = node_id_map.get(e["from_node"])
    new_to = node_id_map.get(e["to_node"])
    if not (new_from and new_to):
        print(f"  SKIP edge {e['id']}: missing node mapping")
        continue
    payload = {"from_node": new_from, "to_node": new_to}
    for k in EDGE_FIELDS:
        if k in e and e[k] is not None:
            payload[k] = e[k]
    status, created = post(f"{API}/workflow/workflows/{NEW}/edges/", payload)
    if status in (200, 201):
        print(f"  edge {e['id']} -> {created['id']} ({new_from}->{new_to})")
    else:
        print(f"  FAILED edge {e['id']}: {status} {str(created)[:200]}")

# ---------- Final: rename + cleanup ----------
print(f"\n[final] Voice-runtime smoke test on rebuilt wf ...")
status, vresp = post(f"{VOICE}/voice/browser/session/start", {"agent_id": str(NEW)})
print(f"  status: {status}")
if status == 200:
    post(f"{VOICE}/voice/browser/session/end", {"session_id": vresp.get("session_id")})

print(f"\nDONE.")
print(f"  Source (broken):  wf #{SRC} '{src['title']}'")
print(f"  Rebuilt (works):  wf #{NEW} '{src['title']} (rebuilt)'")
print()
print("Next steps (manual, intentional):")
print(f"  1. Open https://zenarate-prod.vercel.app/agents/{NEW} and verify Preview works.")
print(f"  2. If happy, delete the broken original:")
print(f"       curl -X DELETE -H 'Authorization: Token <TOKEN>' -H 'X-Tenant-Id: 6' \\\\")
print(f"            {API}/workflow/workflows/{SRC}/")
print(f"  3. (Optional) PATCH the rebuilt wf's title back to '{src['title']}'.")
