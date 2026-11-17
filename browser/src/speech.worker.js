import { env, pipeline } from "@huggingface/transformers";

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
    self.postMessage({ phase: "Transcribing on your device…" });
    const result = await transcribe(samples, {
      return_timestamps: true,
      chunk_length_s: 25,
      stride_length_s: 4,
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
