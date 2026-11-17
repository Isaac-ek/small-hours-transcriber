import "./style.css";
import { readSegments, subtitles, timestamp } from "./transcript.js";

const $ = (id) => document.getElementById(id);
const input = $("audio-file");
const player = $("player");
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_SECONDS = 600;
const LENGTH_ERROR = "Choose a recording between 1 second and 10 minutes.";
const progress = $("progress");
let activeJob;
let recordingUrl,
  worker,
  segments = [],
  busy = false,
  edited = false;

function setBusy(value) {
  busy = value;
  $("processing").hidden = !value;
  if (value) progress.removeAttribute("value");
  input.disabled = value;
  $("sample").disabled = value;
  $("clear").disabled = value;
  $("transcribe").disabled = value || !input.files.length;
}

function status(message) {
  $("phase").textContent = message;
  $("status").textContent = message;
}

function reset() {
  player.pause();
  player.removeAttribute("src");
  player.load();
  if (recordingUrl) URL.revokeObjectURL(recordingUrl);
  recordingUrl = undefined;
  segments = [];
  edited = false;
  $("segments").replaceChildren();
  $("completed").hidden = true;
  $("recording").hidden = true;
  $("job-error").hidden = true;
  $("empty-editor").hidden = false;
  $("status").textContent = "";
}

async function decode(file, signal) {
  // Decoding through a 16 kHz offline context resamples for Whisper without
  // opening an audio output stream. Mix the channels into one PCM buffer.
  const duration = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        finish(
          reject,
          new Error("Could not read recording metadata. Try a WAV or MP3."),
        ),
      10000,
    );
    const finish = (callback, value) => {
      clearTimeout(timer);
      player.removeEventListener("loadedmetadata", ready);
      player.removeEventListener("error", invalid);
      signal.removeEventListener("abort", cancelled);
      callback(value);
    };
    const ready = () => finish(resolve, player.duration);
    const invalid = () =>
      finish(
        reject,
        new Error(
          "This audio format couldn’t be opened in your browser. Try a WAV or MP3.",
        ),
      );
    const cancelled = () => finish(reject, signal.reason);
    signal.addEventListener("abort", cancelled, { once: true });
    player.addEventListener("loadedmetadata", ready);
    player.addEventListener("error", invalid);
    player.src = recordingUrl;
  });
  if (Number.isFinite(duration) && (duration < 1 || duration > MAX_SECONDS))
    throw new Error(LENGTH_ERROR);
  const bytes = await file.arrayBuffer();
  signal.throwIfAborted();
  const context = new OfflineAudioContext(1, 1, 16000);
  const audio = await context.decodeAudioData(bytes).catch(() => {
    throw new Error("Couldn’t decode this recording. Try a WAV or MP3.");
  });
  signal.throwIfAborted();
  if (audio.duration < 1 || audio.duration > MAX_SECONDS)
    throw new Error(LENGTH_ERROR);
  const samples = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const channel = audio.getChannelData(c);
    for (let i = 0; i < channel.length; i++)
      samples[i] += channel[i] / audio.numberOfChannels;
  }
  return { samples, duration: audio.duration };
}

function infer(samples, signal) {
  worker ??= new Worker(new URL("./speech.worker.js", import.meta.url), {
    type: "module",
  });
  const currentWorker = worker;
  return new Promise((resolve, reject) => {
    let timeout;
    const settle = (error, result) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancelled);
      currentWorker.onmessage = null;
      currentWorker.onerror = null;
      currentWorker.onmessageerror = null;
      if (error) {
        currentWorker.terminate();
        worker = undefined;
        reject(error);
      } else resolve(result);
    };
    const cancelled = () => settle(signal.reason);
    const watchActivity = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        settle(
          new Error(
            "Transcription stopped making progress. Try a shorter recording or another browser.",
          ),
        );
      }, 240000);
    };
    signal.addEventListener("abort", cancelled, { once: true });
    watchActivity();
    currentWorker.onmessage = ({ data }) => {
      watchActivity();
      if (data.phase) status(data.phase);
      if (data.total) {
        progress.max = data.total;
        progress.value = data.completed;
        $("progress-note").textContent =
          `${data.completed} of ${data.total} sections processed`;
      }
      if (data.error) settle(new Error(data.error));
      else if (data.result) settle(null, data.result);
    };
    currentWorker.onerror = () =>
      settle(
        new Error(
          "Couldn’t start the speech model. Try an up-to-date browser.",
        ),
      );
    currentWorker.onmessageerror = () =>
      settle(
        new Error("Couldn’t read the speech model’s response. Please retry."),
      );
    try {
      currentWorker.postMessage({ samples }, [samples.buffer]);
    } catch (error) {
      settle(error);
    }
  });
}

