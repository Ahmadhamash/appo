import { expect, test } from "@playwright/test";

test("renders the English login page", async ({ page }) => {
  await page.goto("/en");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("renders the Arabic login page right-to-left", async ({ page }) => {
  await page.goto("/ar");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("تسجيل الدخول");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
});

test("blocks the public credential sign-up endpoint", async ({ request }) => {
  const response = await request.post("/api/auth/sign-up/email", {
    data: {
      email: "uninvited@example.invalid",
      name: "Uninvited User",
      password: "not-a-real-password",
    },
  });
  expect(response.status()).toBe(404);
  await expect(response.json()).resolves.toMatchObject({ code: "INVITATION_REQUIRED" });
});

test("an owner enters only their organization without a tenant switcher", async ({ page }) => {
  const seedPassword = process.env.DEV_SEED_PASSWORD;
  test.skip(!seedPassword, "DEV_SEED_PASSWORD is required for the authenticated browser test.");
  await page.goto("/en/login");
  await page.getByLabel("Email address").fill("owner@example.invalid");
  await page.getByLabel("Password").fill(seedPassword ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: "Clinic portal: Development Clinic A" }),
  ).toBeVisible();
  await expect(page.locator(".workspace-context strong")).toHaveText("Development Clinic A");
  await expect(page.getByLabel("Switch organization")).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
});

test("owner can use the Phase 2 customer and calendar screens", async ({ page }) => {
  const seedPassword = process.env.DEV_SEED_PASSWORD;
  test.skip(!seedPassword, "DEV_SEED_PASSWORD is required for the authenticated browser test.");
  await page.goto("/en/login");
  await page.getByLabel("Email address").fill("owner@example.invalid");
  await page.getByLabel("Password").fill(seedPassword ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/en\/dashboard$/u);
  await page.goto("/en/dashboard/customers");
  await expect(page.getByRole("heading", { level: 1, name: "Customers" })).toBeVisible();
  await page.getByLabel("Full name").fill(`E2E Customer ${Date.now()}`);
  await page.getByRole("button", { name: "Create customer" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("E2E Customer");
  await page.goto("/en/dashboard/calendar");
  await expect(page.getByRole("heading", { level: 1, name: "Calendar" })).toBeVisible();
  await page.locator("summary").filter({ hasText: "Create appointment" }).click();
  await expect(page.getByRole("button", { name: "Create appointment" })).toBeVisible();
  await page.goto("/en/dashboard/today");
  await expect(page.getByRole("heading", { level: 1, name: "Today operations" })).toBeVisible();
});

test("owner can use the sector-specific gym trainee workflow in English and Arabic RTL", async ({
  page,
}) => {
  const seedPassword = process.env.DEV_SEED_PASSWORD;
  test.skip(!seedPassword, "DEV_SEED_PASSWORD is required for the authenticated browser test.");
  const traineeName = `Gym E2E Trainee ${Date.now()}`;
  await page.goto("/en/login");
  await page.getByLabel("Email address").fill("gym-owner@example.invalid");
  await page.getByLabel("Password").fill(seedPassword ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "Gym management portal: Development Gym C" }),
  ).toBeVisible();
  await expect(page.getByLabel("Switch organization")).toHaveCount(0);

  await page.goto("/en/dashboard/customers");
  await page.getByLabel("Full name").fill(traineeName);
  await page.getByRole("button", { name: "Create customer" }).click();
  await expect(page.getByRole("heading", { level: 1, name: traineeName })).toBeVisible();
  await page.goto("/en/dashboard/gym/trainees");
  await expect(page.getByRole("heading", { level: 1, name: "Trainees" })).toBeVisible();
  await page.locator("details.trainee-add-disclosure > summary").click();
  await page.getByLabel("Select customer").selectOption({ label: traineeName });
  await page.getByLabel("Starting weight (kg)").fill("82");
  await page.getByLabel("Target weight (kg)").fill("88");
  await page.getByRole("button", { name: "Add trainee profile" }).click();
  await expect(page.getByRole("heading", { level: 1, name: traineeName })).toBeVisible();

  await page.goto("/ar/dashboard/gym/trainees");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1, name: "المتدربون" })).toBeVisible();
});

