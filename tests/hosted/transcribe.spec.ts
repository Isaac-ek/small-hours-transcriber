import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("transcribes in the browser, edits and exports without uploading audio", async ({
  page,
}, info) => {
  const remoteWrites: string[] = [];
  const networkProblems: string[] = [];
  page.on("request", (request) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method()) &&
      request.url().startsWith("http")
    )
      remoteWrites.push(request.url());
  });
  page.on("console", (message) => {
    if (message.type() === "error") networkProblems.push(message.text());
  });
  page.on("requestfailed", (r) => {
    if (r.url().startsWith("http"))
      networkProblems.push(
        `${r.failure()?.errorText} ${new URL(r.url()).origin}${new URL(r.url()).pathname}`,
      );
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Good words/ })).toBeVisible();
  await page.getByRole("button", { name: /try an 8-second sample/i }).click();
  const result = page.getByRole("textbox", {
    name: "Transcript segment 1",
    exact: true,
  });
  try {
    await expect(result.or(page.getByRole("alert"))).toBeVisible({
      timeout: 175000,
    });
    await expect(result).toBeVisible({ timeout: 1000 });
  } catch (error) {
    throw new Error(
      `${error}\n${await page.getByRole("alert").textContent()}\n${networkProblems.join("\n")}`,
    );
  }
  await expect(result).toHaveValue(/local transcription test/i);
  expect(
    await page
      .locator("#player")
      .evaluate((player: HTMLAudioElement) => player.duration),
  ).toBeGreaterThan(1);
  await page.screenshot({
    path: info.outputPath("small-hours-desktop.png"),
    fullPage: true,
  });
  await result.fill("Edited in the browser.");
  for (const [button, extension] of [
    ["Download text", "txt"],
    ["Download subtitles", "srt"],
  ]) {
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: new RegExp(button) }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe(
      `small-hours-transcript.${extension}`,
    );
    const contents = await readFile((await download.path())!, "utf8");
    expect(contents).toContain("Edited in the browser.");
    if (extension === "srt")
      expect(contents).toMatch(/00:00:00,\d{3} --> 00:00:\d{2},\d{3}/);
  }
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Clear recording" }).click();
  await expect(
    page.getByRole("heading", { name: "From spoken to written." }),
  ).toBeVisible();
  await page
    .locator("#audio-file")
    .setInputFiles(resolve("browser/public/sample.wav"));
  await page.getByRole("button", { name: /transcribe recording/i }).click();
  await expect(result).toHaveValue(/local transcription test/i, {
    timeout: 30000,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  expect(remoteWrites).toEqual([]);
  expect(networkProblems).toEqual([]);
});
