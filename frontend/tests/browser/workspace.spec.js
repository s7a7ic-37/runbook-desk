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