test("trainee login opens the private mobile-ready training portal without staff controls", async ({
  page,
}) => {
  const seedPassword = process.env.DEV_SEED_PASSWORD;
  test.skip(!seedPassword, "DEV_SEED_PASSWORD is required for the authenticated browser test.");
  await page.goto("/ar/login");
  await page.getByLabel("البريد الإلكتروني").fill("trainee@example.invalid");
  await page.getByLabel("كلمة المرور").fill(seedPassword ?? "");
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await expect(page).toHaveURL(/\/ar\/trainee/u);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1, name: "أحمد المتدرّب" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "تمرين اليوم" })).toBeVisible();
  await expect(page.getByLabel("التنقل الرئيسي")).toHaveCount(0);
  await expect(page.getByText("إدارة المؤسسة")).toHaveCount(0);
  await expect(page.getByLabel("وزن الجسم (كغ) +")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { level: 1, name: "أحمد المتدرّب" })).toBeVisible();
  await expect(page.getByLabel("شخصيتك التدريبية المتحركة")).toBeVisible();
});

test("owner can use Phase 3 resource and waitlist screens in English and Arabic RTL", async ({
  page,
}) => {
  const seedPassword = process.env.DEV_SEED_PASSWORD;
  test.skip(!seedPassword, "DEV_SEED_PASSWORD is required for the authenticated browser test.");
  await page.goto("/en/login");
  await page.getByLabel("Email address").fill("owner@example.invalid");
  await page.getByLabel("Password").fill(seedPassword ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/en\/dashboard$/u);

  await page.goto("/en/dashboard/resources");
  await expect(page.getByRole("heading", { level: 1, name: "Resources" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Add resource group" })).toBeVisible();
  await page.goto("/en/dashboard/waitlist");
  await expect(page.getByRole("heading", { level: 1, name: "Waitlist" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Add to waitlist" })).toBeVisible();

  await page.goto("/ar/dashboard/resources");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1, name: "الموارد" })).toBeVisible();
  await page.goto("/ar/dashboard/waitlist");
  await expect(page.getByRole("heading", { level: 1, name: "قائمة الانتظار" })).toBeVisible();
});

test("owner can use the Phase 4 inbox and queue a consented mock message", async ({ page }) => {
  const seedPassword = process.env.DEV_SEED_PASSWORD;
  test.skip(!seedPassword, "DEV_SEED_PASSWORD is required for the authenticated browser test.");
  await page.goto("/en/login");
  await page.getByLabel("Email address").fill("owner@example.invalid");
  await page.getByLabel("Password").fill(seedPassword ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/en\/dashboard$/u);

  await page.goto("/en/dashboard/communications");
  await expect(page.getByRole("heading", { level: 1, name: "Communications" })).toBeVisible();
  await expect(page.getByText(/Local mock adapters only/)).toBeVisible();
  await page.getByLabel("Customer").selectOption({ label: "Leila Development" });
  await page.locator('select[name="appointmentId"]').selectOption("");
  await page.getByRole("button", { name: "Send template" }).click();
  await expect(page.getByText("Message queued for mock delivery.")).toBeVisible();

  await page.goto("/ar/dashboard/communications");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1, name: "الاتصالات" })).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: "صندوق اتصالات الموظفين" }),
  ).toBeVisible();
});

