// server.js - AI Proxy Server for Cline and AI coding agents
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SUPPORTED_MODELS } from "./models.js";
import {
  handleOpenAIChatCompletion,
  handleAnthropicMessages,
  handleDirectPayload
} from "./proxyHandler.js";
import { getLogs, clearLogs } from "./logger.js";
import { createAgentRouter } from "./agent.js";
import { AccountStore } from "./accountStore.js";
import { createSecurity, monitorUsage } from "./auth.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT || __dirname);
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-opus-5.5";
const UPSTREAM_URL = process.env.UPSTREAM_URL || "https://freemodels-chat.freemodels.workers.dev";

export async function createApp({ accountStore, agentCompletion } = {}) {
const app = express();
app.set('trust proxy', process.env.TRUST_PROXY || 1);
const store = accountStore || await new AccountStore(process.env.DATA_DIR || path.join(__dirname, 'data')).init();
const security = createSecurity(store);
const access = security.requireAccess();
const dashboardAccess = security.requireAccess({ sessionOnly: true });
const usage = monitorUsage(store);
app.locals.accountStore = store;
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'same-origin'); next(); });
// Global Middlewares
app.use(express.json({ limit: "50mb" }));
app.use('/api/auth', security.router);
app.use('/api/account', security.accounts);
app.use('/api/agent', await createAgentRouter({ root: WORKSPACE_ROOT,
  authorize: security.requireAccess({ agent: true }), monitor: usage, completion: agentCompletion, enabled: process.env.AGENT_ENABLED !== 'false' }));
app.use(cors({ origin: "*", methods: "*" }));

// Request logging in terminal
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    if (req.path !== "/api/logs" && req.path !== "/api/status" && !req.path.startsWith("/style.css")) {
      console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.originalUrl} - ${res.statusCode} (${Date.now() - start}ms)`);
    }
  });
  next();
});

// Health check
const healthHandler = (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    defaultModel: DEFAULT_MODEL,
    upstream: UPSTREAM_URL
  });
};
app.get("/health", healthHandler);
app.get("/ping", healthHandler);

// Models listing (OpenAI format for Cline, Cursor, Continue, etc.)
const listModelsHandler = (req, res) => {
  const modelsData = SUPPORTED_MODELS.map(m => ({
    id: m.id,
    object: "model",
    created: 1700000000,
    owned_by: m.provider.toLowerCase(),
    permission: [],
    root: m.id,
    parent: null,
    metadata: {
      name: m.name,
      badge: m.badge,
      description: m.description,
      strengths: m.strengths,
      group: m.group
    }
  }));

  res.json({
    object: "list",
    data: modelsData
  });
};

app.get("/v1/models", access, listModelsHandler);
app.get("/models", access, listModelsHandler);

// OpenAI Compatible Chat Completions (Primary endpoint for Cline)
app.post("/v1/chat/completions", access, usage, handleOpenAIChatCompletion);
app.post("/chat/completions", access, usage, handleOpenAIChatCompletion);

// Anthropic Compatible Messages endpoint (For Cline Anthropic mode)
app.post("/v1/messages", access, usage, handleAnthropicMessages);
app.post("/messages", access, usage, handleAnthropicMessages);

// Direct payload endpoints
app.post("/api/chat", access, usage, handleDirectPayload);
app.post("/payload", access, usage, handleDirectPayload);

// Root POST handler (if client posts directly to root URL)
app.post("/", access, usage, (req, res, next) => {
  if (req.body && (req.body.model || req.body.messages)) {
    return handleOpenAIChatCompletion(req, res);
  }
  next();
});

// Status & diagnostic API for Web UI
app.get("/api/status", dashboardAccess, async (req, res) => {
  let upstreamReachable = false;
  let upstreamLatencyMs = null;

  try {
    const t0 = Date.now();
    const probe = await fetch(UPSTREAM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://freemodels.pro",
        "Referer": "https://freemodels.pro/"
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "ping" }],
        modelId: "claude-opus-5.5",
        thinking: false,
        deepSearch: false,
        stream: true
      }),
      signal: AbortSignal.timeout(6000)
    });
    upstreamLatencyMs = Date.now() - t0;
    upstreamReachable = probe.ok;
    await probe.body?.cancel();
  } catch (e) {
    upstreamReachable = false;
  }

  res.json({
    status: "online",
    port: PORT,
    defaultModel: DEFAULT_MODEL,
    upstream: UPSTREAM_URL,
    upstreamReachable,
    upstreamLatencyMs,
    modelsCount: SUPPORTED_MODELS.length,
    models: SUPPORTED_MODELS
  });
});

// Logs API for Web UI
app.get("/api/logs", security.requireAccess({ sessionOnly: true, admin: true }), (req, res) => {
  res.json(getLogs());
});

app.post("/api/logs/clear", security.requireAccess({ sessionOnly: true, admin: true }), (req, res) => {
  clearLogs();
  res.json({ success: true });
});

app.use(security.errorHandler);
app.use(['/api', '/v1'], (req, res) => res.status(404).json({ error: { message: 'Unknown API endpoint' } }));
// Serve static frontend files
app.use(express.static(path.join(__dirname, "public")));

// Fallback to index.html for SPA
app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

return app;
}

// Importing createApp in tests does not bind a port or create production data.
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
const app = await createApp();
// Start server
const server = app.listen(PORT, HOST, () => {
  console.log(`
=====================================================
🚀 AI PROXY SERVER RUNNING FOR CLINE
=====================================================
📡 Local URL:       http://localhost:${PORT}
🌐 Bind address:    ${HOST}:${PORT}
📂 Workspace:       ${WORKSPACE_ROOT}
🛠️  Workspace agent: ${process.env.AGENT_ENABLED !== 'false' ? 'Enabled at /api/agent/run' : 'Disabled'}
⚙️  Default Model:   ${DEFAULT_MODEL}
🧠 Thinking Mode:   ${process.env.DEFAULT_THINKING !== "false" ? "Enabled (true)" : "Disabled (false)"}
🔍 DeepSearch:      ${process.env.DEFAULT_DEEP_SEARCH !== "false" ? "Enabled (true)" : "Disabled (false)"}
🔗 Upstream:        ${UPSTREAM_URL}

-----------------------------------------------------
CLINE CONFIGURATION:
1. Open Cline Settings -> API Provider: "OpenAI Compatible"
2. Base URL:  http://localhost:${PORT}/v1
3. API Key:   Create a key in the dashboard after login
4. Model ID:  claude-opus-5.5 (or claude-sonnet-5, sol, terra, gpt-6-astra)
=====================================================
`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is in use. Please change PORT in .env or kill the process using port ${PORT}.`);
  } else {
    console.error("Server error:", err);
  }
});

}
