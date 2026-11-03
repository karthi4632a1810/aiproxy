// app.js - Dashboard Client Logic, Live Testing, and Logs Inspector

let currentModels = [];

// Initialize on page load
document.addEventListener("DOMContentLoaded", () => {
  initStatus();
  initCopyButtons();
  initPlayground();
  initLogs();

  // Refresh status and logs periodically
  setInterval(fetchLogs, 5000);
});

// Toast notification helper
function showToast(message = "Copied to clipboard!") {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

// Clipboard copy helper
function copyText(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast(`Copied: ${text}`);
  }).catch(() => {
    // Fallback
    const input = document.createElement("input");
    input.value = text;
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    document.body.removeChild(input);
    showToast(`Copied: ${text}`);
  });
}

// Initialize copy handlers
function initCopyButtons() {
  document.querySelectorAll("[data-copy]").forEach(btn => {
    btn.addEventListener("click", () => {
      const text = btn.getAttribute("data-copy");
      copyText(text);
    });
  });

  document.getElementById("copyAllConfigBtn")?.addEventListener("click", () => {
    const configText = `API Provider: OpenAI Compatible
Base URL: http://localhost:3000/v1
API Key: sk-freemodels-proxy
Model ID: claude-opus-5.5`;
    copyText(configText);
  });
}

// Fetch server status & models
async function initStatus() {
  const statusPill = document.getElementById("statusPill");
  const statusText = document.getElementById("statusText");
  const latencyBadge = document.getElementById("latencyBadge");
  const statUpstream = document.getElementById("statUpstream");
  const statUpstreamLatency = document.getElementById("statUpstreamLatency");
  const statModelsCount = document.getElementById("statModelsCount");
  const statActiveModel = document.getElementById("statActiveModel");

  try {
    const res = await fetch("/api/status");
    if (!res.ok) throw new Error("Status API returned " + res.status);
    const data = await res.json();

    currentModels = data.models || [];

    // Update status pill
    if (data.upstreamReachable) {
      statusPill.className = "status-pill status-online";
      statusText.textContent = "Online & Connected";
      latencyBadge.textContent = `${data.upstreamLatencyMs || 120} ms`;
      statUpstream.textContent = "Active (Connected)";
      statUpstream.className = "stat-value text-success";
      statUpstreamLatency.textContent = `Latency: ${data.upstreamLatencyMs} ms to Cloudflare Edge`;
    } else {
      statusPill.className = "status-pill status-offline";
      statusText.textContent = "Upstream Issue";
      latencyBadge.textContent = "Offline";
      statUpstream.textContent = "Upstream Unreachable";
      statUpstream.className = "stat-value text-danger";
    }

    statModelsCount.textContent = `${data.modelsCount} Models`;
    statActiveModel.textContent = data.defaultModel;

    renderModelsList(currentModels);
  } catch (err) {
    statusPill.className = "status-pill status-offline";
    statusText.textContent = "Server Offline";
    latencyBadge.textContent = "--";
    console.error("Failed to load status:", err);
  }
}

// Render Supported Models catalog
function renderModelsList(models) {
  const container = document.getElementById("modelsList");
  if (!container) return;

  if (!models || models.length === 0) {
    container.innerHTML = '<div class="empty-table-state">No models discovered</div>';
    return;
  }

  container.innerHTML = models.map(m => {
    let badgeClass = "badge-flagship";
    if (m.badge === "Thinking") badgeClass = "badge-thinking";
    if (m.badge === "Reasoning") badgeClass = "badge-reasoning";
    if (m.badge === "Fast") badgeClass = "badge-fast";
    if (m.badge === "Creative" || m.badge === "New") badgeClass = "badge-creative";

    return `
      <div class="model-item">
        <div class="model-item-info">
          <div class="model-item-top">
            <span class="model-badge ${badgeClass}">${m.badge || "AI"}</span>
            <span class="model-name">${m.name}</span>
            <span class="model-id-code font-mono">(${m.id})</span>
          </div>
          <div class="model-desc">${m.description}</div>
        </div>
        <button class="btn btn-secondary btn-sm btn-use-model" onclick="selectModelForCline('${m.id}')">
          Copy for Cline
        </button>
      </div>
    `;
  }).join("");
}

// When clicking "Copy for Cline" on any model
window.selectModelForCline = function(modelId) {
  const modelBox = document.getElementById("configModelId");
  if (modelBox) {
    modelBox.textContent = modelId;
  }
  const modelSelect = document.getElementById("modelSelect");
  if (modelSelect) {
    modelSelect.value = modelId;
  }
  copyText(modelId);
  showToast(`Selected & copied Model ID: ${modelId}`);
};

// Simple text & markdown code renderer
function renderFormattedText(container, text, isStreaming = false) {
  // Simple code block parser
  const codeBlockRegex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let html = escapeHtml(text).replace(codeBlockRegex, (match, lang, code) => {
    return `<pre><code>${code.trim()}</code></pre>`;
  });

  // Convert linebreaks
  html = html.replace(/\n\n/g, "<br><br>").replace(/\n/g, "<br>");

  if (isStreaming) {
    html += ' <span class="streaming-cursor">▊</span>';
  }

  container.innerHTML = html;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Fetch & render live logs
async function fetchLogs() {
  const tbody = document.getElementById("logsTableBody");
  if (!tbody) return;

  try {
    const res = await fetch("/api/logs");
    if (!res.ok) return;
    const logs = await res.json();

    if (!logs || logs.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" class="empty-table-state">No requests recorded yet. Make a request via Cline or the test chat above!</td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = logs.map(item => {
      const timeStr = new Date(item.timestamp).toLocaleTimeString();
      const statusClass = item.status === 200 ? "success" : "error";
      const flags = [
        item.thinking ? "🧠 Thinking" : null,
        item.deepSearch ? "🔍 DeepSearch" : null,
        item.stream ? "⚡ Stream" : "📦 Batch"
      ].filter(Boolean).join(" &bull; ");

      const snippet = item.firstSnippet
        ? escapeHtml(item.firstSnippet.slice(0, 60)) + "..."
        : (item.error ? `<span style="color:#f87171;">${escapeHtml(item.error)}</span>` : "—");

      return `
        <tr>
          <td class="font-mono" style="color: var(--text-dim);">${timeStr}</td>
          <td><code class="font-mono text-xs">${escapeHtml(item.endpoint)}</code></td>
          <td><strong>${escapeHtml(item.model)}</strong></td>
          <td style="font-size: 0.72rem; color: var(--text-muted);">${flags}</td>
          <td><span class="status-pill-table ${statusClass}">${item.status}</span></td>
          <td>${item.tokensGenerated} tokens &bull; ${item.durationMs}ms</td>
          <td style="max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted);">${snippet}</td>
        </tr>
      `;
    }).join("");
  } catch (err) {
    console.error("Failed to load logs:", err);
  }
}

function initLogs() {
  document.getElementById("refreshLogsBtn")?.addEventListener("click", fetchLogs);
  document.getElementById("clearLogsBtn")?.addEventListener("click", async () => {
    await fetch("/api/logs/clear", { method: "POST" });
    fetchLogs();
    showToast("Request logs cleared");
  });

  fetchLogs();
}
