// logger.js - In-memory rolling log buffer for proxy activity inspection

const MAX_LOGS = 60;
const logs = [];

export function addLogEntry(entry) {
  const logItem = {
    id: entry.id || `log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    timestamp: new Date().toISOString(),
    endpoint: entry.endpoint || "/v1/chat/completions",
    model: entry.model || "claude-opus-5.5",
    messagesCount: entry.messagesCount || 1,
    thinking: entry.thinking ?? true,
    deepSearch: entry.deepSearch ?? true,
    stream: entry.stream ?? true,
    status: entry.status || 200,
    durationMs: entry.durationMs || 0,
    tokensGenerated: entry.tokensGenerated || 0,
    firstSnippet: entry.firstSnippet || "",
    error: entry.error || null
  };

  logs.unshift(logItem);
  if (logs.length > MAX_LOGS) {
    logs.pop();
  }

  return logItem;
}

export function getLogs() {
  return [...logs];
}

export function clearLogs() {
  logs.length = 0;
}
