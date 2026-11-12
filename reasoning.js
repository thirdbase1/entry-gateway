// Canonical reasoning controls shared by Entry clients and protocol-native upstreams.
// A route opts in explicitly: unknown model capabilities are never guessed.
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const TYPES = new Set(["openai_effort", "openai_responses_effort", "anthropic_budget", "gemini_level"]);

export function validateReasoningConfig(config, protocol, where = "reasoning") {
  if (config === undefined) return [];
  const errors = [];
  if (!isObject(config)) return [`${where} must be an object`];
  if (config.supported === false) return [];
  if (config.supported !== true) errors.push(`${where}.supported must be true or false`);
  if (!Array.isArray(config.efforts) || config.efforts.length === 0 || config.efforts.some((v) => typeof v !== "string" || !v.trim())) errors.push(`${where}.efforts must be a non-empty array of non-empty strings`);
  else if (new Set(config.efforts).size !== config.efforts.length) errors.push(`${where}.efforts must not contain duplicates`);
  if (config.default_effort !== undefined && (!Array.isArray(config.efforts) || !config.efforts.includes(config.default_effort))) errors.push(`${where}.default_effort must be one of reasoning.efforts`);
  if (!isObject(config.mapping) || !TYPES.has(config.mapping.type)) { errors.push(`${where}.mapping.type must be one of ${[...TYPES].join(", ")}`); return errors; }
  const effectiveProtocol = protocol || "openai-chat";
  const expected = { "openai-chat": "openai_effort", "openai-responses": "openai_responses_effort", "anthropic-messages": "anthropic_budget", "gemini-generate": "gemini_level" }[effectiveProtocol];
  if (expected && config.mapping.type !== expected) errors.push(`${where}.mapping.type ${config.mapping.type} is incompatible with protocol ${protocol}; expected ${expected}`);
  if (config.mapping.type === "anthropic_budget") {
    const budgets = config.mapping.budgets;
    if (!isObject(budgets)) errors.push(`${where}.mapping.budgets must map each effort to a positive integer token budget`);
    else for (const effort of config.efforts || []) if (!Number.isSafeInteger(budgets[effort]) || budgets[effort] < 1) errors.push(`${where}.mapping.budgets.${effort} must be a positive integer`);
  }
  if (config.mapping.type === "gemini_level") {
    const levels = config.mapping.levels;
    if (levels !== undefined && !isObject(levels)) errors.push(`${where}.mapping.levels must be an object when provided`);
    else for (const effort of config.efforts || []) { const level = levels?.[effort] ?? effort.toUpperCase(); if (typeof level !== "string" || !level.trim()) errors.push(`${where}.mapping.levels.${effort} must be a non-empty string`); }
  }
  if (config.mapping.type === "openai_effort") {
    const values = config.mapping.values;
    if (values !== undefined && !isObject(values)) errors.push(`${where}.mapping.values must be an object when provided`);
    else for (const effort of config.efforts || []) { const value = values?.[effort] ?? effort; if (typeof value !== "string" || !value.trim()) errors.push(`${where}.mapping.values.${effort} must be a non-empty string`); }
  }
  return errors;
}

export function reasoningMetadata(route) {
  const config = route?.reasoning;
  if (!config?.supported || validateReasoningConfig(config, route?.protocol).length > 0) return { supported: false, efforts: [], default_effort: null };
  return {
    supported: true,
    efforts: [...config.efforts],
    default_effort: config.default_effort ?? null,
    // Stable gateway-side field accepted from Entry regardless of upstream protocol.
    request_parameter: "reasoning_effort",
    // Native parameter expected by the selected upstream protocol.
    upstream_parameter: route?.protocol === "openai-responses" ? "reasoning.effort" : route?.protocol === "anthropic-messages" ? "thinking.budget_tokens" : route?.protocol === "gemini-generate" ? "generationConfig.thinkingConfig.thinkingLevel" : "reasoning_effort",
  };
}

