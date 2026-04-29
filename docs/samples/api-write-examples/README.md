# Write API contract — verified samples

Captured 2026-04-28 by hitting the dashboard with a network hook and running direct probes. Every example here is a real request/response from the Zenarate API, not inferred.

Headers required on **every** authenticated request:

```
Authorization: Token <64-char DRF token>
X-Tenant-Id: <numeric tenant id>      # NOT slug — slug returns "Invalid tenant"
Content-Type: application/json
```

## Endpoints used by the test-generation service

### 1. Create TestSuite

`POST /api/v1/testsuite/suites/` → `201 Created`

**Required:** `title`. Everything else has defaults but should be set.

Request:
```json
{
  "title": "Booking Flow",
  "workflow": 37,
  "channel": "text",
  "mode": "simulation",
  "description": "Generated suite for Test_Swayam (rebuilt)"
}
```

Choices:
- `channel`: `text` | `voice`
- `mode`: `simulation` | `execution`

Response: full Suite object including `id`, timestamps, `polymorphic_ctype`, etc. See `OPTIONS_suites.json` for full schema.

### 2. Create Scenario

`POST /api/v1/testsuite/scenarios/` → `201 Created`

**Required:** `name`, `suite`. The rest is optional but populating `turns`, `assertions`, `node_codes`, `personality`, `initial_state`, `description_long` is what makes it a real test.

Request (canonical agent-bound scenario):
```json
{
  "suite": 37,
  "name": "auth_happy_path_confirmed",
  "description": "Customer confirms identity on first ask",
  "description_long": "# auth_happy_path_confirmed\n\nMarkdown — one paragraph + ASCII diagram of the asserted path.",
  "personality": "Polite, cooperative customer who picks up promptly.",
  "node_codes": [
    { "node_title": "Authentication", "order": 0 }
  ],
  "turns": [
    { "text": "Yes, this is John speaking.", "expected_replies": 1 },
    { "text": "Yes, please go ahead." }
  ],
  "assertions": {
    "min_responses": 2,
    "initial_bot_replies": 1,
    "extracted_variables": { "confirm_first_name": true, "is_authenticated": "true" }
  },
  "initial_state": { "customer_first_name_api": "John" }
}
```

**Important shape notes (verified, NOT inferred):**

- `turns` is `Array<{text: string, expected_replies?: number}>`. NOT a list of bare strings — the dashboard's YAML editor wraps each line into `{text: ...}` before send.
- `assertions` is a free-form JSON object. Typed values work (`min_responses: 2` as int, `is_authenticated: true` as bool). The dashboard sends string-typed values, but the API accepts both.
- `node_codes` is `Array<{node_title: string, order?: number, python_code?: string}>`. NOT a list of node-title strings — that returns `400 "Expected a dictionary, but got str."`. The `python_code` field per node-code suggests custom Python assertions are supported (untested).
- `initial_state` is free-form JSON for pre-set variables.
- `workflow_config` is for platform-level scenarios that bring their own throwaway agent. Leave `null` for agent-bound scenarios.

### 3. Trigger a run

`POST /api/v1/testsuite/suites/<suite_id>/run/` → `202 Accepted`

Returns a Run record with `temporal_workflow_id` and `temporal_link`. No body needed.

**Note:** there is **no single-scenario run endpoint**. `POST /testsuite/scenarios/<id>/run/` returns 404. Always run at the suite level.

### 4. Read results

```
GET /api/v1/testsuite/runs/?suite=<id>          # list runs of a suite
GET /api/v1/testsuite/runs/<run_id>/             # one run, with passed/failed counts
GET /api/v1/testsuite/results/?run=<run_id>      # per-scenario results with full transcript
```

Result objects include `status: passed | failed`, `duration_seconds`, `metric_results` (extensible, currently empty for these tests), and a full `conversation` array (User/Assistant turns).

### 5. Delete

```
DELETE /api/v1/testsuite/suites/<id>/      → 204 No Content   (cascades to scenarios)
DELETE /api/v1/testsuite/scenarios/<id>/   → inferred, untested
```

## Files in this directory

| File | What |
|---|---|
| `OPTIONS_suites.json` | Full DRF metadata for `/testsuite/suites/` (POST schema with required/types/choices) |
| `OPTIONS_scenarios.json` | Same for `/testsuite/scenarios/` — **most important** for the generator |
| `POST_suite_request.json` | Verified request body that creates a suite |
| `POST_scenario_request.json` | Verified request body that creates a scenario in agent-bound shape |
| `POST_scenario_response_typed.json` | Server response confirming all the typed values are preserved |

## Gotchas to bake into the client

1. Always send `X-Tenant-Id` as **numeric**, not slug.
2. `turns` items are objects, not strings.
3. `node_codes` items are objects, not strings.
4. There's no single-scenario run; suite-level only.
5. DELETE is hard-delete (suite is gone), not soft. Use `is_active: false` if you want to keep the record but disable runs.
