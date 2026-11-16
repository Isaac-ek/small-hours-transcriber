"""Local audio transcription with a durable, single-worker SQLite job queue."""

from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
import json
import logging
import math
import os
import sqlite3
import subprocess
import threading
import time
import uuid

from fastapi import FastAPI, HTTPException, Request, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE = Path(__file__).resolve().parent
MAX_BYTES = 20 * 1024 * 1024
MAX_SECONDS = 120
EXTENSIONS = {".wav", ".mp3", ".m4a", ".mp4", ".webm", ".ogg", ".flac"}
log = logging.getLogger("transcriber")


class Store:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.audio = self.root / "audio"
        self.audio.mkdir(exist_ok=True, mode=0o700)
        self.path = self.root / "jobs.sqlite"
        with self.db() as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY)"
            )
            if not db.execute("SELECT 1 FROM migrations WHERE version=1").fetchone():
                db.execute(
                    'CREATE TABLE jobs (id TEXT PRIMARY KEY, filename TEXT NOT NULL, audio_path TEXT NOT NULL, duration REAL NOT NULL, status TEXT NOT NULL, phase TEXT NOT NULL, error TEXT, segments TEXT NOT NULL DEFAULT "[]", revision INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL, updated_at REAL NOT NULL)'
                )
                db.execute("INSERT INTO migrations VALUES (1)")
        os.chmod(self.path, 0o600)

    @contextmanager
    def db(self):
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def get(self, job_id):
        with self.db() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Recording not found.")
        return self.public(row)

    @staticmethod
    def public(row):
        data = dict(row)
        data.pop("audio_path", None)
        data["segments"] = json.loads(data["segments"])
        return data


class SpeechEngine:
    def __init__(self, model_dir):
        self.model_dir, self.model = model_dir, None

    def transcribe(self, path):
        if self.model is None:
            from faster_whisper import WhisperModel

            self.model = WhisperModel(
                "tiny.en",
                device="cpu",
                compute_type="int8",
                cpu_threads=4,
                num_workers=1,
                download_root=str(self.model_dir),
            )
        segments, _ = self.model.transcribe(
            str(path), language="en", beam_size=3, condition_on_previous_text=False
        )
        return [
            {"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip()}
            for s in segments
        ]


class Worker:
    def __init__(self, store, engine):
        self.store, self.engine = store, engine
        self.wake, self.stop = threading.Event(), threading.Event()
        self.thread = threading.Thread(
            target=self.run, daemon=True, name="transcription-worker"
        )

    def start(self):
        with self.store.db() as db:
            db.execute(
                "UPDATE jobs SET status='queued',phase='Recovered after restart' WHERE status='processing'"
            )
        self.thread.start()
        self.wake.set()

    def run(self):
        while not self.stop.is_set():
            with self.store.db() as db:
                db.execute("BEGIN IMMEDIATE")
                row = db.execute(
                    "SELECT * FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1"
                ).fetchone()
                if row:
                    db.execute(
                        "UPDATE jobs SET status='processing',phase='Preparing model and transcribing',updated_at=? WHERE id=?",
                        (time.time(), row["id"]),
                    )
            if not row:
                self.wake.wait(1)
                self.wake.clear()
                continue
            try:
                segments = self.engine.transcribe(row["audio_path"])
                if not segments:
                    raise ValueError(
                        "No speech was recognized. Try a clearer recording."
                    )
                with self.store.db() as db:
                    db.execute(
                        "UPDATE jobs SET status='completed',phase='Ready to review',segments=?,error=NULL,updated_at=? WHERE id=?",
                        (json.dumps(segments), time.time(), row["id"]),
                    )
            except Exception as error:
                log.warning(
                    "Transcription failed for %s: %s", row["id"], type(error).__name__
                )
                message = (
                    str(error)
                    if isinstance(error, ValueError)
                    else "Transcription could not finish. Check the model download/network on first use, then retry."
                )
                with self.store.db() as db:
                    db.execute(
                        "UPDATE jobs SET status='failed',phase='Needs attention',error=?,updated_at=? WHERE id=?",
                        (message, time.time(), row["id"]),
                    )

    def close(self):
        self.stop.set()
        self.wake.set()
        self.thread.join(timeout=3)


def duration_of(path):
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "format=duration:stream=codec_type",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        )
        metadata = json.loads(result.stdout)
        if not metadata.get("streams"):
            raise ValueError("Choose a recording that contains an audio track.")
        duration = float(metadata["format"]["duration"])
        if not math.isfinite(duration) or duration < 1 or duration > MAX_SECONDS:
            raise ValueError("Choose a recording between 1 second and 2 minutes.")
        return duration
    except ValueError:
        raise
    except Exception as error:
        raise ValueError(
            "This file could not be read as audio. Choose a supported recording."
        ) from error


