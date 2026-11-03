// models.js - Supported models and alias mappings for FreeModels upstream

export const SUPPORTED_MODELS = [
  {
    id: "claude-opus-5.5",
    name: "Claude Opus 5.5",
    provider: "Anthropic",
    group: "Claude",
    badge: "Flagship",
    description: "Most capable model for complex coding and agentic tasks in Cline.",
    strengths: ["Coding", "Agents", "Reasoning"],
    color: "#C2410C"
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5.5",
    provider: "Anthropic",
    group: "Claude",
    badge: "Thinking",
    description: "Reasoning model with extended thinking and strong coding capability.",
    strengths: ["Thinking", "Coding", "Analysis"],
    color: "#D97706"
  },
  {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    provider: "Anthropic",
    group: "Claude",
    badge: "Creative",
    description: "Creative writing and storytelling with nuanced long form generation.",
    strengths: ["Writing", "Creative", "Long Context"],
    color: "#7C3AED"
  },
  {
    id: "claude-fable-5.1",
    name: "Claude Fable 5.1",
    provider: "Anthropic",
    group: "Claude",
    badge: "New",
    description: "Improved creative model with coding and research support.",
    strengths: ["Writing", "Creative", "Long Context"],
    color: "#7C3AED"
  },
  {
    id: "sol",
    name: "GPT 5.6 Sol",
    provider: "OpenAI",
    group: "GPT",
    badge: "Fast",
    description: "High speed model optimized for quick insightful replies.",
    strengths: ["Speed", "General", "Conversational"],
    color: "#10A37F"
  },
  {
    id: "terra",
    name: "GPT 5.6 Terra",
    provider: "OpenAI",
    group: "GPT",
    badge: "Reasoning",
    description: "Deep reasoning model with advanced problem solving.",
    strengths: ["Reasoning", "Math", "Science"],
    color: "#0F6F5C"
  },
  {
    id: "glm-5.2",
    name: "GLM 5.2",
    provider: "Z.AI",
    group: "Other",
    badge: "Versatile",
    description: "Model with strong bilingual and tool calling abilities.",
    strengths: ["Bilingual", "Tools", "Knowledge"],
    color: "#2563EB"
  },
  {
    id: "kimi-k3",
    name: "Kimi K3",
    provider: "Moonshot AI",
    group: "Other",
    badge: "Long Context",
    description: "Ultra long context model with 200K+ token window and recall.",
    strengths: ["Long Context", "Recall", "Documents"],
    color: "#111827"
  },
  {
    id: "gpt-6-astra",
    name: "GPT 6 Astra",
    provider: "OpenAI",
    group: "GPT",
    badge: "Free Flagship",
    description: "Reasoning-first flagship for coding, math, science and creative work.",
    strengths: ["Reasoning", "Coding", "Creative"],
    color: "#22D3EE"
  }
];

// Common aliases mapping to our supported upstream models
export const MODEL_ALIASES = {
  // Claude aliases
  "claude-opus": "claude-opus-5.5",
  "claude-3-opus": "claude-opus-5.5",
  "claude-3-opus-20240229": "claude-opus-5.5",
  "claude-sonnet": "claude-sonnet-5",
  "claude-3-5-sonnet": "claude-sonnet-5",
  "claude-3-5-sonnet-20241022": "claude-sonnet-5",
  "claude-3-7-sonnet": "claude-sonnet-5",
  "claude-sonnet-3.5": "claude-sonnet-5",
  "claude-fable": "claude-fable-5.1",

  // OpenAI aliases
  "gpt-4o": "sol",
  "gpt-4o-mini": "sol",
  "gpt-4-turbo": "gpt-6-astra",
  "gpt-4": "gpt-6-astra",
  "gpt-5": "gpt-6-astra",
  "gpt-5.6-sol": "sol",
  "gpt-5.6-terra": "terra",
  "o1": "terra",
  "o1-preview": "terra",
  "o1-mini": "terra",
  "o3-mini": "terra",

  // Other aliases
  "kimi": "kimi-k3",
  "glm": "glm-5.2"
};

/**
 * Resolves a model name to an upstream supported modelId.
 * Strips optional suffixes like :thinking, :no-thinking, :deepsearch.
 */
export function resolveModel(inputModel, defaultModel = "claude-opus-5.5") {
  if (!inputModel || typeof inputModel !== "string") {
    return { modelId: defaultModel, thinkingOverride: null, deepSearchOverride: null };
  }

  let raw = inputModel.trim().toLowerCase();
  let thinkingOverride = null;
  let deepSearchOverride = null;

  // Check for suffixes e.g. claude-opus-5.5:thinking or :no-thinking
  if (raw.includes(":no-thinking")) {
    thinkingOverride = false;
    raw = raw.replace(":no-thinking", "");
  } else if (raw.includes(":thinking")) {
    thinkingOverride = true;
    raw = raw.replace(":thinking", "");
  }

  if (raw.includes(":no-deepsearch")) {
    deepSearchOverride = false;
    raw = raw.replace(":no-deepsearch", "");
  } else if (raw.includes(":deepsearch")) {
    deepSearchOverride = true;
    raw = raw.replace(":deepsearch", "");
  }

  // Exact match with supported ID
  const direct = SUPPORTED_MODELS.find(m => m.id.toLowerCase() === raw);
  if (direct) {
    return { modelId: direct.id, thinkingOverride, deepSearchOverride };
  }

  // Check alias map
  if (Object.hasOwn(MODEL_ALIASES, raw)) {
    return { modelId: MODEL_ALIASES[raw], thinkingOverride, deepSearchOverride };
  }

  // Prefix match
  for (const m of SUPPORTED_MODELS) {
    if (raw.includes(m.id.toLowerCase())) {
      return { modelId: m.id, thinkingOverride, deepSearchOverride };
    }
  }

  return { modelId: defaultModel, thinkingOverride, deepSearchOverride };
}
