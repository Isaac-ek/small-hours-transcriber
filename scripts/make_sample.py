"""Create an original test recording with local text-to-speech (no API calls)."""

from pathlib import Path
import shutil
import subprocess

root = Path(__file__).resolve().parents[1]
runtime = root / ".runtime"
runtime.mkdir(exist_ok=True)
text = "This is a local transcription test. We are building a small product that turns voice notes into text. Please review the transcript before sharing it."
if shutil.which("say"):
    source = runtime / "sample.aiff"
    subprocess.run(["say", "-o", str(source), text], check=True)
elif shutil.which("espeak"):
    source = runtime / "sample-source.wav"
    subprocess.run(["espeak", "-w", str(source), text], check=True)
else:
    raise SystemExit("Install a local text-to-speech tool: macOS say or Linux espeak.")
subprocess.run(
    [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-ac",
        "1",
        "-ar",
        "16000",
        str(runtime / "sample.wav"),
    ],
    check=True,
)
print("Created original synthetic speech fixture: .runtime/sample.wav")
