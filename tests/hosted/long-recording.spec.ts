import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

function wav(pcm: Buffer) {
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function repeatedSpeech() {
  const source = await readFile("browser/public/sample.wav");
  expect(source.readUInt32LE(24)).toBe(16000);
  expect(source.readUInt16LE(22)).toBe(1);
  expect(source.readUInt16LE(34)).toBe(16);
  for (let offset = 12; offset + 8 <= source.length;) {
    const size = source.readUInt32LE(offset + 4);
    if (source.toString("ascii", offset, offset + 4) === "data") {
      const audio = source.subarray(offset + 8, offset + 8 + size);
      return wav(Buffer.concat(Array.from({ length: 16 }, () => audio)));
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("Speech fixture is missing a WAV data chunk");
}

test("rejects audio over ten minutes and can stop without losing the selected file", async ({
  page,
}) => {
  await page.goto("/");
  const file = page.locator("#audio-file");
  const start = page.getByRole("button", { name: "Transcribe recording" });
  await file.setInputFiles({
    name: "too-long.wav",
    mimeType: "audio/wav",
    buffer: wav(Buffer.alloc(601 * 32000)),
  });
  await start.click();
  await expect(page.getByRole("alert")).toHaveText(
    /between 1 second and 10 minutes/,
  );
  await file.setInputFiles("browser/public/sample.wav");
  await start.click();
  await page.getByRole("button", { name: "Stop transcription" }).click();
  await expect(page.getByRole("status")).toContainText("Transcription stopped");
  await expect(start).toBeEnabled();
  await expect(start).toBeFocused();
  await expect(page.getByRole("alert")).toBeHidden();
});

test("transcribes past the old limit and keeps subtitle times across windows", async ({
  page,
}) => {
  await page.goto("/");
  const recording = process.env.SMALL_HOURS_LONG_RECORDING || {
    name: "long-sample.wav",
    mimeType: "audio/wav",
    buffer: await repeatedSpeech(),
  };
  await page.locator("#audio-file").setInputFiles(recording);
  await page.getByRole("button", { name: "Transcribe recording" }).click();
  const progress = page.getByRole("progressbar", {
    name: "Transcription progress",
  });
  await expect(progress).toBeVisible();
  await expect(page.locator("#progress-note")).toHaveText(
    /\d+ of (?:[2-9]|[1-9]\d+) sections processed/,
    { timeout: 150000 },
  );
  const first = page.getByRole("textbox", {
    name: "Transcript segment 1",
    exact: true,
  });
  await expect(first).toBeVisible({ timeout: 180000 });
  const completedWindows = await page
    .locator("#progress")
    .evaluate((bar: HTMLProgressElement) => ({
      value: Number(bar.getAttribute("value")),
      max: bar.max,
    }));
  expect(completedWindows.max).toBeGreaterThan(1);
  expect(completedWindows.value).toBe(completedWindows.max);
  const duration = await page
    .locator("#player")
    .evaluate((player: HTMLAudioElement) => player.duration);
  expect(duration).toBeGreaterThan(120);
  if (!process.env.SMALL_HOURS_LONG_RECORDING)
    await expect(first).toHaveValue(/local transcription test/i);
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: /download subtitles/i }).click();
  const srt = await readFile((await (await pending).path())!, "utf8");
  const times = Array.from(
    srt.matchAll(/ --> (\d+):(\d+):(\d+),(\d+)/g),
    ([, h, m, s, ms]) =>
      Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000,
  );
  const last = Math.max(...times);
  expect(last).toBeGreaterThan(duration - 15);
  expect(last).toBeLessThanOrEqual(duration + 0.001);
  console.log(
    `Processed ${duration.toFixed(1)} seconds; subtitles extend to ${last.toFixed(1)} seconds.`,
  );
});
