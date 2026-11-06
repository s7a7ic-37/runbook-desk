# Runbook Desk

[Open the demo](https://runbook.artemislab.co.uk/). Live model calls are paused; the review workflow is available through labelled examples and saved cases.

A support-case workspace for drafting an investigation from selected runbooks, checking its sources and reviewing a customer reply before approval.

- Save cases and revisit their draft, model attempts and review history.
- Read the runbooks cited by each observation and proposed check.
- Edit the reply, then approve it or mark it for further investigation. The original and reviewed replies are retained.
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

Backend tests cover budget reservations, concurrent requests, workspace isolation, review conflicts, malformed provider output, citations and failure recovery. HTTP calls are intercepted by a mock transport, including tests configured with a nonzero call limit.

## Boundaries

This is a portfolio demo, not a customer support system. Use fictional cases only. An anonymous HttpOnly cookie isolates each browser workspace for seven days; there is no user login, team access or account recovery. Expired workspaces, case text and reviews are removed when the next new workspace is created. Generation metadata is retained without case/workspace links so cleanup cannot reset the lifetime call allowance. Limits are 20 cases per workspace, 1,000 cases and 2,000 workspaces overall; a public deployment also needs ingress rate limiting and a retention policy.

Structured output and valid citations do not establish factual correctness or prevent prompt injection. A person must inspect the full draft and sources. Approval only records a decision; it does not send the reply. `store:false` requests no Responses API application-state storage; provider retention policies still apply.

For deployment, serve both frontend and API from one HTTPS origin, use a private PostgreSQL database, set `APP_ORIGIN` to that origin and `COOKIE_SECURE=true`. For Supabase, keep the password in `PGPASSWORD` and use a passwordless session-pooler `DATABASE_URL`, `PGSSLMODE=verify-full` and the bundled public CA through `PGSSLROOTCERT`. The Dockerfile builds one service. `render.yaml` keeps that service on the free plan with model calls disabled. `wrangler.jsonc` serves the built frontend on Cloudflare and forwards `/api/*` to the server using `API_ORIGIN`. This keeps the interface visible while the free API service wakes up. Real-provider verification remains pending.
