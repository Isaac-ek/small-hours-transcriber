import { BaseStreamer, env, pipeline } from "@huggingface/transformers";

const model = "Xenova/whisper-tiny.en";
const revision = "79fb389fc764e7c395bd330e9531d9d32ada7049";
env.allowLocalModels = false;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
// Use the version-matched WASM emitted by Vite, not a third-party JS CDN.
env.backends.onnx.wasm.wasmPaths = {};
let transcribe;

self.onmessage = async ({ data: { samples } }) => {
  try {
    if (!transcribe) {
      self.postMessage({ phase: "Downloading the speech model…" });
      transcribe = await pipeline("automatic-speech-recognition", model, {
        revision,
        dtype: "q8",
        device: "wasm",
      });
    }
    const windowSeconds = 25;
    const overlapSeconds = 4;
    const sampleRate = 16000;
    // One generation completes per overlapping window in the Whisper pipeline.
    // Leave timestamp stitching and overlap handling to the same pipeline used for short files.
    const total =
      1 +
      Math.ceil(
        Math.max(0, samples.length - windowSeconds * sampleRate) /
          ((windowSeconds - 2 * overlapSeconds) * sampleRate),
      );
    let completed = 0;
    self.postMessage({
      phase: "Transcribing on your device…",
      completed,
      total,
    });
    const result = await transcribe(samples, {
      return_timestamps: true,
      chunk_length_s: windowSeconds,
      stride_length_s: overlapSeconds,
      streamer: new (class extends BaseStreamer {
        put() {}
        end() {
          self.postMessage({ completed: ++completed, total });
        }
      })(),
    });
    self.postMessage({ result });
  } catch (error) {
    console.error(error);
    self.postMessage({
      error:
        "Could not finish transcription. Check your connection, then retry in an up-to-date browser.",
    });
  }
};
