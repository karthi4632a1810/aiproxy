import { resolveModel } from "./models.js";

export function extractOptions(req) {
  const body = req.body || {};
  const defaultModel = process.env.DEFAULT_MODEL || "claude-opus-5.5";
  const defaultThinking = process.env.DEFAULT_THINKING !== "false"; // default true
  const defaultDeepSearch = process.env.DEFAULT_DEEP_SEARCH !== "false"; // default true

  const inputModel = body.modelId || body.model || req.query.model || defaultModel;
  const { modelId, thinkingOverride, deepSearchOverride } = resolveModel(inputModel, defaultModel);

  // Determine thinking boolean
  let thinking = defaultThinking;
  if (typeof body.thinking === "boolean") {
    thinking = body.thinking;
  } else if (req.headers["x-thinking"] !== undefined) {
    thinking = req.headers["x-thinking"] === "true";
  } else if (req.query.thinking !== undefined) {
    thinking = req.query.thinking === "true";
  } else if (thinkingOverride !== null) {
    thinking = thinkingOverride;
  }

  // Determine deepSearch boolean
  let deepSearch = defaultDeepSearch;
  if (typeof body.deepSearch === "boolean") {
    deepSearch = body.deepSearch;
  } else if (req.headers["x-deepsearch"] !== undefined) {
    deepSearch = req.headers["x-deepsearch"] === "true";
  } else if (req.query.deepSearch !== undefined || req.query.deepsearch !== undefined) {
    deepSearch = (req.query.deepSearch || req.query.deepsearch) === "true";
  } else if (deepSearchOverride !== null) {
    deepSearch = deepSearchOverride;
  }

  const stream = body.stream !== false; // Default to true unless explicitly false

  return { modelId, thinking, deepSearch, stream };
}