test("owner can manage Phase 5A/5B AI in English and Arabic RTL", async ({ page }) => {
  const seedPassword = process.env.DEV_SEED_PASSWORD;
  test.skip(!seedPassword, "DEV_SEED_PASSWORD is required for the authenticated browser test.");
  await page.goto("/en/login");
  await page.getByLabel("Email address").fill("owner@example.invalid");
  await page.getByLabel("Password").fill(seedPassword ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/en\/dashboard$/u);

  await page.goto("/en/dashboard/knowledge");
  await expect(page.getByRole("heading", { level: 1, name: "Knowledge base" })).toBeVisible();
  await page.getByLabel("Source name").fill(`E2E knowledge ${Date.now()}`);
  await page.getByLabel("Document title").fill("E2E safe business fact");
  await page.getByLabel("Plain-text knowledge").fill("The E2E desk closes at 17:00.");
  await page.getByRole("button", { name: "Ingest knowledge" }).click();
  await expect(page.getByText("Knowledge version ingested and checked.")).toBeVisible();

  await page.goto("/en/dashboard/ai-conversations");
  await expect(page.getByRole("heading", { level: 1, name: "AI conversations" })).toBeVisible();
  await page.goto("/en/dashboard/ai-actions");
  await expect(page.getByRole("heading", { level: 1, name: "AI action audit" })).toBeVisible();
  await page.goto("/en/dashboard/ai-settings");
  await expect(page.getByRole("heading", { level: 1, name: "AI configuration" })).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: "Safety evaluation cases" }),
  ).toBeVisible();
  await page.goto("/en/dashboard/ai-handoffs");
  await expect(page.getByRole("heading", { level: 1, name: "Human handoff queue" })).toBeVisible();
  await page.goto("/en/dashboard/ai-usage");
  await expect(page.getByRole("heading", { level: 1, name: "AI usage" })).toBeVisible();
  await page.goto("/en/dashboard/ai-channels");
  await expect(page.getByRole("heading", { level: 1, name: "AI customer channels" })).toBeVisible();
  const widgetName = `E2E widget ${Date.now()}`;
  await page.getByLabel("Installation name").fill(widgetName);
  await page.getByLabel("English display name").fill("E2E assistant");
  await page.getByLabel("Arabic display name").fill("مساعد الاختبار");
  await page.getByRole("button", { name: "Create widget installation" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Website installation" })).toBeVisible();
  const widgetCard = page.getByRole("heading", { level: 3, name: widgetName }).locator("..");
  const snippet = await widgetCard
    .getByRole("textbox", { name: "Website installation" })
    .inputValue();
  const configurationToken = /data-jormall-config="([^"]+)"/u.exec(snippet)?.[1];
  expect(configurationToken).toBeTruthy();
  const sessionResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/ai/widget/session") && response.request().method() === "POST",
  );
  await page.evaluate((token) => {
    const script = document.createElement("script");
    script.src = "/ai-widget.js";
    script.dataset.jormallConfig = token;
    script.dataset.locale = "en";
    document.body.append(script);
  }, configurationToken ?? "");
  const sessionResponse = await sessionResponsePromise;
  if (!sessionResponse.ok()) {
    throw new Error(`Widget session failed with HTTP ${sessionResponse.status()}.`);
  }
  const sessionBody: unknown = await sessionResponse.json();
  if (
    typeof sessionBody !== "object" ||
    sessionBody === null ||
    !("sessionToken" in sessionBody) ||
    typeof sessionBody.sessionToken !== "string"
  ) {
    throw new Error("Widget session response is missing its capability.");
  }
  const encodedSession = sessionBody.sessionToken.split(".")[0] ?? "";
  const sessionCapability: unknown = JSON.parse(
    Buffer.from(encodedSession, "base64url").toString("utf8"),
  );
  expect(sessionCapability).not.toHaveProperty("organizationId");
  expect(sessionCapability).not.toHaveProperty("sessionId");
  await page.getByRole("button", { name: "Chat with JorMall" }).click();
  await page
    .getByRole("textbox", { name: "Type your message" })
    .fill("Which services do you offer?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("log")).toContainText("Consultation");

  await page.goto("/ar/dashboard/knowledge");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1, name: "قاعدة المعرفة" })).toBeVisible();
  await page.goto("/ar/dashboard/ai-settings");
  await expect(
    page.getByRole("heading", { level: 1, name: "إعدادات الذكاء الاصطناعي" }),
  ).toBeVisible();
  await page.goto("/ar/dashboard/ai-channels");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(
    page.getByRole("heading", { level: 1, name: "قنوات العملاء بالذكاء الاصطناعي" }),
  ).toBeVisible();
});

test("owner can generate evidence-linked Phase 6 Copilot insights in English and Arabic RTL", async ({
  page,
}) => {
  const seedPassword = process.env.DEV_SEED_PASSWORD;
  test.skip(!seedPassword, "DEV_SEED_PASSWORD is required for the authenticated browser test.");
  await page.goto("/en/login");
  await page.getByLabel("Email address").fill("owner@example.invalid");
  await page.getByLabel("Password").fill(seedPassword ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/en\/dashboard$/u);

  await page.goto("/en/dashboard/copilot");
  await expect(page.getByRole("heading", { level: 1, name: "Staff Copilot" })).toBeVisible();
  await page
    .locator('form:has(input[name="insightType"][value="DAILY_BRIEFING"])')
    .getByRole("button", { name: "Generate from authorized records" })
    .click();
  await expect(
    page.getByRole("heading", { level: 3, name: /Daily briefing ·/u }).first(),
  ).toBeVisible();
  await expect(page.getByText("Computed metric", { exact: true }).first()).toBeVisible();
  await page.getByText("Model and policy trace", { exact: true }).first().click();
  await expect(page.getByText("jormall-copilot-deterministic-mock-v1").first()).toBeVisible();

  await page.goto("/en/dashboard/customers");
  await page.getByRole("link", { name: "Leila Development" }).click();
  await page.getByRole("button", { name: "Generate from authorized records" }).click();
  await expect(
    page.getByRole("heading", { name: "Evidence-linked customer summary" }),
  ).toBeVisible();
  await expect(page.getByText("Fact", { exact: true }).first()).toBeVisible();

  await page.goto("/ar/dashboard/copilot");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1, name: "مساعد الموظفين" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "مساعد التحليلات" })).toBeVisible();
});