function render() {
  $("segments").replaceChildren(
    ...segments.map((segment, i) => {
      const row = document.createElement("div");
      row.className = "segment";
      const label = document.createElement("label");
      const textarea = document.createElement("textarea");
      textarea.id = `segment-${i}`;
      textarea.value = segment.text;
      textarea.setAttribute("aria-label", `Transcript segment ${i + 1}`);
      label.htmlFor = textarea.id;
      label.textContent =
        timestamp(segment.start).slice(3, 8) +
        " – " +
        timestamp(segment.end).slice(3, 8);
      textarea.addEventListener("input", () => {
        segment.text = textarea.value;
        edited = true;
      });
      row.append(label, textarea);
      return row;
    }),
  );
  $("completed").hidden = false;
}

async function transcribe(loadFile) {
  if (
    busy ||
    (edited && !confirm("Replace this transcript and its current edits?"))
  )
    return;
  reset();
  const job = new AbortController();
  const { signal } = job;
  activeJob = job;
  setBusy(true);
  $("progress-note").textContent = "";
  $("empty-editor").hidden = true;
  status("Reading the recording…");
  try {
    const file = await loadFile(signal);
    signal.throwIfAborted();
    if (!file.size || file.size > MAX_BYTES)
      throw new Error("Choose a non-empty recording up to 50 MB.");
    recordingUrl = URL.createObjectURL(file);
    $("filename").textContent = file.name;
    $("recording-meta").textContent = "English recording";
    $("recording").hidden = false;
    const { samples, duration } = await decode(file, signal);
    $("recording-meta").textContent =
      `${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, "0")} · English`;
    segments = readSegments(await infer(samples, signal), duration);
    if (!segments.length)
      throw new Error(
        "No speech was recognized. Try a clearer English recording.",
      );
    render();
    status("Transcript ready to review.");
  } catch (error) {
    if (signal.aborted) {
      reset();
      status("Transcription stopped. Your file is ready to try again.");
      return;
    }
    $("job-error").textContent =
      error.message || "Unable to transcribe this recording.";
    $("job-error").hidden = false;
  } finally {
    activeJob = undefined;
    setBusy(false);
    if (signal.aborted)
      (input.files.length ? $("transcribe") : $("sample")).focus();
  }
}

function download(extension) {
  const text =
    extension === "srt"
      ? subtitles(segments)
      : segments
          .map((segment) => segment.text.trim())
          .join("\n")
          .trim() + "\n";
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `small-hours-transcript.${extension}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

input.addEventListener("change", () => {
  $("transcribe").disabled = !input.files.length;
});
$("recording-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const file = input.files[0];
  if (file) void transcribe(() => file);
});
$("sample").addEventListener(
  "click",
  () =>
    void transcribe(async (signal) => {
      const response = await fetch("/sample.wav", { signal });
      if (!response.ok)
        throw new Error(
          "The sample could not load. Try again or choose a recording.",
        );
      return new File([await response.blob()], "Small Hours sample.wav", {
        type: "audio/wav",
      });
    }),
);
$("cancel").addEventListener("click", () => activeJob?.abort());
$("clear").addEventListener("click", () => {
  if (edited && !confirm("Clear the recording and your transcript edits?"))
    return;
  reset();
  input.value = "";
  setBusy(false);
  input.focus();
});
$("download-txt").addEventListener("click", () => download("txt"));
$("download-srt").addEventListener("click", () => download("srt"));
