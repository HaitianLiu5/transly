import { isMagpieConnection } from "./magpie.js";

export const PROVIDER_STORAGE_KEY = "translationProvider";

export const DEFAULT_PROVIDER_CONFIG = Object.freeze({
  apiUrl: "",
  apiKey: "",
  model: "",
  protocol: "auto"
});

const ALLOWED_PROTOCOLS = new Set(["auto", "responses", "chat-completions"]);

export function normalizeProviderConfig(value = {}) {
  return {
    apiUrl: String(value.apiUrl || "").trim(),
    apiKey: String(value.apiKey || "").trim(),
    model: String(value.model || "").trim(),
    protocol: ALLOWED_PROTOCOLS.has(value.protocol) ? value.protocol : "auto"
  };
}

export function validateProviderConfig(value) {
  const config = normalizeProviderConfig(value);
  validateProviderEndpoint(config);
  if (!config.model) throw configError("Model name is required.");

  return config;
}

export function validateProviderConnection(value) {
  const config = normalizeProviderConfig(value);
  validateProviderEndpoint(config);
  return config;
}

function validateProviderEndpoint(config) {
  if (!config.apiUrl) throw configError("API URL is required.");

  let url;
  try {
    url = new URL(config.apiUrl);
  } catch {
    throw configError("API URL is invalid.");
  }
  if (!isAllowedProviderUrl(url)) {
    throw configError("Remote services must use HTTPS. HTTP is only allowed for localhost.");
  }
  if (url.username || url.password || url.hash) {
    throw configError("API URL cannot contain credentials or a fragment.");
  }
}

export function providerSummary(configValue) {
  const config = normalizeProviderConfig(configValue);
  let host = "Custom API";
  try {
    host = new URL(config.apiUrl).host || host;
  } catch {}
  return {
    configured: Boolean(config.apiUrl && config.model),
    host,
    model: config.model,
    provider: inferProvider(config),
    protocol: config.protocol
  };
}

function inferProvider(config) {
  if (isMagpieConnection(config)) return { id: "magpie", name: "Magpie", icon: "" };
  const modelPrefix = config.model.split("/", 1)[0].toLowerCase();
  if (modelPrefix === "openai-codex" || modelPrefix === "openai") {
    return { id: "openai", name: "OpenAI", icon: "assets/providers/openai.svg" };
  }
  try {
    if (new URL(config.apiUrl).hostname === "api.openai.com") {
      return { id: "openai", name: "OpenAI", icon: "assets/providers/openai.svg" };
    }
  } catch {}
  return { id: "custom", name: "AI provider", icon: "" };
}

export function readProviderConfig(storageArea) {
  return new Promise((resolve, reject) => {
    storageArea.get({ [PROVIDER_STORAGE_KEY]: DEFAULT_PROVIDER_CONFIG }, (result) => {
      const error = globalThis.chrome?.runtime?.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(normalizeProviderConfig(result?.[PROVIDER_STORAGE_KEY]));
    });
  });
}

export function writeProviderConfig(storageArea, value) {
  const config = validateProviderConfig(value);
  return new Promise((resolve, reject) => {
    storageArea.set({ [PROVIDER_STORAGE_KEY]: config }, () => {
      const error = globalThis.chrome?.runtime?.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(config);
    });
  });
}

function isAllowedProviderUrl(url) {
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
}

function configError(message) {
  const error = new Error(message);
  error.code = "INVALID_PROVIDER_CONFIG";
  return error;
}
