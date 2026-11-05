export type Runbook = { id: string; title: string; category: string; updated: string; body: string };
export type CaseState = 'new' | 'generating' | 'failed' | 'draft' | 'approved' | 'rejected';
export type CaseSummary = { id: string; title: string; state: CaseState; mode: 'live' | 'example'; updated_at: string };
export type Draft = {
  summary: string; priority: 'low' | 'medium' | 'high';
  observations: { statement: string; source_id: string }[];
  checks: { action: string; reason: string; source_ids: string[] }[];
  missing_information: string[]; customer_reply: string;
};
export type Case = CaseSummary & {
  description: string; runbook_ids: string[]; draft: Draft | null; reply: string;
  version: number; created_at: string; error_code: string | null;
  reviews: { decision: string; original_reply: string; reviewed_reply: string; note: string; created_at: string }[];
  runs: { state: string; model: string; input_tokens: number | null; output_tokens: number | null; latency_ms: number | null; created_at: string }[];
};
export type Config = {
  live_enabled: boolean; calls_remaining: number; runbooks: Runbook[];
  examples: { id: string; title: string; description: string; runbook_ids: string[] }[];
};