class TranscriptEdit(BaseModel):
    texts: list[str] = Field(max_length=500)
    revision: int = Field(ge=0)


def timestamp(seconds):
    millis = round(seconds * 1000)
    hours, millis = divmod(millis, 3600000)
    minutes, millis = divmod(millis, 60000)
    seconds, millis = divmod(millis, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{millis:03}"


def create_app(root=None, engine=None, probe=duration_of):
    store = Store(root or os.environ.get("TRANSCRIBER_DATA", BASE / ".data"))
    worker = Worker(store, engine or SpeechEngine(BASE / ".models"))

    @asynccontextmanager
    async def lifespan(app):
        worker.start()
        yield
        worker.close()

    app = FastAPI(title="Small Hours — local transcriber", lifespan=lifespan)
    app.state.store, app.state.worker = store, worker

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        host = request.url.hostname
        if host not in {"127.0.0.1", "localhost", "testserver"}:
            return JSONResponse(
                {"detail": "This application is local-only."}, status_code=403
            )
        if request.method not in {"GET", "HEAD"}:
            origin = request.headers.get("origin")
            allowed = {
                str(request.base_url).rstrip("/"),
                "http://127.0.0.1:8190",
                "http://localhost:8190",
                "http://testserver",
            }
            if origin not in allowed:
                return JSONResponse(
                    {"detail": "Open this local application to make changes."},
                    status_code=403,
                )
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
        )
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/api/health")
    def health():
        return {
            "status": "ok",
            "engine": "faster-whisper / tiny.en / CPU int8",
            "max_seconds": MAX_SECONDS,
            "local_only": True,
        }

    @app.get("/api/jobs")
    def jobs():
        with store.db() as db:
            rows = db.execute(
                "SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100"
            ).fetchall()
        return [store.public(row) for row in rows]

    @app.post("/api/jobs", status_code=201)
    async def upload(file: UploadFile = File(...)):
        filename = Path((file.filename or "recording").replace("\\", "/")).name[:180]
        extension = Path(filename).suffix.lower()
        if extension not in EXTENSIONS:
            raise HTTPException(400, "Use WAV, MP3, M4A, MP4, WebM, OGG or FLAC.")
        with store.db() as db:
            if db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] >= 100:
                raise HTTPException(
                    409, "Keep up to 100 recordings. Delete an older recording first."
                )
            if (
                db.execute(
                    "SELECT COUNT(*) FROM jobs WHERE status IN ('queued','processing')"
                ).fetchone()[0]
                >= 5
            ):
                raise HTTPException(
                    409, "Five recordings are already waiting. Let them finish first."
                )
        job_id = str(uuid.uuid4())
        path = store.audio / (job_id + extension)
        size = 0
        try:
            with path.open("xb") as stream:
                os.chmod(path, 0o600)
                while chunk := await file.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise HTTPException(
                            413, "Choose a recording smaller than 20 MB."
                        )
                    stream.write(chunk)
            if not size:
                raise HTTPException(400, "The recording is empty.")
            try:
                duration = probe(path)
            except ValueError as error:
                raise HTTPException(400, str(error)) from error
            now = time.time()
            with store.db() as db:
                db.execute("BEGIN IMMEDIATE")
                if (
                    db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] >= 100
                    or db.execute(
                        "SELECT COUNT(*) FROM jobs WHERE status IN ('queued','processing')"
                    ).fetchone()[0]
                    >= 5
                ):
                    raise HTTPException(
                        409,
                        "Recording limit reached while uploading. Let pending jobs finish or delete an older recording.",
                    )
                db.execute(
                    "INSERT INTO jobs(id,filename,audio_path,duration,status,phase,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
                    (
                        job_id,
                        filename,
                        str(path),
                        duration,
                        "queued",
                        "Waiting for the local worker",
                        now,
                        now,
                    ),
                )
            worker.wake.set()
            return store.get(job_id)
        except Exception:
            path.unlink(missing_ok=True)
            raise
        finally:
            await file.close()

    @app.get("/api/jobs/{job_id}")
    def job(job_id: str):
        return store.get(job_id)

    @app.get("/api/jobs/{job_id}/audio")
    def audio(job_id: str):
        store.get(job_id)
        with store.db() as db:
            path = db.execute(
                "SELECT audio_path FROM jobs WHERE id=?", (job_id,)
            ).fetchone()["audio_path"]
        return FileResponse(path)

    @app.put("/api/jobs/{job_id}/transcript")
    def edit(job_id: str, payload: TranscriptEdit):
        with store.db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                raise HTTPException(404, "Recording not found.")
            if row["status"] != "completed":
                raise HTTPException(409, "Wait for transcription to finish.")
            if row["revision"] != payload.revision:
                raise HTTPException(
                    409,
                    "This transcript changed in another tab. Reload it before saving.",
                )
            segments = json.loads(row["segments"])
            if (
                len(payload.texts) != len(segments)
                or sum(len(t) for t in payload.texts) > 50000
            ):
                raise HTTPException(
                    400, "Keep the existing segments and use up to 50,000 characters."
                )
            for segment, text in zip(segments, payload.texts):
                segment["text"] = text.strip()
            db.execute(
                "UPDATE jobs SET segments=?,revision=revision+1,updated_at=? WHERE id=?",
                (json.dumps(segments), time.time(), job_id),
            )
        return store.get(job_id)

    @app.post("/api/jobs/{job_id}/retry")
    def retry(job_id: str):
        with store.db() as db:
            changed = db.execute(
                "UPDATE jobs SET status='queued',phase='Waiting to retry',error=NULL,updated_at=? WHERE id=? AND status='failed'",
                (time.time(), job_id),
            ).rowcount
        if not changed:
            store.get(job_id)
            raise HTTPException(409, "Only failed recordings can be retried.")
        worker.wake.set()
        return store.get(job_id)

    @app.delete("/api/jobs/{job_id}")
    def delete(job_id: str):
        with store.db() as db:
            row = db.execute(
                "SELECT audio_path FROM jobs WHERE id=?", (job_id,)
            ).fetchone()
            if not row:
                raise HTTPException(404, "Recording not found.")
            db.execute("DELETE FROM jobs WHERE id=?", (job_id,))
        Path(row["audio_path"]).unlink(missing_ok=True)
        return {"ok": True}

    @app.get("/api/jobs/{job_id}/export")
    def export(job_id: str, format: str = "txt"):
        recording = store.get(job_id)
        if recording["status"] != "completed":
            raise HTTPException(409, "Wait for the transcript before exporting.")
        segments = recording["segments"]
        if format == "txt":
            text = "\n".join(s["text"] for s in segments) + "\n"
            media_type = "text/plain"
        elif format == "srt":
            text = (
                "\n\n".join(
                    f"{i}\n{timestamp(s['start'])} --> {timestamp(s['end'])}\n{s['text']}"
                    for i, s in enumerate(segments, 1)
                )
                + "\n"
            )
            media_type = "application/x-subrip"
        else:
            raise HTTPException(400, "Choose txt or srt.")
        return Response(
            text,
            media_type=media_type,
            headers={
                "Content-Disposition": f'attachment; filename="transcript-{job_id}.{format}"'
            },
        )

    app.mount("/", StaticFiles(directory=BASE / "web", html=True), name="web")
    return app


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        create_app(),
        host="127.0.0.1",
        port=int(os.environ.get("TRANSCRIBER_PORT", "8190")),
    )
