const TRANSCRIPT = document.getElementById("transcript");

const STATUS = document.getElementById("status");

const PROMPT = document.getElementById("prompt");

const COMPOSER = document.getElementById("composer");

const NEW_SESSION = document.getElementById("new-session");

let socket = null;

let stream = null;

function setStatus(text, tone) {
  STATUS.textContent = text;
  STATUS.dataset.tone = tone;
}

function appendLine(role, text) {
  const line = document.createElement("p");

  line.className = role;
  line.textContent = text;
  TRANSCRIPT.append(line);

  return line;
}

function scrollToEnd() {
  TRANSCRIPT.scrollTop = TRANSCRIPT.scrollHeight;
}

function summarizeRecord(record) {
  if (record.type === "tool_start") return `tool · ${record.tool ?? "unknown"}`;

  return record.type;
}

function renderEvent(event) {
  if (event.kind === "text") {
    if (!stream) stream = appendLine("assistant", "");

    stream.textContent += event.delta;
    scrollToEnd();

    return;
  }

  if (event.kind === "record" || event.kind === "stderr" || event.kind === "malformed") {
    appendLine("trace", event.kind === "record" ? summarizeRecord(event.record) : event.line);
    scrollToEnd();

    return;
  }

  if (event.kind === "response" && !event.success) {
    appendLine("error", `pi: ${event.error ?? "command failed"}`);
    scrollToEnd();

    return;
  }

  if (event.kind === "settled") {
    stream = null;
    setStatus(`Session ${socket ? "ready" : "idle"}`, "idle");

    return;
  }

  if (event.kind === "exit") {
    stream = null;
    setStatus(`Pi-Bolt exited (code ${event.code})`, "error");
  }
}

function connect(sessionId) {
  socket = new WebSocket(`ws://${location.host}/ws?session=${encodeURIComponent(sessionId)}`);

  socket.addEventListener("message", (message) => {
    renderEvent(JSON.parse(message.data));
  });
  socket.addEventListener("close", () => {
    setStatus("Disconnected", "error");
  });
}

async function startSession() {
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  if (!response.ok) {
    setStatus(`Could not start a session: ${response.status}`, "error");

    return;
  }

  const session = await response.json();

  stream = null;
  TRANSCRIPT.replaceChildren();
  connect(session.id);
  setStatus(`Session ${session.id.slice(0, 8)} · ${session.model ?? "default model"}`, "idle");
  PROMPT.focus();
}

COMPOSER.addEventListener("submit", (event) => {
  event.preventDefault();

  const message = PROMPT.value.trim();

  if (message.length === 0 || !socket || socket.readyState !== WebSocket.OPEN) return;

  stream = null;
  socket.send(JSON.stringify({ type: "prompt", message }));
  appendLine("user", message);
  PROMPT.value = "";
  setStatus("Working…", "busy");
  scrollToEnd();
});

NEW_SESSION.addEventListener("click", () => {
  void startSession();
});

void startSession();
