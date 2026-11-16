import threading
import time
from fastapi.testclient import TestClient
from app import create_app, timestamp

ORIGIN = {"origin": "http://testserver"}


class Engine:
    def __init__(self, fail=False):
        self.fail = fail

    def transcribe(self, path):
        if self.fail:
            raise ValueError("The recording was unclear.")
        return [{"start": 0.0, "end": 1.5, "text": "A short recording."}]


def upload(client, name="note.wav", content=b"audio"):
    return client.post(
        "/api/jobs", headers=ORIGIN, files={"file": (name, content, "audio/wav")}
    )


def wait(client, job_id, status):
    for _ in range(100):
        job = client.get("/api/jobs/" + job_id).json()
        if job["status"] == status:
            return job
        time.sleep(0.02)
    raise AssertionError(f"Expected {status}, got {job}")


def test_queue_edit_export_and_delete_remove_recording(tmp_path):
    app = create_app(tmp_path, Engine(), probe=lambda p: 1.5)
    with TestClient(app) as client:
        result = upload(client, "../../note.wav")
        assert result.status_code == 201
        job = wait(client, result.json()["id"], "completed")
        assert job["filename"] == "note.wav"
        assert "audio_path" not in job
        updated = client.put(
            "/api/jobs/" + job["id"] + "/transcript",
            headers=ORIGIN,
            json={"texts": ["My corrected transcript."], "revision": 0},
        )
        assert updated.status_code == 200
        assert updated.json()["revision"] == 1
        assert (
            client.put(
                "/api/jobs/" + job["id"] + "/transcript",
                headers=ORIGIN,
                json={"texts": ["stale"], "revision": 0},
            ).status_code
            == 409
        )
        txt = client.get("/api/jobs/" + job["id"] + "/export?format=txt")
        srt = client.get("/api/jobs/" + job["id"] + "/export?format=srt")
        assert txt.text == "My corrected transcript.\n"
        assert "00:00:00,000 --> 00:00:01,500" in srt.text
        assert "My corrected transcript." in srt.text
        assert client.get("/api/jobs/" + job["id"] + "/audio").content == b"audio"
        assert (
            client.delete("/api/jobs/" + job["id"], headers=ORIGIN).status_code == 200
        )
        assert client.get("/api/jobs/" + job["id"]).status_code == 404
        assert list(app.state.store.audio.iterdir()) == []


def test_failure_is_visible_and_retry_can_complete(tmp_path):
    engine = Engine(fail=True)
    with TestClient(create_app(tmp_path, engine, probe=lambda p: 1)) as client:
        job = upload(client).json()
        failed = wait(client, job["id"], "failed")
        assert "unclear" in failed["error"]
        assert client.get("/api/jobs/" + job["id"] + "/export").status_code == 409
        engine.fail = False
        assert (
            client.post("/api/jobs/" + job["id"] + "/retry", headers=ORIGIN).status_code
            == 200
        )
        assert wait(client, job["id"], "completed")["error"] is None


def test_invalid_uploads_leave_no_files_and_foreign_writes_are_blocked(tmp_path):
    def invalid_probe(path):
        raise ValueError("Audio exceeds two minutes.")

    app = create_app(tmp_path, Engine(), probe=invalid_probe)
    with TestClient(app) as client:
        assert upload(client, "file.exe").status_code == 400
        assert upload(client, content=b"").status_code == 400
        assert upload(client).status_code == 400
        assert list(app.state.store.audio.iterdir()) == []
        assert (
            client.post(
                "/api/jobs",
                headers={"origin": "https://foreign.example"},
                files={"file": ("a.wav", b"a")},
            ).status_code
            == 403
        )
        assert (
            client.get("/api/jobs", headers={"host": "foreign.example"}).status_code
            == 403
        )


def test_restart_recovers_interrupted_processing_job(tmp_path):
    app = create_app(tmp_path, Engine(), probe=lambda p: 1)
    with TestClient(app) as client:
        job = upload(client).json()
        wait(client, job["id"], "completed")
    with app.state.store.db() as db:
        db.execute("UPDATE jobs SET status='processing' WHERE id=?", (job["id"],))
    with TestClient(create_app(tmp_path, Engine(), probe=lambda p: 1)) as client:
        assert (
            wait(client, job["id"], "completed")["segments"][0]["text"]
            == "A short recording."
        )


def test_transcript_survives_restart_and_bad_edit_cannot_replace_segments(tmp_path):
    app = create_app(tmp_path, Engine(), probe=lambda p: 1)
    with TestClient(app) as client:
        job = upload(client).json()
        wait(client, job["id"], "completed")
        assert (
            client.put(
                "/api/jobs/" + job["id"] + "/transcript",
                headers=ORIGIN,
                json={"texts": [], "revision": 0},
            ).status_code
            == 400
        )
        client.put(
            "/api/jobs/" + job["id"] + "/transcript",
            headers=ORIGIN,
            json={"texts": ["Saved after restart"], "revision": 0},
        )
    with TestClient(create_app(tmp_path, Engine(), probe=lambda p: 1)) as client:
        assert (
            client.get("/api/jobs/" + job["id"] + "/export").text
            == "Saved after restart\n"
        )
    assert timestamp(3661.234) == "01:01:01,234"
