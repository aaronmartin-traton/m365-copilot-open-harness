# Client-attestation adapters

These adapters make the local harness the final authority for one exact `bash`
command. The proxy does not run the command.

The hook asks for approval. It sends the command digest to the loopback proxy.
If the proxy denies or cannot answer, the hook blocks the command.

## 1. Configure the proxy

Set the same secret in the proxy process and in the harness environment. Keep
it out of prompts and tool arguments.

```text
M365_CLIENT_ATTESTATION=1
M365_ATTESTATION_SECRET=<random shared secret>
```

The helper also needs this value:

```text
M365_ATTESTATION_URL=http://127.0.0.1:<proxy-port>
M365_ATTESTATION_SECRET=<same random shared secret>
```

The helper only posts to loopback HTTP. It adds `/v1/attestations` itself.

## 2. Add the provider headers

These headers select the opt-in path. A request without both headers keeps the
normal 8H verifier path. Send them on **every** request in the conversation.
The tool-result request must carry them too. Without them the proxy rejects
the result with 409 `attestation_required`.

### pi — `~/.pi/agent/models.json`

```json
{
  "providers": {
    "m365-proxy": {
      "baseUrl": "http://127.0.0.1:<port>/v1",
      "api": "openai-completions",
      "apiKey": "dummy",
      "headers": {
        "X-M365-Execution-Gate": "attestation-v1",
        "X-M365-Attestation-Client": "pi"
      },
      "models": [{ "id": "<model-id>" }]
    }
  }
}
```

pi needs an `apiKey` value to list a custom provider. `dummy` is sufficient for
a keyless local proxy.

### Oh My Pi — `~/.omp/agent/models.yml`

```yaml
providers:
  m365-proxy:
    baseUrl: http://127.0.0.1:<port>/v1
    api: openai-completions
    auth: none
    headers:
      X-M365-Execution-Gate: attestation-v1
      X-M365-Attestation-Client: omp
    models:
      - id: <model-id>
```

### Codex — `~/.codex/config.toml`

```toml
model = "<model-id>"
model_provider = "m365"

[model_providers.m365]
name = "M365 Copilot Proxy"
base_url = "http://127.0.0.1:<port>/v1"
wire_api = "responses"
http_headers = { "X-M365-Execution-Gate" = "attestation-v1", "X-M365-Attestation-Client" = "codex" }
```

Put `model_providers` in the user config. Codex ignores it in a project
`.codex/config.toml` file.

## 3. Load the hook

Keep each wrapper beside `attestation-helper.mjs` so its relative import works.

| Client | Install |
|---|---|
| pi | `pi --extension <absolute-path>/pi-attestation-gate.ts` |
| Oh My Pi | `omp --hook <absolute-path>/omp-attestation-gate.ts` |
| Codex | Copy the `PreToolUse` entry from `codex-hooks.json` into `~/.codex/hooks.json`. Replace `<absolute-path>`. Review the command trust in `/hooks`. |

pi and Oh My Pi show `ctx.ui.confirm` for every `bash` command. No UI means
deny. Oh My Pi applies its DCG `bash.patterns` deny rules as an additional floor.

Codex uses the `PreToolUse` hook for the id-bound request. When you need a
human approval, use a Codex permission mode that asks the user. In a full-auto
mode, the Codex policy can approve commands without a prompt.

## Safety limits

- The adapter accepts only the proxy-issued `tool_call_id` and the exact command
  string that the harness receives.
- The proxy uses a 60-second, single-use authorization. Replay, mismatch, timeout,
  unavailable proxy, and malformed hook input block the command.
- The shared secret authenticates a configured local adapter. It is not a sandbox
  against code that the user already allowed to run as the same OS user.
- Do not add the headers until this hook and its secret are installed.

## Sources

- Full wire contract (payload fields, HMAC construction, state machine, failure
  modes, worked example): `docs/m365-copilot-api.md` §11 *Client-attested
  execution (opt-in)*.
- `docs/research/client-approval-attestation.md`
- pi: `packages/coding-agent/docs/models.md` and
  `examples/extensions/permission-gate.ts`
- Oh My Pi: `omp://models.md`, `omp://hooks.md`
- Codex: https://learn.chatgpt.com/docs/config-file/config-advanced.md and
  https://learn.chatgpt.com/docs/hooks
