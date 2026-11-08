import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

const runbooks = JSON.parse(readFileSync(new URL("../../../server/runbooks.json", import.meta.url)));
const examples = JSON.parse(readFileSync(new URL("../../../server/examples.json", import.meta.url)));
const example = examples[0];

test.beforeEach(async ({ context }) => {
  const cases = [];
  await context.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/workspace") return route.fulfill({ json: { ready: true } });
    if (path === "/api/config") return route.fulfill({ json: { live_enabled: false, calls_remaining: 0, case_deletion_enabled: true, runbooks, examples } });
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

test("saved-case search stays local and survives refresh and case navigation", async ({ page }) => {
  const records = ["Webhook retries — Łódź", "Invoice [draft] mismatch", "Delayed report"].map((title, index) => ({
    ...example, id: "synthetic-search-" + index, title, mode: "example", state: "draft", version: 1,
    reply: example.draft.customer_reply, reviews: [], runs: [], created_at: "2026-01-01T12:00:00Z", updated_at: "2026-01-01T12:00:00Z",
  }));
  let reads = 0;
  await page.route("**/api/cases**", route => {
    expect(route.request().method()).toBe("GET");
    reads += 1;
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({json: path === "/api/cases" ? records : records.find(record => path.endsWith("/" + record.id))});
  });
  await page.goto("/");
  await page.getByRole("button", {name: "History", exact: true}).click();
  const search = page.getByLabel("Find a saved case", {exact: true});
  await expect(search).toHaveCount(1);
  const initialReads = reads;
  await search.fill(" ŁÓDŹ ");
  await expect(page.locator(".history-row")).toHaveCount(1);
  await expect(page.locator(".history-row")).toContainText(records[0].title);
  await search.fill(".+");
  await expect(page.getByText("No saved cases match this title.", {exact: true})).toBeVisible();
  expect(reads).toBe(initialReads);
  await page.getByRole("button", {name: "Clear search", exact: true}).click();
  await expect(page.locator(".history-row")).toHaveCount(3);
  await expect(search).toBeFocused();
  await search.fill("webhook");
  records.push({...records[0], id: "synthetic-search-3", title: "Webhook delivery checks"});
  await page.getByRole("button", {name: "Refresh history", exact: true}).click();
  await expect(search).toHaveValue("webhook");
  await expect(page.locator(".history-row")).toHaveCount(2);
  await search.fill("Invoice [draft]");
  await page.locator(".history-row").click();
  await expect(page.getByRole("heading", {name: records[1].title, exact: true})).toBeVisible();
  await page.getByRole("button", {name: "History", exact: true}).click();
  await expect(search).toHaveValue("Invoice [draft]");
  await expect(page.locator(".history-row")).toHaveCount(1);
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({width, height: 900});
    expect(await page.evaluate(() => innerWidth)).toBe(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await search.boundingBox()).height).toBeGreaterThanOrEqual(44);
  }
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

for (const failure of ["connection", "proxy", "unreadable success"]) {
test(`a save with ${failure} failure reuses its creation key while an explicit new case gets another`, async ({ page }) => {
  const saved = new Map();
  const keys = [];
  await page.route("**/api/cases", route => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: [...saved.values()] });
    const key = request.headers()["idempotency-key"];
    keys.push(key);
    const storageKey = key || "unkeyed-" + keys.length;
    if (!saved.has(storageKey)) saved.set(storageKey, { ...request.postDataJSON(),
      id: "synthetic-save-" + saved.size, state: "new", mode: "live", version: 0,
      reply: "", draft: null, reviews: [], runs: [],
      created_at: "2026-01-01T12:00:00Z", updated_at: "2026-01-01T12:00:00Z" });
    // The fictional server saved the case before its response was lost.
    if (keys.length === 1) {
      if (failure === "connection") return route.abort("failed");
      return route.fulfill({status: failure === "proxy" ? 502 : 200, body: "Synthetic unreadable response"});
    }
    return route.fulfill({ status: 201, json: saved.get(storageKey) });
  });
  await page.goto("/");
  const title = "Fictional interrupted save";
  const description = "Fictional incident details for a save whose acknowledgement is deliberately lost.";
  async function fillCase() {
    await page.getByLabel("Case title", { exact: true }).fill(title);
    await page.locator("#case-description").fill(description);
  }
  await fillCase();
  await page.getByRole("button", { name: "Save case", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Retry with unchanged details to recover the same case");
  await expect(page.getByLabel("Case title", { exact: true })).toHaveValue(title);
  expect(keys).toHaveLength(1);
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "Save case", exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  expect(keys).toEqual([keys[0], keys[0]]);
  expect(saved.size).toBe(1);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.locator(".history-row")).toHaveCount(1);
  await page.getByRole("button", { name: "＋ New case", exact: true }).click();
  await fillCase();
  await page.getByRole("button", { name: "Save case", exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  expect(keys).toHaveLength(3);
  expect(keys[2]).not.toBe(keys[0]);
  expect(saved.size).toBe(2);
});
}

test("editing an interrupted case starts a different save without replacing the first one", async ({ page }) => {
  const keys = [];
  const records = [];
  await page.route("**/api/cases", route => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: records });
    keys.push(request.headers()["idempotency-key"]);
    const record = { ...request.postDataJSON(), id: "synthetic-edit-" + keys.length,
      state: "new", mode: "live", version: 0, reply: "", draft: null, reviews: [], runs: [],
      created_at: "2026-01-01T12:00:00Z", updated_at: "2026-01-01T12:00:00Z" };
    records.push(record);
    if (keys.length === 1) return route.abort("failed");
    return route.fulfill({ status: 201, json: record });
  });
  await page.goto("/");
  await page.getByLabel("Case title", { exact: true }).fill("First fictional details");
  await page.locator("#case-description").fill("A fictional incident with sufficient detail for a deliberately interrupted save.");
  await page.getByRole("button", { name: "Save case", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByLabel("Case title", { exact: true }).fill("Changed fictional details");
  await page.getByRole("button", { name: "Save case", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Changed fictional details", exact: true })).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[1]).not.toBe(keys[0]);
  expect(records.map(item => item.title)).toEqual(["First fictional details", "Changed fictional details"]);
});

test("a worked-example retry reopens the saved example rather than creating another", async ({ page }) => {
  const keys = [];
  const saved = new Map();
  await page.route("**/api/cases", route => {
    expect(route.request().method()).toBe("GET");
    return route.fulfill({ json: [...saved.values()] });
  });
  await page.route("**/api/examples/" + example.id, route => {
    const key = route.request().headers()["idempotency-key"];
    keys.push(key);
    const storageKey = key || "unkeyed-" + keys.length;
    if (!saved.has(storageKey)) saved.set(storageKey, { ...example, id: "synthetic-example-" + saved.size,
      mode: "example", state: "draft", version: 0, reply: example.draft.customer_reply,
      reviews: [], runs: [], created_at: "2026-01-01T12:00:00Z", updated_at: "2026-01-01T12:00:00Z" });
    if (keys.length === 1) return route.abort("failed");
    return route.fulfill({ status: 201, json: saved.get(storageKey) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Save case", exact: true }).waitFor();
  async function openExample() {
    const picker = page.locator("#mobile-example");
    if (await picker.isVisible()) await picker.selectOption(example.id);
    else await page.locator(".example-link").filter({ hasText: example.title }).click();
  }
  await openExample();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(keys).toHaveLength(1);
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  await openExample();
  await expect(page.getByRole("textbox", { name: "Review the customer reply", exact: true })).toHaveValue(example.draft.customer_reply);
  expect(keys).toEqual([keys[0], keys[0]]);
  expect(saved.size).toBe(1);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.locator(".history-row")).toHaveCount(1);
});

for (const capability of [undefined, false, "true"]) {
  test(`deletion stays hidden without explicit API support: ${String(capability)}`, async ({ page }) => {
    await page.route("**/api/config", route => route.fulfill({ json: {
      live_enabled: false, calls_remaining: 0, runbooks, examples,
      ...(capability === undefined ? {} : {case_deletion_enabled: capability}),
    } }));
    await page.goto("/");
    await page.getByRole("button", { name: "Try a worked example", exact: true }).click();
    await expect(page.getByRole("heading", { name: example.title, exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Review the customer reply", exact: true })).toHaveValue(example.draft.customer_reply);
    await expect(page.getByRole("button", { name: "Delete saved case", exact: true })).toHaveCount(0);
  });
}

test("deleting a saved case requires confirmation and removes it from history", async ({ page }) => {
  const deleted = [];
  await page.goto("/");
  await page.getByRole("button", { name: "Try a worked example", exact: true }).click();
  await expect(page.getByRole("heading", { name: example.title, exact: true })).toBeVisible();
  await page.route("**/api/cases/synthetic-case", route => {
    if (route.request().method() !== "DELETE") return route.fallback();
    deleted.push(route.request().url());
    return route.fulfill({ json: { deleted: true } });
  });
  const reply = page.getByRole("textbox", { name: "Review the customer reply", exact: true });
  await reply.fill("Fictional unsaved review edit for deletion confirmation.");

  const decisions = [false, true];
  const prompts = [];
  page.on("dialog", async dialog => {
    prompts.push(dialog.message());
    if (decisions.shift()) await dialog.accept();
    else await dialog.dismiss();
  });
  const remove = page.getByRole("button", { name: "Delete saved case", exact: true });
  await remove.click();
  await expect(page.getByRole("heading", { name: example.title, exact: true })).toBeVisible();
  await expect(reply).toHaveValue("Fictional unsaved review edit for deletion confirmation.");
  expect(deleted).toHaveLength(0);
  await remove.click();

  await expect(page.getByRole("heading", { name: "Saved in your workspace", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Nothing saved yet.", exact: true })).toBeVisible();
  await expect(page.getByText("Saved case and review history deleted.", { exact: true })).toBeVisible();
  expect(prompts).toHaveLength(2);
  expect(prompts[0]).toContain("unsaved edits will be lost");
  expect(deleted).toHaveLength(1);
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

test("source dialogs expose their procedure and return keyboard focus without losing edits", async ({ page }) => {
  await page.goto("/");
  const picker = page.locator("#mobile-example");
  await page.getByRole("button", { name: "Save case", exact: true }).waitFor();
  if (await picker.isVisible()) await picker.selectOption(example.id);
  else await page.locator(".example-link").filter({ hasText: example.title }).click();
  const reply = page.getByRole("textbox", { name: "Review the customer reply", exact: true });
  const edited = "Fictional review edits retained while checking a procedure.";
  await reply.fill(edited);
  const book = runbooks.find(item => item.id === example.runbook_ids[0]);
  const source = page.locator(".source-stack .citation").filter({ hasText: book.title }).first();
  const prompts = [];
  page.on("dialog", async dialog => { prompts.push(dialog.type()); await dialog.dismiss(); });
  for (const closeWith of ["escape", "button"]) {
    await source.focus();
    await expect(source).toBeFocused();
    await page.keyboard.press("Enter");
    const modal = page.getByRole("dialog", { name: book.title, exact: true });
    await expect(modal).toBeVisible();
    await expect(modal.getByText(book.body, { exact: true })).toBeVisible();
    await expect(modal.getByRole("button", { name: "Close source", exact: true })).toBeFocused();
    if (closeWith === "button") {
      // A queued close event from the previous opening can arrive after showModal.
      await modal.evaluate(node => node.dispatchEvent(new Event("close")));
      await expect(modal).toBeVisible();
    }
    if (closeWith === "escape") await page.keyboard.press("Escape");
    else await page.keyboard.press("Enter");
    await expect(modal).not.toBeVisible();
    await expect(source).toBeFocused();
    await expect(reply).toHaveValue(edited);
  }
  expect(prompts).toEqual([]);
});

test("downloaded handoffs retain the replies recorded by every review", async ({ page }) => {
  const reviews = [
    {decision: "rejected", original_reply: "An earlier fictional draft — Łódź.", reviewed_reply: "An earlier recorded reply.", note: "Earlier evidence incomplete.", created_at: "2026-01-01T12:00:00Z"},
    {decision: "approved", original_reply: example.draft.customer_reply, reviewed_reply: "The final fictional recorded reply.", note: "Later evidence checked.", created_at: "2026-01-02T12:00:00Z"},
  ];
  const record = {...example, id: "synthetic-export", mode: "example", state: "approved", version: 4,
    reply: reviews[1].reviewed_reply, reviews, runs: [], created_at: reviews[0].created_at, updated_at: reviews[1].created_at};
  await page.route("**/api/cases**", route => {
    expect(route.request().method()).toBe("GET");
    return route.fulfill({json: new URL(route.request().url()).pathname === "/api/cases" ? [record] : record});
  });
  await page.goto("/");
  await page.getByRole("button", {name: "History", exact: true}).click();
  await page.locator(".history-row").click();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", {name: "Download case handoff", exact: true}).click();
  const text = await readFile(await (await pending).path(), "utf8");
  for (const [index, entry] of reviews.entries()) {
    expect(text).toContain(`Review ${index + 1} · ${entry.created_at}`);
    expect(text).toContain("REPLY BEFORE THIS REVIEW\n" + entry.original_reply);
    expect(text).toContain("REPLY RECORDED BY THIS REVIEW\n" + entry.reviewed_reply);
    expect(text).toContain(entry.note);
  }
  expect(text.indexOf("Review 1 ·")).toBeLessThan(text.indexOf("Review 2 ·"));
  expect(text).toContain("illustrative draft, not an OpenAI response");
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
