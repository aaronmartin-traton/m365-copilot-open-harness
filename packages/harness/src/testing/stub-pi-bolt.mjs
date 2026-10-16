#!/usr/bin/env node
/**
 * Stand-in for `pi --mode rpc`, used by the harness end-to-end tests and by the
 * web console's tests. It implements exactly the framing the supervisor
 * depends on: LF-delimited JSON records on stdin and stdout, responses that
 * repeat the command id, `message_update` events carrying `text_delta`, a
 * non-text `tool_start` record, and a closing `agent_settled`.
 *
 * A prompt of `hang` (or `STUB_HANG=1`) deliberately never settles, so the
 * turn-timeout path can be exercised without a real model.
 */

function send(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function dispatch(line) {
  const text = line.trim();

  if (text.length === 0) return;

  let command;

  try {
    command = JSON.parse(text);
  } catch {
    send({ type: "response", command: "parse", success: false, error: "Failed to parse command" });

    return;
  }

  if (command.type === "prompt") {
    handlePrompt(command);

    return;
  }

  if (command.type === "abort") {
    send({ id: command.id, type: "response", command: "abort", success: true });
    send({ type: "agent_settled" });

    return;
  }

  if (command.type === "get_state") {
    send({
      id: command.id,
      type: "response",
      command: "get_state",
      success: true,
      data: { model: "stub-model", thinkingLevel: "off" },
    });

    return;
  }

  send({
    id: command.id,
    type: "response",
    command: command.type,
    success: false,
    error: `Unsupported command: ${command.type}`,
  });
}

function handlePrompt(command) {
  const message = command.message ?? "";

  if (message === "hang" || process.env.STUB_HANG === "1") return;

  send({
    id: command.id,
    type: "response",
    command: "prompt",
    success: true,
    data: { disposition: "started" },
  });
  send({ type: "tool_start", tool: "read", input: { path: "README.md" } });

  for (const delta of `stub-reply:${message}`.match(/\s+|\S+/gu) ?? []) {
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
  }

  send({ type: "agent_settled" });
}

let buffer = "";

process.stdin.setEncoding("utf8");

process.stdin.on("data", (chunk) => {
  buffer += chunk;

  let boundary = buffer.indexOf("\n");

  while (boundary !== -1) {
    const line = buffer.slice(0, boundary);

    buffer = buffer.slice(boundary + 1);
    dispatch(line);
    boundary = buffer.indexOf("\n");
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
