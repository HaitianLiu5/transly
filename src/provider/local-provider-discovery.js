import { extractModelIds } from "./openai-compatible.js";

export const LOCAL_PROVIDER_CANDIDATES = Object.freeze([
  { apiUrl: "http://127.0.0.1:3425/v1", hint: "Magpie" },
  { apiUrl: "http://127.0.0.1:8317/v1", hint: "CLIProxyAPI" },
  { apiUrl: "http://127.0.0.1:1234/v1", hint: "LM Studio" },
  { apiUrl: "http://127.0.0.1:11434/v1", hint: "Ollama" },
  { apiUrl: "http://127.0.0.1:4000/v1", hint: "LiteLLM" },
  { apiUrl: "http://127.0.0.1:8000/v1", hint: "vLLM" },
  { apiUrl: "http://127.0.0.1:8080/v1", hint: "LocalAI or llama.cpp" }
]);

export async function discoverLocalProviders(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const candidates = options.candidates || LOCAL_PROVIDER_CANDIDATES;
  const timeoutMs = options.timeoutMs || 1_200;
  const results = await Promise.all(candidates.map((candidate) => (
    probeCandidate(candidate, { fetchImpl, timeoutMs })
  )));
  return results.filter(Boolean);
}

async function probeCandidate(candidate, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${candidate.apiUrl.replace(/\/+$/, "")}/models`, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: controller.signal
    });
    if (response.status === 401 || response.status === 403) {
      return {
        apiUrl: candidate.apiUrl,
        hint: candidate.hint,
        authRequired: true,
        models: []
      };
    }
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    const models = extractModelIds(body);
    if (!models.length) return null;
    return {
      apiUrl: candidate.apiUrl,
      hint: candidate.hint,
      authRequired: false,
      models
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
