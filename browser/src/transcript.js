export function timestamp(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return (
    [
      Math.floor(ms / 3600000),
      Math.floor(ms / 60000) % 60,
      Math.floor(ms / 1000) % 60,
    ]
      .map((part) => String(part).padStart(2, "0"))
      .join(":") +
    "," +
    String(ms % 1000).padStart(3, "0")
  );
}

export function readSegments(output, duration) {
  const chunks = (output.chunks ?? []).flatMap(
    ({ timestamp: [start, end], text }) => {
      if (!text.trim() || !Number.isFinite(start) || start >= duration)
        return [];
      start = Math.max(0, start);
      end = Math.min(duration, end ?? duration);
      return end > start ? [{ start, end, text: text.trim() }] : [];
    },
  );
  return chunks.length
    ? chunks
    : output.text?.trim()
      ? [{ start: 0, end: duration, text: output.text.trim() }]
      : [];
}

export function subtitles(segments) {
  return (
    segments
      .filter(({ text }) => text.trim())
      .map(
        ({ start, end, text }, i) =>
          `${i + 1}\n${timestamp(start)} --> ${timestamp(end)}\n${text.trim().replace(/\r?\n\s*\n+/g, "\n")}`,
      )
      .join("\n\n") + "\n"
  );
}
