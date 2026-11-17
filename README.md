# Small Hours

Small Hours has two editions: a public browser transcriber and the local Python workspace below.

## Browser edition

Run `npm ci --prefix browser` and `npm run dev --prefix browser`, or build with `npm run build --prefix browser`. Vercel uses `browser/` as its project root and publishes the static Vite output.

The browser edition runs English Whisper tiny.en through Transformers.js in a Web Worker. It downloads the pinned model from Hugging Face on first use and keeps audio and edits in the open tab. You can try the original synthetic sample or select a recording, edit timestamped segments, and download TXT/SRT without an account. It does not use the Python API or retain a recording library.

Run the production-build browser check with `npx playwright test --config playwright.hosted.config.ts` after installing Playwright Chromium. Set `SMALL_HOURS_ORIGIN` to test a hosted deployment.

## Local Python edition

A local English audio transcriber by Chiemelie Ekezie. Upload a short recording, follow its queue status, edit timestamped transcript segments, then download text or SRT subtitles. Audio, jobs and edits persist in SQLite on your computer. No paid API or cloud account is needed.

## Run

Python 3.12 and FFmpeg (`ffprobe` on PATH) are required.

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py
```

Open http://127.0.0.1:8190. The first transcription downloads the open-source `tiny.en` model from Hugging Face into `.models/`. Subsequent processing runs on CPU locally. Downloading the model needs internet; it is not a paid transcription API. Actual speed and accuracy depend on your computer and recording.

## Scope

- English recordings up to 2 minutes / 20 MB, up to 100 saved recordings and 5 pending jobs.
- Durable SQLite queue, one CPU worker, explicit failure/retry states and restart recovery for interrupted jobs.
- Edited text retains segment timestamps; both TXT and SRT downloads use saved edits. Revision checks prevent stale tabs overwriting newer edits.
- Delete removes the job and its stored recording. No automatic retention expiry: delete recordings you no longer need.
- Listens only on loopback, checks local host/origin and uses same-origin assets. This is a single-user local application with no account isolation. Do not expose this server publicly or call it a hosted multi-user product.
- SQLite files, recordings, model downloads and environment files are ignored by Git. Do not commit personal recordings.
- The model is [faster-whisper](https://github.com/SYSTRAN/faster-whisper), using Whisper `tiny.en`, CPU/int8. Model inference can make mistakes; review names and numbers.

## Test

```sh
.venv/bin/python -m pytest -q
```

The API tests inject a deterministic engine to cover queue, edit, failure, retry, deletion and isolation from foreign origins. A separate real-model smoke check is described in `docs/testing.md`; simulated tests are not reported as transcription accuracy evidence.

## Engineering notes

See [architecture](docs/architecture.md) for the queue, failure/recovery and editing decisions, and [testing](docs/testing.md) for real-model verification and the pending three-person usability exercise. GitHub Actions runs API tests plus a real synthetic recording through the model and browser. The local Python edition is not deployed to Vercel.
