import { test, expect } from "@playwright/test";
test("Gemini configuration enables the Studio AI harness without browser errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/state", async (route) => {
    const response = await route.fetch();
    const state = await response.json();
    state.integrations.ai = "Gemini configured";
    await route.fulfill({ response, json: state });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Analytics studio", exact: true })
    .click();
  // The cold, lazy-loaded Studio vendor bundle can take more than the default
  // five-second assertion window while Vite compiles its first request.
  await expect(
    page.getByRole("heading", { name: "Financial operations studio" }),
  ).toBeVisible({ timeout: 30000 });
  await expect(
    page.getByText(
      "Open the chat panel to build widgets using natural language.",
    ),
  ).toBeVisible();
  await expect(page.getByText("Reserve ledger", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
test("complete payment plan, graph, audit, and analytics journey", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Money, with context." }),
  ).toBeVisible();
  // A repeatable browser test uses a fresh second project when a prior run completed GreenCart.
  const snapshot = await (await page.request.get("/api/state")).json();
  const project = snapshot.projects.find(
    (p: { id: string }) =>
      !snapshot.plans.some(
        (plan: { projectId: string }) => plan.projectId === p.id,
      ),
  );
  expect(project).toBeTruthy();
  await page.getByLabel("Project", { exact: true }).selectOption(project.id);
  await page.getByRole("button", { name: "Create plan", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Every payment has a plan." }),
  ).toBeVisible();
  await expect(
    page.getByText("awaiting payment", { exact: true }),
  ).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: project.name });
  await row.getByRole("button", { name: "Simulate payment" }).click();
  await expect(
    page.getByRole("button", { name: "Approve plan" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Approve plan" }).click();
  await page.getByRole("button", { name: "Execute payouts" }).click();
  await expect(
    page.getByText("Simulation completed", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Context graph", exact: true })
    .click();
  await page.getByRole("button", { name: "Recipient: Maya Chen" }).click();
  await expect(
    page.getByRole("button", { name: "Close entity details" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(
    page.getByText("Simulated payouts completed", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Analytics studio", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Financial operations studio" }),
  ).toBeVisible();
  await expect(page.getByText("Reserve ledger", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save dashboard" }).click();
  await expect(page.getByText(/Dashboard saved on this device/)).toBeVisible();
  expect(pageErrors).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/analytics-desktop.png",
    fullPage: true,
  });
});
test("mobile layout, navigation and invalid plan feedback", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Money, with context." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
  await page
    .getByLabel("Payment instruction")
    .fill("Maya 40%, Arjun 20%, taxes 10%, expenses 5%");
  await page.getByRole("button", { name: "Create plan", exact: true }).click();
  await expect(page.locator(".error")).toBeVisible();
  await page.getByRole("button", { name: "Integrations", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Connected by purpose." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("plan dialog supports keyboard dismissal and focus containment", async ({
  page,
}) => {
  await page.goto("/");
  const opener = page.getByRole("button", {
    name: "New payment plan",
    exact: true,
  });
  await opener.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Generate payment plan" }).focus();
  await page.keyboard.press("Tab");
  expect(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});
