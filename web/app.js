const $ = (id) => document.getElementById(id);
let jobs = [],
  selected = null,
  draft = [],
  dirty = false,
  revision = 0,
  saving = false,
  polling = false,
  rendered = "";
const showNotice = (message) => {
  $("notice").textContent = message;
  $("notice").hidden = false;
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => ($("notice").hidden = true), 7000);
};
async function api(path, options = {}) {
  const response = await fetch("/api" + path, options);
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      typeof result.detail === "string"
        ? result.detail
        : "This request could not be completed.",
    );
  return result;
}
function timecode(seconds) {
  return (
    Math.floor(seconds / 60) +
    ":" +
    String(Math.floor(seconds % 60)).padStart(2, "0")
  );
}
function renderJobs() {
  $("job-count").textContent = jobs.length;
  $("jobs").replaceChildren();
  if (!jobs.length) {
    const empty = document.createElement("p");
    empty.className = "empty-library";
    empty.textContent = "Your recordings will appear here.";
    $("jobs").append(empty);
  }
  for (const job of jobs) {
    const button = document.createElement("button");
    button.className = "job" + (selected === job.id ? " active" : "");
    button.setAttribute("aria-pressed", String(selected === job.id));
    const title = document.createElement("strong");
    title.textContent = job.filename;
    const meta = document.createElement("small"),
      status = document.createElement("span"),
      duration = document.createElement("span");
    status.textContent = job.status;
    status.className = "state-" + job.status;
    duration.textContent = timecode(job.duration);
    meta.append(status, duration);
    button.append(title, meta);
    button.onclick = () => {
      if (
        dirty &&
        !confirm("Leave this transcript without saving your changes?")
      )
        return;
      selected = job.id;
      dirty = false;
      renderJobs();
      renderRecording(job);
    };
    $("jobs").append(button);
  }
}
function renderRecording(job) {
  rendered = `${job.id}:${job.status}:${job.revision}`;
  $("empty-editor").hidden = true;
  $("recording").hidden = false;
  $("filename").textContent = job.filename;
  $("recording-meta").textContent =
    `${timecode(job.duration)} · English · ${job.status}`;
  const audio = "/api/jobs/" + job.id + "/audio";
  if ($("player").getAttribute("src") !== audio) $("player").src = audio;
  $("processing").hidden = !["queued", "processing"].includes(job.status);
  $("phase").textContent = job.phase;
  $("failed").hidden = job.status !== "failed";
  $("job-error").textContent = job.error || "";
  $("completed").hidden = job.status !== "completed";
  if (job.status === "completed" && !dirty) {
    draft = job.segments.map((s) => s.text);
    revision = job.revision;
    $("segments").replaceChildren();
    job.segments.forEach((segment, i) => {
      const row = document.createElement("div");
      row.className = "segment";
      const label = document.createElement("label");
      label.htmlFor = "segment-" + i;
      label.textContent =
        timecode(segment.start) + " – " + timecode(segment.end);
      const input = document.createElement("textarea");
      input.id = "segment-" + i;
      input.value = segment.text;
      input.setAttribute("aria-label", "Transcript segment " + (i + 1));
      input.oninput = () => {
        draft[i] = input.value;
        dirty = true;
        $("save").textContent = "Save changes";
      };
      row.append(label, input);
      $("segments").append(row);
    });
    $("save").textContent = "Saved";
    $("download-txt").href = "/api/jobs/" + job.id + "/export?format=txt";
    $("download-srt").href = "/api/jobs/" + job.id + "/export?format=srt";
  }
}
async function refresh() {
  if (polling || document.hidden) return;
  polling = true;
  try {
    jobs = await api("/jobs");
    renderJobs();
    const job = jobs.find((j) => j.id === selected);
    if (
      job &&
      !dirty &&
      !saving &&
      rendered !== `${job.id}:${job.status}:${job.revision}`
    )
      renderRecording(job);
    if (selected && !job) {
      selected = null;
      dirty = false;
      $("recording").hidden = true;
      $("empty-editor").hidden = false;
    }
  } catch (e) {
    showNotice(e.message);
  } finally {
    polling = false;
  }
}
$("upload-form").onsubmit = async (event) => {
  event.preventDefault();
  const file = $("audio-file").files[0];
  if (!file) return;
  if (file.size > 20 * 1024 * 1024)
    return showNotice("Choose a recording smaller than 20 MB.");
  if (dirty && !confirm("Leave this transcript without saving your changes?"))
    return;
  $("upload-button").disabled = true;
  try {
    const data = new FormData();
    data.append("file", file);
    const job = await api("/jobs", { method: "POST", body: data });
    selected = job.id;
    dirty = false;
    $("audio-file").value = "";
    await refresh();
    showNotice("Recording added to the local queue.");
  } catch (e) {
    showNotice(e.message);
  } finally {
    $("upload-button").disabled = false;
  }
};
$("save").onclick = async () => {
  if (!selected || saving) return;
  saving = true;
  $("save").disabled = true;
  try {
    const job = await api("/jobs/" + selected + "/transcript", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts: draft, revision }),
    });
    dirty = false;
    renderRecording(job);
    showNotice("Transcript saved. Downloads include your edits.");
  } catch (e) {
    showNotice(e.message);
  } finally {
    saving = false;
    $("save").disabled = false;
  }
};
$("delete").onclick = async () => {
  if (
    !selected ||
    !confirm(
      "Delete this recording, its audio and transcript from the local app?",
    )
  )
    return;
  try {
    await api("/jobs/" + selected, { method: "DELETE" });
    selected = null;
    dirty = false;
    $("recording").hidden = true;
    $("empty-editor").hidden = false;
    $("player").pause();
    $("player").removeAttribute("src");
    await refresh();
    showNotice("Recording and transcript deleted.");
  } catch (e) {
    showNotice(e.message);
  }
};
$("retry").onclick = async () => {
  try {
    await api("/jobs/" + selected + "/retry", { method: "POST" });
    await refresh();
  } catch (e) {
    showNotice(e.message);
  }
};
for (const id of ["download-txt", "download-srt"])
  $(id).onclick = (event) => {
    if (dirty) {
      event.preventDefault();
      showNotice("Save your edits before downloading.");
    }
  };
window.addEventListener("beforeunload", (event) => {
  if (dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});
document.addEventListener("visibilitychange", refresh);
refresh();
setInterval(() => {
  if (jobs.some((j) => ["queued", "processing"].includes(j.status))) refresh();
}, 1500);
