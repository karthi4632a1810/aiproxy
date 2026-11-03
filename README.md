# FreeModels AI Proxy for Cline & Coding Agents ⚡

A high-performance local AI proxy server designed specifically to bridge the FreeModels Cloudflare Worker backend into **Cline** (and Cursor, Continue, Roo Code, LibreChat, or standard OpenAI / Anthropic SDKs).

## Login, API keys and usage monitoring

1. Restart with `npm start`, then open **http://127.0.0.1:3000**. The first visit opens account setup. Create your administrator account with a password of at least 12 characters.
2. In **API Keys & Usage**, create a named key such as `Karthi · Cline laptop`. Choose a client label and expiry. **Copy the key immediately**; only its prefix is displayed afterward.
3. Paste it into Cline's **API Key** setting, with your proxy's `/v1` base URL. Create another key for each person or CLI installation to distinguish their usage.
4. Monitor requests, input/output tokens, failures/stopped runs, last activity, client labels, IPs and user-agent hints. Filter by key and 7/30/90 days. Each key also has lifetime totals. Revoke a key to stop new requests immediately; a request already running can finish.

Administrators can add accounts under **Manage users**, issue keys for those accounts, disable users and see everyone's usage. Members can log in, manage their own keys and see only their own usage. Email is a login identifier; the app does not send email or provide email-based password recovery. Users can change their password in the dashboard; doing so signs out all their sessions. Disabling an account invalidates its sessions and blocks all its keys until re-enabled.

For a CLI, export your created key as `AIPROXY_API_KEY` and use:

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $AIPROXY_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'X-Client-Name: My CLI workstation' \
  -d '{"model":"claude-opus-5.5","messages":[{"role":"user","content":"Hello"}],"stream":false}'
```

Anthropic clients may send `x-api-key` instead of `Authorization: Bearer`. All completion aliases, direct-payload routes and model-list routes now require a real key (or an authenticated dashboard session). **Dummy keys and the old `AGENT_API_KEY` no longer grant access.** Standard keys let Cline execute its own local tools; only an administrator session or administrator-owned key explicitly granted **Allow workspace agent** can use this server's workspace tools.

Usage is attributed to the key owner and key ID. Client labels are chosen when creating keys; `X-Client-Name`, user-agent and IP are additional hints, not proof of who physically used a shared key. The dashboard does not record prompts, completions, passwords or full keys in persistent usage history. The older live request inspector remains administrator-only and retains response snippets in memory.

Provider-reported token counts are used when available. Otherwise token counts are approximate, including partial responses and attempted calls on errors; estimated requests are labelled. An agent run counts as one request with tokens summed across its model turns. Dashboard chat/agent requests are listed as **Dashboard session**, separately from API keys. Model listing, status probes and authentication calls are not counted as inference usage. Stream errors are recorded separately from the HTTP status already sent to the client.

Accounts, hashed passwords, hashed API keys, hashed session tokens and usage persist in `data/accounts.json` with atomic, serialized writes. Recent request details retain the latest 1,000 requests globally (the dashboard displays the latest 200 matching rows); daily totals retain 90 days; key totals are lifetime. Restart recovery marks unfinished requests as aborted. Up to 100 keys, including revoked keys, are retained per account. This file store supports **one server process**; do not run multiple replicas against it. Back up `DATA_DIR` and use a persistent disk when hosting. Ephemeral cloud disks lose accounts and usage when replaced.

Local setup is limited to a loopback connection and localhost host name. For remote first-time setup, configure a long random `SETUP_TOKEN` before starting and enter it on the setup screen. Set `APP_ORIGIN` to the exact public HTTPS origin, `HOST=0.0.0.0` when needed, and `DATA_DIR` to your persistent storage path. If using a reverse proxy, set `TRUST_PROXY` only to its actual IP/network (for example `loopback` for a local proxy); forwarded client IPs are otherwise ignored. HTTPS enables Secure cookies; sessions also use HttpOnly, SameSite=Strict and CSRF tokens. Login attempts are throttled. The included Render free configuration needs persistent storage configured before using it for durable accounts.

Authentication implementation follows the [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) and [session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) guidance: salted scrypt passwords and random session/key secrets; raw passwords and API keys are never persisted.

It automatically wraps and translates your requests into the exact upstream format:

```json
{
  "messages": [
    {
      "role": "user",
      "content": "hi"
    }
  ],
  "modelId": "claude-opus-5.5",
  "thinking": true,
  "deepSearch": true,
  "stream": true
}
```

## Workspace coding agent

Run `npm start`, open **http://127.0.0.1:3000**, and use **Workspace Coding Agent** with **Agent mode** enabled. Describe a task such as “Create a small script, run it, and fix any errors.” The agent reads files, makes changes, executes commands, passes the actual results back to the model, and continues until it finishes or reaches the step limit. The dashboard keeps conversation history for follow-up tasks and shows expandable tool results. **Stop** cancels the upstream request and active command; completed changes remain.

The workspace defaults to the folder containing `server.js`, so this project works without extra configuration. Set `WORKSPACE_ROOT` in `.env` to use a different project. Restart the proxy after updating configuration. Node.js 20.3+ and Bash are required for command execution.

| Tool | Capability |
| --- | --- |
| `list_files` | List files and directories, optionally recursively |
| `read_file` | Read UTF-8 files and line ranges |
| `write_file` | Create or overwrite files and create missing parents |
| `edit_file` | Replace exact text; reject ambiguous matches by default |
| `create_directory` | Create directories and parents |
| `delete_path` | Delete files/directories; recursive deletion is explicit |
| `search_files` | Search literal text across project files |
| `execute_command` | Run builds, tests and shell commands; capture stdout, stderr and exit status |

File tools reject paths outside the workspace, symlinks, writes through hard links, and attempts to modify the workspace root. Files are limited to 1 MiB; reads return at most 500 lines. Shell commands start in the workspace and run with **the server user's OS permissions**: this is **not an OS sandbox**, and a command can access other locations that user can access. Use a container or a restricted OS account if you need hard filesystem/network isolation. Commands default to a 30-second timeout (maximum 120 seconds), stop at 64 KiB of output, and terminate their process group on cancellation or completion. Long-running background servers are not supported.

The server binds to `127.0.0.1` by default. Agent endpoints require an administrator login or an administrator-owned API key with workspace access enabled. The dashboard uses its HttpOnly session cookie. Cross-origin browser requests to agent endpoints are rejected. The included Render configuration keeps the agent disabled; a cloud deployment can only edit its own server filesystem, not your laptop's workspace.

### Agent API

For scripts, create an administrator-owned key with **Allow workspace agent** enabled and export it as `AIPROXY_API_KEY` in your terminal:

```bash
curl http://127.0.0.1:3000/api/agent/run \
  -H "Authorization: Bearer $AIPROXY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Inspect the project and summarize its structure without changes.","stream":false,"max_steps":20}'
