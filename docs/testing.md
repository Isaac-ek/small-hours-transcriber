# Verification and first testers

## Backend checks

`pytest` injects a deterministic speech engine to verify queue states, edited export, stale-save conflicts, failure/retry, unsafe-origin rejection, invalid upload cleanup, file deletion and restart recovery. Those tests do not measure speech recognition accuracy.

## Actual speech and browser workflow

```sh
.venv/bin/python scripts/make_sample.py
npm ci
npx playwright install chromium
npm run test:e2e
```

The sample generator uses local macOS `say` or Linux `espeak`, plus FFmpeg. It creates original synthetic speech in ignored `.runtime/`; it does not download someone else's recording. The browser suite starts an isolated local server/database on port 8191, runs the real `tiny.en` model, edits the recognized text, verifies TXT/SRT downloads, reloads the saved edit, checks a phone viewport, and deletes the recording. The model's original text is attached to the test result, separately from edited text.

`PLAYWRIGHT_CHROMIUM_CHANNEL=chrome npm run test:e2e` uses an installed Chrome. The first model load may need internet to fetch the open-source model. No paid service is called.

`faster-whisper==1.2.1` is paired with PyAV 18.1.0: PyAV 19 removed `metadata_errors`, still passed by that released speech library. This compatibility constraint is pinned; see the [upstream issue](https://github.com/SYSTRAN/faster-whisper/issues/1589).

## Real people (pending)

Aim for three volunteers to try their own short, non-sensitive English recording locally. No invitations have been sent, no user sessions have been observed, and no accuracy percentage is claimed.

1. Upload a short voice note and explain the processing status.
2. Compare names/numbers against the audio and correct a segment.
3. Download text and subtitles; confirm they include saved corrections.
4. Reload, find the recording and delete it.
5. Try the same task on a narrow viewport.

Record anonymously: task completed unaided, point of confusion, exact feedback, observed transcription mistakes, proposed change and retest result. Actual speech accuracy varies with accent, noise and vocabulary; evaluate those cases before describing the model's quality in a portfolio.