// Entry may send the canonical reasoning_effort field. Native Responses API
// clients may instead send reasoning.effort directly; normalize both paths and
// strip unsupported native effort values on routes that explicitly lack support.
export function applyReasoningConfig(body, route, protocol) {
  if (!isObject(body)) return body;
  const config = route?.reasoning;
  const configValid = Boolean(config?.supported && validateReasoningConfig(config, protocol).length === 0 && config.mapping);
  const mapping = configValid ? config.mapping : null;

  if (protocol === "openai-responses") {
    const existingReasoning = isObject(body.reasoning) ? body.reasoning : {};
    const canonicalEffort = typeof body.reasoning_effort === "string" ? body.reasoning_effort : null;
    const nativeEffort = typeof existingReasoning.effort === "string" ? existingReasoning.effort : null;
    const selectedEffort = canonicalEffort ?? nativeEffort;
    const { reasoning_effort: _ignored, ...rest } = body;
    if (selectedEffort === null) return rest;
    const allowed = configValid && mapping.type === "openai_responses_effort" && config.efforts.includes(selectedEffort);
    const mappedValues = mapping?.values || {};
    const nativeAllowed = allowed
      ? selectedEffort
      : configValid && mapping.type === "openai_responses_effort"
        ? Object.entries(mappedValues).find(([key, value]) => config.efforts.includes(key) && value === selectedEffort)?.[1]
        : null;
    if (nativeAllowed === null || nativeAllowed === undefined) {
      const { effort: _drop, ...preservedReasoning } = existingReasoning;
      return Object.keys(preservedReasoning).length ? { ...rest, reasoning: preservedReasoning } : rest;
    }
    const effort = canonicalEffort !== null ? (mappedValues[selectedEffort] ?? selectedEffort) : nativeAllowed;
    return { ...rest, reasoning: { ...existingReasoning, effort } };
  }

  if (typeof body.reasoning_effort !== "string") return body;
  const effort = body.reasoning_effort;
  if (!configValid || !config.efforts?.includes(effort)) { const { reasoning_effort: _ignored, ...rest } = body; return rest; }
  if (protocol === "openai-chat" && mapping.type === "openai_effort") return { ...body, reasoning_effort: mapping.values?.[effort] ?? effort };
  if (protocol === "anthropic-messages" && mapping.type === "anthropic_budget") {
    const { reasoning_effort: _ignored, ...rest } = body;
    const maxTokens = Number.isSafeInteger(body.max_tokens) ? body.max_tokens : null;
    const configuredBudget = mapping.budgets?.[effort];
    const budget = maxTokens === null ? configuredBudget : Math.min(configuredBudget, maxTokens - 1);
    if (!Number.isSafeInteger(budget) || budget < 1) return rest;
    return { ...rest, thinking: { type: "enabled", budget_tokens: budget } };
  }
  if (protocol === "gemini-generate" && mapping.type === "gemini_level") {
    const { reasoning_effort: _ignored, ...rest } = body;
    const generationConfig = isObject(rest.generationConfig) ? rest.generationConfig : {};
    const thinkingConfig = isObject(generationConfig.thinkingConfig) ? generationConfig.thinkingConfig : {};
    const level = mapping.levels?.[effort] ?? effort.toUpperCase();
    return { ...rest, generationConfig: { ...generationConfig, thinkingConfig: { ...thinkingConfig, thinkingLevel: level } } };
  }
  const { reasoning_effort: _ignored, ...rest } = body;
  return rest;
}

// Advertise only effort options every fallback route for this protocol can honor.
export function aggregateReasoningMetadata(routeList) {
  if (!routeList.length || routeList.some((route) => !reasoningMetadata(route).supported)) return { supported: false, efforts: [], default_effort: null };
  const first = reasoningMetadata(routeList[0]);
  const efforts = first.efforts.filter((effort) => routeList.every((route) => reasoningMetadata(route).efforts.includes(effort)));
  if (!efforts.length) return { supported: false, efforts: [], default_effort: null };
  const protocols = new Set(routeList.map((route) => route.protocol));
  return {
    supported: true,
    efforts,
    default_effort: efforts.includes(first.default_effort) ? first.default_effort : null,
    request_parameter: "reasoning_effort",
    upstream_parameter: protocols.size === 1 ? first.upstream_parameter : null,
  };
}