```

The previous temporary-token endpoint `/api/agent/session` is retired. Use the account login or your scoped API key.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/agent/status` | Enabled/busy status and authentication mode |
| `GET /api/agent/tools` | Workspace location and tool schemas (authenticated) |
| `POST /api/agent/tools/:name` | Execute one tool; body is its arguments (authenticated) |
| `POST /api/agent/run` | Execute a model/tool loop (authenticated) |

Runs accept `prompt` or `messages`, `model`/`modelId`, `thinking`, `deepSearch`, `stream`, and `max_steps` (1–50, default 20). With `stream:false`, the response includes `status` (`completed` or `max_steps`), `message`, and the generated `messages`, including tool calls/results. Send the previous input and generated messages with your next user message to continue. Streaming runs emit SSE events `run_start`, `step`, `assistant`, `tool_start`, `tool_result`, `done`, and `error`. The `done` event contains the same result as a batch response. Only one workspace operation runs at a time; overlapping requests receive HTTP 409. Tool errors are fed back to the model for recovery; upstream failures terminate the run with an error.

### Tool calling through existing proxy endpoints

`/v1/chat/completions` now accepts function `tools` and `tool_choice`, preserves `tool_calls`/`tool_call_id`, and returns the `tool_calls` finish reason. `/v1/messages` translates Anthropic `tool_use`/`tool_result` blocks and streaming tool arguments. These endpoints return tool requests to Cline or another client, which executes its own tools. Use `/api/agent/run` when the proxy itself should execute workspace tools. `/api/chat` and `/payload` accept the original `modelId` payload and now return consistent OpenAI-style completions for both streaming and batch responses.

The default `TOOL_CALL_MODE=prompt` embeds schemas and a JSON tool protocol into messages for text-only workers. Calls are buffered and validated before being returned or executed. Reliability depends on the upstream model following this protocol; malformed, unknown, truncated, or disallowed calls fail explicitly. Set `TOOL_CALL_MODE=native` only if your upstream accepts native OpenAI function tools and returns tool-call deltas. This does not enable an upstream capability the provider lacks. Ordinary chats continue streaming text as it arrives; requests with tools wait for a complete, validated model turn. Token counts in compatibility responses are estimates.

