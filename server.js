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

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-opus-5.5";
const UPSTREAM_URL = process.env.UPSTREAM_URL || "https://freemodels-chat.freemodels.workers.dev";

// Global Middlewares
app.use(cors({ origin: "*", methods: "*" }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

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

app.get("/v1/models", listModelsHandler);
app.get("/models", listModelsHandler);

// OpenAI Compatible Chat Completions (Primary endpoint for Cline)
app.post("/v1/chat/completions", handleOpenAIChatCompletion);
app.post("/chat/completions", handleOpenAIChatCompletion);

// Anthropic Compatible Messages endpoint (For Cline Anthropic mode)
app.post("/v1/messages", handleAnthropicMessages);
app.post("/messages", handleAnthropicMessages);

// Direct payload endpoints
app.post("/api/chat", handleDirectPayload);
app.post("/payload", handleDirectPayload);

// Root POST handler (if client posts directly to root URL)
app.post("/", (req, res, next) => {
  if (req.body && (req.body.model || req.body.messages)) {
    return handleOpenAIChatCompletion(req, res);
  }
  next();
});

// Status & diagnostic API for Web UI
app.get("/api/status", async (req, res) => {
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
app.get("/api/logs", (req, res) => {
  res.json(getLogs());
});

app.post("/api/logs/clear", (req, res) => {
  clearLogs();
  res.json({ success: true });
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, "public")));

// Fallback to index.html for SPA
app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`
=====================================================
🚀 AI PROXY SERVER RUNNING FOR CLINE
=====================================================
📡 Local URL:       http://localhost:${PORT}
🌐 Network URL:     http://0.0.0.0:${PORT}
⚙️  Default Model:   ${DEFAULT_MODEL}
🧠 Thinking Mode:   ${process.env.DEFAULT_THINKING !== "false" ? "Enabled (true)" : "Disabled (false)"}
🔍 DeepSearch:      ${process.env.DEFAULT_DEEP_SEARCH !== "false" ? "Enabled (true)" : "Disabled (false)"}
🔗 Upstream:        ${UPSTREAM_URL}

-----------------------------------------------------
CLINE CONFIGURATION:
1. Open Cline Settings -> API Provider: "OpenAI Compatible"
2. Base URL:  http://localhost:${PORT}/v1
3. API Key:   sk-proxy (or any text)
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
