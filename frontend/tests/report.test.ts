import assert from "node:assert/strict";
import test from "node:test";
import { caseReport } from "../src/report.ts";
import type { Case, Runbook } from "../src/types.ts";

const runbooks: Runbook[] = [{
  id: "rb-retries", title: "Webhook retries", category: "Delivery",
  updated: "2026-11-01", body: "Compare event IDs. Never request signing secrets.",
}];
const record: Case = {
  id: "synthetic-case", title: "Duplicate fulfilment tasks — Łódź",
  state: "rejected", mode: "example", version: 2,
  description: "Two deliveries share one event ID. The cause is still unknown.",
  runbook_ids: ["rb-retries"], reply: "Please provide redacted event timings for investigation.",
  created_at: "2026-11-07T16:00:00Z", updated_at: "2026-11-07T16:05:00Z", error_code: null,
  draft: {
    summary: "Repeated delivery is reported; processing has not been checked.", priority: "medium",
    observations: [{statement: "The same event ID was reported twice.", source_id: "incident"}],
    checks: [{action: "Compare redacted delivery timings.", reason: "Separate delivery from processing.", source_ids: ["rb-retries"]}],
    missing_information: ["Does the receiver deduplicate events?"],
    customer_reply: "Original draft reply before human review.",
  },
  reviews: [{decision: "rejected", original_reply: "Original draft reply before human review.",
    reviewed_reply: "Please provide redacted event timings for investigation.",
    note: "Need evidence before identifying a cause.", created_at: "2026-11-07T16:05:00Z"}],
  runs: [{state: "failed", model: "not-for-the-handoff", input_tokens: null, output_tokens: null,
    latency_ms: null, created_at: "2026-11-07T16:00:00Z"}],
};

test("handoff retains the reviewed decision, original reply, citations and example provenance", () => {
  const before = structuredClone(record);
  const report = caseReport(record, runbooks);
  for (const text of [record.title, "Decision: Needs investigation", "not an OpenAI response",
    "saved version 2", "Source: Case details", "Sources: Webhook retries", runbooks[0].body,
    "ORIGINAL DRAFT REPLY\n" + record.draft!.customer_reply,
    "RECORDED REPLY\n" + record.reply, record.reviews[0].note]) assert.ok(report.includes(text), text);
  assert.doesNotMatch(report, /not-for-the-handoff|input_tokens|latency_ms/);
  assert.deepEqual(record, before);
  assert.match(caseReport({...record, state: "approved", mode: "live", reviews: [{...record.reviews[0], decision: "approved"}]}, runbooks), /Decision: Approved\nMode: live case/);
});

test("handoff refuses an unreviewed draft and explicitly marks missing procedures", () => {
  assert.throws(() => caseReport({...record, state: "draft", reviews: []}, runbooks), /Record a review/);
  assert.throws(() => caseReport({...record, draft: null}, runbooks), /Record a review/);
  const report = caseReport(record, []);
  assert.match(report, /Unavailable source \(rb-retries\)/);
  assert.match(report, /current library does not contain this procedure/);
});

test("handoff retains each decision's reply snapshots in review order", () => {
  const first = {...record.reviews[0], original_reply: "Earlier draft — Łódź.",
    reviewed_reply: "First recorded reply.", note: "First decision note."};
  const second = {...record.reviews[0], decision: "approved", original_reply: "Later regenerated draft.",
    reviewed_reply: "Final recorded reply.", note: "Second decision note.", created_at: "2026-11-07T17:00:00Z"};
  const reviewed = {...record, state: "approved" as const, reply: second.reviewed_reply, reviews: [first, second]};
  const before = structuredClone(reviewed);
  const report = caseReport(reviewed, runbooks);
  for (const [index, entry] of reviewed.reviews.entries()) {
    assert.ok(report.includes(`Review ${index + 1} · ${entry.created_at}`));
    assert.ok(report.includes("REPLY BEFORE THIS REVIEW\n" + entry.original_reply));
    assert.ok(report.includes("REPLY RECORDED BY THIS REVIEW\n" + entry.reviewed_reply));
    assert.ok(report.includes(entry.note));
  }
  assert.ok(report.indexOf("Review 1 ·") < report.indexOf("Review 2 ·"));
  assert.deepEqual(reviewed, before);
});
