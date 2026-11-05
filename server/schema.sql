CREATE SCHEMA IF NOT EXISTS runbook_desk;

CREATE TABLE IF NOT EXISTS runbook_desk.workspaces (
    id uuid PRIMARY KEY,
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days'
);

CREATE TABLE IF NOT EXISTS runbook_desk.cases (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES runbook_desk.workspaces(id),
    title text NOT NULL,
    description text NOT NULL,
    runbook_ids jsonb NOT NULL,
    mode text NOT NULL CHECK (mode IN ('live', 'example')),
    state text NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'generating', 'failed', 'draft', 'approved', 'rejected')),
    draft jsonb,
    reply text NOT NULL DEFAULT '',
    version integer NOT NULL DEFAULT 0,
    active_run_id uuid,
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cases_workspace_created ON runbook_desk.cases(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS runbook_desk.runs (
    id uuid PRIMARY KEY,
    case_id uuid REFERENCES runbook_desk.cases(id) ON DELETE SET NULL,
    workspace_id uuid REFERENCES runbook_desk.workspaces(id) ON DELETE SET NULL,
    state text NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed')),
    model text NOT NULL,
    provider_request_id text,
    input_tokens integer,
    output_tokens integer,
    latency_ms integer,
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS runbook_desk.reviews (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    case_id uuid NOT NULL REFERENCES runbook_desk.cases(id),
    decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
    original_reply text NOT NULL,
    reviewed_reply text NOT NULL,
    note text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
