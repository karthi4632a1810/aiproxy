# FreeModels AI Proxy for Cline & Coding Agents ⚡

A high-performance local AI proxy server designed specifically to bridge the FreeModels Cloudflare Worker backend into **Cline** (and Cursor, Continue, Roo Code, LibreChat, or standard OpenAI / Anthropic SDKs).

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
| **API Key** | `sk-proxy` (or any dummy text) |
| **Model ID** | `claude-opus-5.5` |

4. Click **Save** (or start prompting directly). Cline will now stream responses using Claude Opus 5.5 with Thinking & DeepSearch enabled!

---

### Method 2: Anthropic Provider Mode
If you prefer selecting Anthropic in Cline:
1. Open Cline Settings ⚙️
2. Select **API Provider**: `Anthropic`
3. Set **Base URL**: `http://localhost:3000`
4. Set **Model ID**: `claude-opus-5.5`
5. Set **API Key**: `sk-proxy`

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
