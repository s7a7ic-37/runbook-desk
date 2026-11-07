import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const runbooks = JSON.parse(readFileSync(new URL("../../../server/runbooks.json", import.meta.url)));
const examples = JSON.parse(readFileSync(new URL("../../../server/examples.json", import.meta.url)));
const example = examples[0];

test.beforeEach(async ({ context }) => {
  const cases = [];
  await context.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/workspace") return route.fulfill({ json: { ready: true } });
    if (path === "/api/config") return route.fulfill({ json: { live_enabled: false, calls_remaining: 0, runbooks, examples } });
    if (path === "/api/cases") return route.fulfill({ json: cases });
    if (path === "/api/examples/" + example.id) {
      const record = { ...example, id: "synthetic-case", mode: "example", state: "draft", version: 1,
        reply: example.draft.customer_reply, reviews: [], runs: [], created_at: "2026-01-01T12:00:00Z", updated_at: "2026-01-01T12:00:00Z" };
      cases.push(record);
      return route.fulfill({ json: record });
    }
    throw new Error("Unexpected synthetic API request: " + path);
  });
  await context.route("https://portfolio.artemislab.co.uk/**", route => route.fulfill({ body: "Projects placeholder" }));
});

test("brand navigation protects case edits and permits an explicit reset", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Case title", { exact: true }).fill("Unsaved fictional case");
  let discard = false;
  const prompts = [];
  page.on("dialog", async dialog => { prompts.push(dialog.type()); await (discard ? dialog.accept() : dialog.dismiss()); });
  await page.getByRole("link", { name: "Runbook Desk home", exact: true }).click();
  await expect(page.getByLabel("Case title", { exact: true })).toHaveValue("Unsaved fictional case");
  expect(prompts).toEqual(["confirm"]);
  discard = true;
  await page.getByRole("link", { name: "Runbook Desk home", exact: true }).click();
  await expect(page.getByLabel("Case title", { exact: true })).toHaveValue("");
  const count = prompts.length;
  await page.getByRole("link", { name: "Runbook Desk home", exact: true }).click();
  expect(prompts).toHaveLength(count);
});

test("brand navigation cannot reset a case while its save is in flight", async ({ page }) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route("**/api/cases", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    await pending;
    const input = route.request().postDataJSON();
    return route.fulfill({ json: { ...input, id: "synthetic-save", state: "new", mode: "live",
      version: 1, reply: "", draft: null, reviews: [], runs: [], created_at: "2026-01-01T12:00:00Z", updated_at: "2026-01-01T12:00:00Z" } });
  });
  await page.goto("/");
  const title = page.getByLabel("Case title", { exact: true });
  await title.fill("Fictional pending save");
  await page.locator("#case-description").fill("Fictional incident details for a deliberately delayed save response.");
  const prompts = [];
  page.on("dialog", async dialog => { prompts.push(dialog.type()); await dialog.accept(); });
  try {
    await page.getByRole("button", { name: "Save case", exact: true }).click();
    await expect(title).toBeDisabled();
    await page.getByRole("link", { name: "Runbook Desk home", exact: true }).click();
    await expect(title).toHaveValue("Fictional pending save");
    expect(prompts).toEqual([]);
  } finally { release(); }
  await expect(page.getByRole("heading", { name: "Fictional pending save", exact: true })).toBeVisible();
});

test("supported browser navigation warns only while case edits are unsaved", async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "Mobile WebKit did not emit beforeunload in verified emulation; native exit warnings are best-effort.");
  await page.goto("/");
  await page.getByLabel("Case title", { exact: true }).fill("Unsaved fictional case");
  const dismissed = page.waitForEvent("dialog", { timeout: 5000 }).then(async dialog => {
    expect(dialog.type()).toBe("beforeunload");
    await dialog.dismiss();
  });
  await Promise.all([dismissed, page.getByRole("link", { name: "← All projects", exact: true }).click()]);
  await expect(page.getByLabel("Case title", { exact: true })).toHaveValue("Unsaved fictional case");
  await page.getByLabel("Case title", { exact: true }).fill("");
  await page.getByRole("link", { name: "← All projects", exact: true }).click();
  await expect(page.getByText("Projects placeholder", { exact: true })).toBeVisible();
});

