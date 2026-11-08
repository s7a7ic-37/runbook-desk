import type { Case, Runbook } from "./types";

export function caseReport(record: Case, runbooks: Runbook[]): string {
  if (!record.draft || !record.reviews.length ||
      !["approved", "rejected"].includes(record.state)) {
    throw new Error("Record a review before downloading a case handoff.");
  }
  const sourceName = (id: string) => id === "incident"
    ? "Case details"
    : runbooks.find((book) => book.id === id)?.title || `Unavailable source (${id})`;
  const decision = record.state === "approved" ? "Approved" : "Needs investigation";
  const lines = [
    "RUNBOOK DESK — CASE HANDOFF", "",
    record.title,
    `Case: ${record.id} · saved version ${record.version}`,
    `Decision: ${decision}`,
    record.mode === "example"
      ? "Worked example: illustrative draft, not an OpenAI response."
      : "Mode: live case",
    "This app does not send customer messages or execute proposed checks.",
    "", "CASE DETAILS", record.description,
    "", "INVESTIGATION", record.draft.summary,
    `Suggested priority: ${record.draft.priority}`,
    "", "OBSERVATIONS",
    ...record.draft.observations.map((item) => `- ${item.statement}\n  Source: ${sourceName(item.source_id)}`),
    "", "PROPOSED CHECKS",
    ...record.draft.checks.map((item, index) =>
      `${index + 1}. ${item.action}\n   Reason: ${item.reason}\n   Sources: ${item.source_ids.map(sourceName).join("; ")}`),
    "", "STILL TO ESTABLISH",
    ...record.draft.missing_information.map((item) => `- ${item}`),
    "", "ORIGINAL DRAFT REPLY", record.draft.customer_reply,
    "", "RECORDED REPLY", record.reply,
    "", "REVIEW TRAIL",
    ...record.reviews.map((entry, index) => [
      `Review ${index + 1} · ${entry.created_at}`,
      `Decision: ${entry.decision === "approved" ? "Approved" : "Needs investigation"}`,
      `Note: ${entry.note}`,
      "REPLY BEFORE THIS REVIEW", entry.original_reply,
      "REPLY RECORDED BY THIS REVIEW", entry.reviewed_reply, "",
    ].join("\n")),
    "", "SELECTED RUNBOOKS — CURRENT LIBRARY SNAPSHOT",
  ];
  for (const id of record.runbook_ids) {
    const book = runbooks.find((item) => item.id === id);
    lines.push("", sourceName(id));
    if (book) lines.push(`Source: ${book.id} · updated ${book.updated}`, book.body);
    else lines.push("The current library does not contain this procedure. Check the saved case before relying on it.");
  }
  return lines.join("\n") + "\n";
}
