import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
test("real audio completes, edits reach TXT/SRT, reload persists and delete cleans up", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Good words. Worth keeping." }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("transcriber-empty.png"),
    fullPage: true,
  });
  await page.locator("#audio-file").setInputFiles(".runtime/sample.wav");
  await page.getByRole("button", { name: /Transcribe recording/ }).click();
  await expect(page.locator("#filename")).toHaveText("sample.wav");
  await expect(page.locator("#completed")).toBeVisible({ timeout: 150000 });
  await expect
    .poll(async () =>
      page
        .locator("#player")
        .evaluate((element) => (element as HTMLAudioElement).duration),
    )
    .toBeGreaterThan(1);
  await page.locator("#player").evaluate(async (element) => {
    const audio = element as HTMLAudioElement;
    await audio.play();
    audio.pause();
  });
  const first = page.getByLabel("Transcript segment 1", { exact: true });
  const actual = await first.inputValue();
  expect(actual.length).toBeGreaterThan(10);
  await test
    .info()
    .attach("actual-model-transcript", {
      body: Buffer.from(actual),
      contentType: "text/plain",
    });
  await first.fill("A corrected local transcript.");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Saved", exact: true }),
  ).toBeVisible();
  const txtEvent = page.waitForEvent("download");
  await page
    .getByRole("link", { name: "Download text ↓", exact: true })
    .click();
  const txt = await txtEvent;
  expect(readFileSync((await txt.path())!, "utf8")).toContain(
    "A corrected local transcript.",
  );
  const srtEvent = page.waitForEvent("download");
  await page
    .getByRole("link", { name: "Download subtitles ↓", exact: true })
    .click();
  const srt = readFileSync((await (await srtEvent).path())!, "utf8");
  expect(srt).toContain("-->");
  expect(srt).toContain("A corrected local transcript.");
  await page.screenshot({
    path: info.outputPath("transcriber-completed.png"),
    fullPage: true,
  });
  await page.reload();
  await page.getByRole("button", { name: /sample.wav/ }).click();
  await expect(
    page.getByLabel("Transcript segment 1", { exact: true }),
  ).toHaveValue("A corrected local transcript.");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("transcriber-mobile.png"),
    fullPage: true,
  });
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Delete recording", exact: true })
    .click();
  await expect(
    page.getByText("Your recordings will appear here.", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