test("edited reviews keep the existing discard guard", async ({ page }) => {
  await page.goto("/");
  const picker = page.locator("#mobile-example");
  await page.getByRole("button", { name: "Save case", exact: true }).waitFor();
  if (await picker.isVisible()) await picker.selectOption(example.id);
  else await page.locator(".example-link").filter({ hasText: example.title }).click();
  const reply = page.getByRole("textbox", { name: "Review the customer reply", exact: true });
  await reply.fill("This is an unsaved fictional review edit.");
  page.on("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "＋ New case", exact: true }).click();
  await expect(reply).toHaveValue("This is an unsaved fictional review edit.");
});

test("runbooks stay readable when the case server is unavailable", async ({ page }) => {
  await page.route("**/api/workspace", route => route.fulfill({ status: 503, json: { error: { message: "Synthetic unavailable server" } } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Runbooks", exact: true }).click();
  await expect(page.locator(".runbook-card")).toHaveCount(runbooks.length);
  await expect(page.getByRole("button", { name: "＋ New case", exact: true })).toBeDisabled();
  await expect(page.getByText("Read-only library.", { exact: false })).toBeVisible();
});

test("reviewed reply copying handles missing, denied and available clipboard access", async ({ page }) => {
  const reply = "A fictional recorded reply, ready for manual review and copying.";
  const record = { ...example, id: "synthetic-approved", mode: "example", state: "approved", version: 2,
    reply, reviews: [{ decision: "approved", original_reply: example.draft.customer_reply,
      reviewed_reply: reply, note: "Fictional review completed.", created_at: "2026-01-01T12:00:00Z" }],
    runs: [], created_at: "2026-01-01T12:00:00Z", updated_at: "2026-01-01T12:00:00Z" };
  await page.route("**/api/cases**", route => {
    expect(route.request().method()).toBe("GET");
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/cases") return route.fulfill({ json: [record] });
    if (path === "/api/cases/" + record.id) return route.fulfill({ json: record });
    throw new Error("Unexpected synthetic case request: " + path);
  });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.locator(".history-row").click();
  const copy = page.getByRole("button", { name: "Copy reviewed reply", exact: true });
  for (const mode of ["missing", "denied", "available", "denied"]) {
    await page.evaluate(mode => {
      Object.defineProperty(navigator, "clipboard", { configurable: true,
        value: mode === "missing" ? undefined : { writeText: async text => {
          if (mode === "denied") throw new DOMException("Synthetic denied access", "NotAllowedError");
          window.__copiedReply = text;
        } } });
    }, mode);
    await copy.click();
    if (mode === "available") {
      await expect(page.getByText("Reviewed reply copied.", { exact: true })).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
      expect(await page.evaluate(() => window.__copiedReply)).toBe(reply);
    } else {
      await expect(page.getByRole("alert")).toContainText("Select the reply text to copy it manually.");
      await expect(page.getByText("Reviewed reply copied.", { exact: true })).toHaveCount(0);
    }
    await expect(page.getByRole("textbox", { name: "Review the customer reply", exact: true })).toHaveValue(reply);
  }
  expect(errors).toEqual([]);
});

test("a stale review offers a guarded reload without repeating the decision", async ({ page }) => {
  let record = { ...example, id: "synthetic-conflict", mode: "example", state: "draft", version: 1,
    reply: example.draft.customer_reply, reviews: [], runs: [], created_at: "2026-01-01T12:00:00Z", updated_at: "2026-01-01T12:00:00Z" };
  const edited = "This is a fictional local reply that has not been recorded.";
  const recorded = "This is the reply recorded in another fictional browser tab.";
  const note = "Local review not yet saved.";
  let decisions = 0;
  let reads = 0;
  await page.route("**/api/cases**", route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === "/api/cases" && method === "GET") return route.fulfill({ json: [record] });
    if (path === "/api/cases/" + record.id && method === "GET") {
      reads += 1;
      return route.fulfill({ json: record });
    }
    if (path === "/api/cases/" + record.id + "/review" && method === "POST") {
      decisions += 1;
      expect(route.request().postDataJSON()).toEqual({ version: 1, decision: "approved", reply: edited, note });
      record = { ...record, state: "approved", version: 2, reply: recorded,
        reviews: [{decision: "approved", original_reply: example.draft.customer_reply,
          reviewed_reply: recorded, note: "Recorded in a second tab.", created_at: "2026-01-01T12:00:00Z"}] };
      return route.fulfill({ status: 409, json: { error: { code: "review_conflict",
        message: "This draft has changed or was already reviewed. Refresh before deciding." } } });
    }
    throw new Error("Unexpected synthetic conflict request: " + method + " " + path);
  });
  await page.goto("/");
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.locator(".history-row").click();
  const reply = page.getByRole("textbox", { name: "Review the customer reply", exact: true });
  await reply.fill(edited);
  await page.getByLabel("Your review note", { exact: true }).fill(note);
  await page.getByRole("button", { name: "Approve reply", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Refresh before deciding.");
  const reload = page.getByRole("button", { name: "Reload saved case", exact: true });
  await expect(reload).toBeVisible();
  await expect(reply).toHaveValue(edited);
  let discard = false;
  let prompts = 0;
  page.on("dialog", async dialog => { prompts += 1; await (discard ? dialog.accept() : dialog.dismiss()); });
  await reload.click();
  await expect(reply).toHaveValue(edited);
  await expect(page.getByLabel("Your review note", { exact: true })).toHaveValue(note);
  expect(reads).toBe(1);
  discard = true;
  await reload.click();
  await expect(reply).toHaveValue(recorded);
  await expect(reply).toHaveJSProperty("readOnly", true);
  await expect(page.getByRole("button", { name: "Copy reviewed reply", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(reads).toBe(2);
  expect(decisions).toBe(1);
  expect(prompts).toBe(2);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.locator(".history-row")).toContainText("Approved");
});