test("owner can dry-run Phase 7 imports and view reports, exports, audit and Arabic RTL", async ({
  page,
}) => {
  const seedPassword = process.env.DEV_SEED_PASSWORD;
  test.skip(!seedPassword, "DEV_SEED_PASSWORD is required for the authenticated browser test.");
  await page.goto("/en/login");
  await page.getByLabel("Email address").fill("owner@example.invalid");
  await page.getByLabel("Password").fill(seedPassword ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/en\/dashboard$/u);

  await page.goto("/en/dashboard/imports");
  await expect(page.getByRole("heading", { level: 1, name: "Safe imports" })).toBeVisible();
  await page.getByLabel("CSV").setInputFiles({
    buffer: Buffer.from(
      `external_key,display_name,phone,preferred_locale\ne2e-${Date.now()},Phase Seven Browser,0798112233,en\n`,
    ),
    mimeType: "text/csv",
    name: "phase-seven-customers.csv",
  });
  await page.getByRole("button", { name: "Upload and dry run" }).click();
  await expect(
    page.getByText("Import dry run completed without changing operational records."),
  ).toBeVisible();
  await expect(page.getByText("DRY_RUN_READY").first()).toBeVisible();

  await page.goto("/en/dashboard/reports");
  await expect(
    page.getByRole("heading", { level: 1, name: "Reports and attribution" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Run report" }).click();
  await expect(
    page.getByText("A report with a traceable data watermark was created."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Data exports" }).click();
  await expect(page.getByText("Export job is ready to download for one hour.")).toBeVisible();

  await page.goto("/en/dashboard/audit");
  await expect(page.getByRole("heading", { level: 1, name: "Audit log" })).toBeVisible();
  await page.goto("/ar/dashboard/imports");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1, name: "الاستيراد الآمن" })).toBeVisible();
});

test("owner can inspect and queue the advisory Phase 8 predictive layer in English and Arabic RTL", async ({
  page,
}) => {
  const seedPassword = process.env.DEV_SEED_PASSWORD;
  test.skip(!seedPassword, "DEV_SEED_PASSWORD is required for the authenticated browser test.");
  await page.goto("/en/login");
  await page.getByLabel("Email address").fill("owner@example.invalid");
  await page.getByLabel("Password").fill(seedPassword ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/en\/dashboard$/u);

  await page.goto("/en/dashboard/predictions");
  await expect(
    page.getByRole("heading", { level: 1, name: "Predictive intelligence" }),
  ).toBeVisible();
  const readinessRegion = page.getByLabel("Historical data readiness");
  await expect(
    readinessRegion.getByRole("heading", { level: 3, name: "No-show prediction" }),
  ).toBeVisible();
  await expect(
    readinessRegion.getByRole("heading", { level: 3, name: "Demand forecasting" }),
  ).toBeVisible();
  await expect(
    readinessRegion.getByRole("heading", { level: 3, name: "Staffing suggestions" }),
  ).toBeVisible();
  await expect(
    readinessRegion.getByRole("heading", { level: 3, name: "Advanced schedule reflow" }),
  ).toBeVisible();
  await expect(
    readinessRegion.getByRole("heading", {
      level: 3,
      name: "Service, provider and slot recommendations",
    }),
  ).toBeVisible();
  await expect(page.getByText(/operational assistance only.*never deny service/u)).toBeVisible();

  await page.getByLabel("Capability").selectOption("NO_SHOW");
  await page.getByLabel("Job type").selectOption("DATA_AUDIT");
  await page.getByRole("button", { name: "Queue predictive job" }).click();
  await expect(page.getByText("Predictive job queued for safe processing.")).toBeVisible();
  await expect(page.getByRole("cell", { name: "Data audit" }).first()).toBeVisible();

  await page.goto("/ar/dashboard/predictions");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1, name: "الذكاء التنبؤي" })).toBeVisible();
  await expect(
    page
      .getByLabel("جاهزية البيانات التاريخية")
      .getByRole("heading", { level: 3, name: "توقع عدم الحضور" }),
  ).toBeVisible();
});
