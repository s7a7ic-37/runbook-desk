# Runbook Desk

[Open the demo](https://runbook.artemislab.co.uk/). Live model calls are paused; the review workflow is available through labelled examples and saved cases.

A support-case workspace for drafting an investigation from selected runbooks, checking its sources and reviewing a customer reply before approval.

- Save cases and revisit their draft, model attempts and review history.
- Find saved cases by title without sending the search text to the server; refreshing history keeps the search in place.
- Delete a saved case and its review history from the current workspace when the API advertises deletion support. Older API deployments keep this control hidden.
- Retry an interrupted save with unchanged details to recover the same case, without creating a duplicate.
- Refresh history after a connection interruption to check which cases reached the server without repeating the save.
- Confirm before replacing unsaved case details, runbook choices or review edits.
- Read the runbooks cited by each observation and proposed check.
- Browse the public, fictional runbook library while the case server connects or is unavailable. Case history and review actions require a server connection.
- Edit the reply, then approve it or mark it for further investigation. The original and reviewed replies are retained.
- If a saved draft changes before review, reload it after confirming whether to discard local edits. A rejected stale decision is not repeated automatically.
- Download a reviewed case as a plain-text handoff with its current decision, each review's original and recorded reply snapshots, citations and selected procedures. Example provenance stays visible; no message is sent.
- Try three clearly labelled illustrative examples without calling an AI service.

Python/FastAPI serves a React/TypeScript interface and a REST API. PostgreSQL stores four tables: browser workspaces, cases, generation attempts and reviews. The OpenAI Responses API client requests a structured draft and validates its shape and selected-source references before saving it. The app cannot send messages or execute runbook steps.

## Run locally

Use Python 3.13+, Node 22.12+ and PostgreSQL 16. Create an empty database, then copy `.env.example` to `.env` and set its private `DATABASE_URL`. Keep the API key empty and `MODEL_CALL_LIMIT=0` to use examples only.

```sh
python -m venv .venv
# Activate .venv using your shell's activation command.
pip install -r requirements-dev.txt
uvicorn server.main:app --env-file .env --host 127.0.0.1 --port 8510
```

In another terminal:

```sh
cd frontend
npm ci
npm run dev
```

Open `http://localhost:5173`. For a single-server build, run `npm run build` in `frontend`, set `APP_ORIGIN=http://localhost:8510`, and use the API server's address instead.

Alternatively, set a private, URL-safe `POSTGRES_PASSWORD` in `.env` and run `docker compose up --build`. Open `http://localhost:8000`. Compose deliberately leaves model calls disabled and stores the database in a local volume.

## Model configuration

Live calls are **disabled by default**. To enable them later, configure `OPENAI_API_KEY`, an available structured-output-capable `OPENAI_MODEL`, and `MODEL_CALL_LIMIT` (1–20) in the server environment. Never put a key in the frontend. Set provider billing limits separately.

The call limit counts all reserved attempts across this database, including failures; it is not a currency budget. An additional limit allows three attempts per browser workspace per hour. Reservations happen in a database transaction before an external request. There are no automatic retries. Setting the limit back to zero blocks calls even when a key is configured. The supplied Compose setup requires an explicit configuration change to enable calls.

No paid OpenAI calls have been made or verified for this project. Automated tests simulate provider responses; the examples are authored fixtures, not recorded model output.

## Tests

Create a separate local database named `runbook_desk_test`. Set `TEST_DATABASE_URL` to it; tests refuse non-loopback hosts and names without the `_test` suffix. They clear that database's Runbook Desk tables.

```sh
pytest -q
cd frontend
npm test
npm run build
```

Run `node --test tests/worker.test.mjs` from the repository root to check the Cloudflare API proxy.

From `frontend`, install the test browsers once with `npx playwright install --only-shell chromium webkit`, then run `npm run test:browser`. These production-build checks use synthetic intercepted API responses for navigation guards, edited reviews and the read-only library. CI runs Chromium desktop/mobile and mobile WebKit; the native leave-page warning check is skipped for mobile WebKit, where the event was not emitted.

Backend tests cover budget reservations, concurrent requests, workspace isolation, review conflicts, malformed provider output, citations and failure recovery. HTTP calls are intercepted by a mock transport, including tests configured with a nonzero call limit.

## Boundaries

Requests time out after 90 seconds of active time. The first workspace connection retries once after a non-JSON hosting 429, since a free Render service may need a minute to wake. Case saves and other requests are not automatically retried. A case save can reach the database even when its response is lost or unreadable; the error explains how to recover. While the page remains open, an unchanged failed case or example creation reuses its save key; repeating it returns the existing case's current state, including any later review. Editing the details, choosing another example or explicitly starting a new case starts a separate save. Check history if you changed an interrupted case: the earlier one may already exist. Reloading the page does not retain the pending key or unsaved form.

API clients can provide a UUID `Idempotency-Key` on `POST /api/cases` and `POST /api/examples/{example_id}`. Keys are scoped to the browser workspace and retained with the case. Reusing a key for different validated details or a different creation route returns 409. Requests without a key create a new case as before. Existing databases gain two nullable columns and a unique index during normal schema initialization; existing cases and reviews remain intact.

Reviews are not automatically retried. If a review is interrupted, check case history before repeating it: the server may still have completed the request.

The brand link and in-app case changes use an explicit discard guard. Browser-level exit warnings are best-effort and are unreliable on some mobile browsers or if the browser process is killed; save a case before leaving. Unsaved text is not automatically persisted.

This is a portfolio demo, not a customer support system. Use fictional cases only. An anonymous HttpOnly cookie isolates each browser workspace for seven days; there is no user login, team access or account recovery. Expired workspaces, case text and reviews are removed when the next new workspace is created. Deleting a case removes its case and review text immediately; model-attempt records remain to enforce the call limit. Expiry detaches those records from case and workspace so cleanup cannot reset the lifetime allowance. Limits are 20 cases per workspace, 1,000 cases and 2,000 workspaces overall; a public deployment also needs ingress rate limiting and a retention policy.

Structured output and valid citations do not establish factual correctness or prevent prompt injection. A person must inspect the full draft and sources. Approval only records a decision; it does not send the reply. `store:false` requests no Responses API application-state storage; provider retention policies still apply.

Case, review and structured-draft text reject null characters before storage. Invalid review input preserves the saved draft; invalid provider text records a failed attempt without saving a draft.

For deployment, serve both frontend and API from one HTTPS origin, use a private PostgreSQL database, set `APP_ORIGIN` to that origin and `COOKIE_SECURE=true`. For Supabase, keep the password in `PGPASSWORD` and use a passwordless session-pooler `DATABASE_URL`, `PGSSLMODE=verify-full` and the bundled public CA through `PGSSLROOTCERT`. The Dockerfile builds one service. `render.yaml` keeps that service on the free plan with model calls disabled. `wrangler.jsonc` serves the built frontend on Cloudflare and forwards `/api/*` to the server using `API_ORIGIN`. This keeps the interface visible while the free API service wakes up. Real-provider verification remains pending.
