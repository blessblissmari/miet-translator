import { test, expect } from "@playwright/test";

test.describe("MIET Translator — App Shell", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("app loads with title and settings prompt", async ({ page }) => {
    await expect(page.locator("h1")).toHaveText("MIET Translator");
    // Settings should be visible since no key is set
    await expect(page.locator(".settings")).toBeVisible();
    // Key warning should be visible
    await expect(page.locator(".key-warning")).toBeVisible();
  });

  test("settings panel toggles", async ({ page }) => {
    // Initially visible (no key)
    await expect(page.locator(".settings")).toBeVisible();
    // Click to hide
    await page.click("button:has-text('Скрыть настройки')");
    await expect(page.locator(".settings")).not.toBeVisible();
    // Click to show again
    await page.click("button:has-text('Настройки')");
    await expect(page.locator(".settings")).toBeVisible();
  });

  test("key input persists and clears warning", async ({ page }) => {
    const input = page.locator("input[type='password']");
    await input.fill("sk-or-v1-test123");
    await input.press("Tab");
    // Key warning should disappear
    await expect(page.locator(".key-warning")).not.toBeVisible();
    // Reload — should persist from localStorage
    await page.reload();
    // Settings panel may be hidden now (key exists → showSettings=false)
    // Open it to verify the value persisted
    await page.click("button:has-text('Настройки')");
    await expect(page.locator("input[type='password']")).toHaveValue("sk-or-v1-test123");
  });

  test("model selector shows all free models", async ({ page }) => {
    const options = page.locator(".settings select option");
    const count = await options.count();
    expect(count).toBeGreaterThanOrEqual(4);
  });

  test("dropzone is visible with correct text", async ({ page }) => {
    await expect(page.locator(".dropzone")).toContainText("файлы");
    await expect(page.locator(".dropzone")).toContainText("PDF");
  });

  test("empty viewer shows placeholder message", async ({ page }) => {
    await expect(page.locator(".empty")).toContainText("Выбери файл");
  });

  test("queue starts empty", async ({ page }) => {
    const items = page.locator(".queue .q-item");
    await expect(items).toHaveCount(0);
  });

  test("Запустить button is disabled when queue empty", async ({ page }) => {
    const btn = page.locator("button.primary");
    await expect(btn).toBeDisabled();
  });
});

test.describe("MIET Translator — File Upload", () => {
  test("uploading a .txt file populates the swipe deck", async ({ page }) => {
    await page.goto("/");
    // Create a small .txt file via file input
    const fileInput = page.locator('input[type="file"][accept*=".txt"]').first();
    // Use setInputFiles to simulate upload
    const buffer = Buffer.from("Hello World - test document content", "utf-8");
    await fileInput.setInputFiles({
      name: "test.txt",
      mimeType: "text/plain",
      buffer,
    });
    // SwipeDeck should appear with the file
    await expect(page.locator(".deck-root")).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".card-name")).toContainText("test.txt");
  });

  test("auto-sort all moves items to queue", async ({ page }) => {
    await page.goto("/");
    const fileInput = page.locator('input[type="file"][accept*=".txt"]').first();
    await fileInput.setInputFiles({
      name: "doc.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("content"),
    });
    await expect(page.locator(".deck-root")).toBeVisible({ timeout: 5000 });
    // Click auto-sort
    await page.click("button:has-text('Авто-сортировка')");
    // Queue should have 1 item
    await expect(page.locator(".queue .q-item")).toHaveCount(1, { timeout: 5000 });
    // Deck should disappear
    await expect(page.locator(".deck-root")).not.toBeVisible();
  });
});

test.describe("MIET Translator — Queue Controls", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Add a file to the queue directly by uploading + auto-sort
    const fileInput = page.locator('input[type="file"][accept*=".txt"]').first();
    await fileInput.setInputFiles({
      name: "sample.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Sample text for translation"),
    });
    await page.waitForSelector(".deck-root", { timeout: 5000 });
    await page.click("button:has-text('Авто-сортировка')");
    await page.waitForSelector(".queue .q-item", { timeout: 5000 });
  });

  test("queue item shows filename and DOC kind", async ({ page }) => {
    await expect(page.locator(".q-name")).toContainText("sample.txt");
    // txt defaults to document
    await expect(page.locator(".q-kind")).toHaveValue("document");
  });

  test("can change kind to presentation", async ({ page }) => {
    await page.selectOption(".q-kind", "presentation");
    await expect(page.locator(".q-kind")).toHaveValue("presentation");
  });

  test("remove button removes item from queue", async ({ page }) => {
    await page.click(".q-remove");
    await expect(page.locator(".queue .q-item")).toHaveCount(0);
  });

  test("clear button removes all items", async ({ page }) => {
    await page.click("button:has-text('Очистить')");
    await expect(page.locator(".queue .q-item")).toHaveCount(0);
  });

  test("Скачать всё is disabled when nothing is done", async ({ page }) => {
    const btn = page.locator("button:has-text('Скачать всё')");
    await expect(btn).toBeDisabled();
  });
});