Protocol references: [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling) and [Anthropic tool definitions](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools).

### Verification

Run `npm test`. Tests use temporary workspaces, real shell commands, and mocked model responses. They cover file changes/deletion, path restrictions, command errors/timeouts/cancellation, tool-result feedback, run limits, authentication, origin checks, concurrency, fragmented SSE, and both API formats. Route tests run in-process without opening network ports. These checks do not establish live FreeModels availability or model tool-use reliability.

---

## 🚀 Quick Setup in Cline

### Method 1: OpenAI Compatible Mode (Recommended)
1. Open VS Code and click on the **Cline** extension icon.
2. Click the ⚙️ **Settings** gear icon.
3. Configure the following fields:

| Field | Value |
|---|---|
| **API Provider** | `OpenAI Compatible` |
| **Base URL** | `http://localhost:3000/v1` |
| **API Key** | Your key created in **API Keys & Usage** |
| **Model ID** | `claude-opus-5.5` |

4. Click **Save** (or start prompting directly). Cline will now stream responses using Claude Opus 5.5 with Thinking & DeepSearch enabled!

---

### Method 2: Anthropic Provider Mode
If you prefer selecting Anthropic in Cline:
1. Open Cline Settings ⚙️
2. Select **API Provider**: `Anthropic`
3. Set **Base URL**: `http://localhost:3000`
4. Set **Model ID**: `claude-opus-5.5`
5. Set **API Key** to a key created in **API Keys & Usage**.

The proxy automatically converts Anthropic `/v1/messages` requests and SSE event streams (`message_start`, `content_block_delta`, `message_stop`) into the format expected by Cline.

---

## 🤖 Supported Models Catalog

You can switch models in Cline by changing the **Model ID** setting:

| Model ID | Model Name | Provider | Best For |
|---|---|---|---|
| `claude-opus-5.5` | Claude Opus 5.5 | Anthropic | **Flagship coding, agents & deep reasoning** |
| `claude-sonnet-5` | Claude Sonnet 5.5 | Anthropic | Coding with extended reasoning/thinking |
| `gpt-6-astra` | GPT 6 Astra | OpenAI | Free reasoning-first flagship |
| `terra` | GPT 5.6 Terra | OpenAI | Advanced math, science & deep logic |
| `sol` | GPT 5.6 Sol | OpenAI | Ultra-fast responses & conversation |
| `claude-fable-5.1` | Claude Fable 5.1 | Anthropic | Creative writing, research & code |
| `claude-fable-5` | Claude Fable 5 | Anthropic | Long-form generation & storytelling |
| `glm-5.2` | GLM 5.2 | Z.AI | Bilingual coding & tools |
| `kimi-k3` | Kimi K3 | Moonshot AI | Ultra long-context (200K+ tokens) |

---

## ⚙️ Configuration & Options

Edit `.env` to configure defaults:

```ini
PORT=3000
DEFAULT_MODEL=claude-opus-5.5
DEFAULT_THINKING=true
DEFAULT_DEEP_SEARCH=true
UPSTREAM_URL=https://freemodels-chat.freemodels.workers.dev
```

### Dynamic Suffix Overrides
You can also override thinking or deep search directly inside your Model ID in Cline:
- `claude-opus-5.5:no-thinking` &rarr; Disables thinking mode
- `claude-opus-5.5:no-deepsearch` &rarr; Disables deepSearch
- `claude-opus-5.5:thinking` &rarr; Force-enables thinking mode

---

## 🖥️ Web Dashboard & Live Testing Playground

Open **[http://localhost:3000](http://localhost:3000)** in your browser:

- **Live Status & Ping**: Displays upstream worker connectivity and real-time Cloudflare latency.
- **Cline Setup Assistant**: 1-click copy buttons for Base URL, Model ID, and API keys.
- **Interactive Chat Playground**: Test any model, toggle thinking/deepSearch on the fly, and inspect live streaming speed.
- **Live Request Inspector**: Real-time monitor of requests made by Cline (endpoints, token counts, duration, status codes).

---

## 🏃 Running the Proxy Server

To start or restart the proxy:

```bash
# Using npm
npm start

# Or using the start script
./start.sh

# Or in development auto-reload mode
npm run dev
```
