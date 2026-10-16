import { magpieSessionHeaders } from "./magpie.js";

const REQUEST_TIMEOUT_MS = 180_000;

export async function requestModel(config, request, options = {}) {
  const { endpoint, protocol } = resolveProviderEndpoint(config);
  const controller = createTimeoutController(options.signal, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { ...buildHeaders(config.apiKey), ...magpieSessionHeaders(config, options.sessionId) },
      body: JSON.stringify(buildRequestBody(protocol, config.model, request)),
      signal: controller.signal
    });

    if (!response.ok) {
      const detail = await readLimitedText(response, 16 * 1024);
      throw providerError(response.status, response.statusText, detail);
    }

    const outputText = await readProviderResponse(response, protocol, options.onTextDelta);
    return { outputText, endpoint, protocol, model: config.model };
  } finally {
    controller.cleanup();
  }
}

export async function testProvider(config, options = {}) {
  const result = await listProviderModels(config, options);
  return {
    ok: true,
    modelAvailable: !result.models.length || result.models.includes(config.model),
    modelCount: result.models.length,
    models: result.models
  };
}

export async function listProviderModels(config, options = {}) {
  const { modelsUrl } = resolveProviderEndpoint(config);
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : 15_000;
  const controller = createTimeoutController(options.signal, timeoutMs);
  try {
    const response = await fetch(modelsUrl, {
      method: "GET",
      headers: buildHeaders(config.apiKey),
      signal: controller.signal
    });
    if (!response.ok) {
      const detail = await readLimitedText(response, 8 * 1024);
      throw providerError(response.status, response.statusText, detail);
    }
    const body = await response.json().catch(() => null);
    const models = extractModelIds(body);
    return { ok: true, models, modelCount: models.length };
  } finally {
    controller.cleanup();
  }
}

export function extractModelIds(body) {
  const entries = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.models)
      ? body.models
      : [];
  return [...new Set(entries
    .map((item) => typeof item === "string" ? item : String(item?.id || item?.name || ""))
    .map((id) => id.trim())
    .filter(Boolean))];
}

export function resolveProviderEndpoint(config) {
  const url = new URL(config.apiUrl);
  const path = url.pathname.replace(/\/+$/, "");
  let protocol = config.protocol;
  if (protocol === "auto") {
    protocol = path.endsWith("/chat/completions") ? "chat-completions" : "responses";
  }

  if (protocol === "responses") {
    if (path.endsWith("/chat/completions")) {
      url.pathname = path.slice(0, -"/chat/completions".length) + "/responses";
    } else if (!path.endsWith("/responses")) {
      url.pathname = path ? `${path}/responses` : "/v1/responses";
    }
  } else if (protocol === "chat-completions") {
    if (path.endsWith("/responses")) {
      url.pathname = path.slice(0, -"/responses".length) + "/chat/completions";
    } else if (!path.endsWith("/chat/completions")) {
      url.pathname = path ? `${path}/chat/completions` : "/v1/chat/completions";
    }
  }

  const endpoint = url.toString();
  const models = new URL(endpoint);
  models.pathname = models.pathname
    .replace(/\/chat\/completions\/?$/, "")
    .replace(/\/responses\/?$/, "")
    .replace(/\/+$/, "") + "/models";
  models.search = "";
  return { endpoint, modelsUrl: models.toString(), protocol };
}

function buildRequestBody(protocol, model, request) {
  if (protocol === "chat-completions") {
    return {
      model,
      stream: true,
      messages: [
        { role: "system", content: request.instructions },
        { role: "user", content: request.prompt }
      ]
    };
  }
  return {
    model,
    store: false,
    stream: true,
    instructions: request.instructions,
    input: [{
      role: "user",
      content: [{ type: "input_text", text: request.prompt }]
    }]
  };
}

function buildHeaders(apiKey) {
  const headers = {
    accept: "text/event-stream, application/json",
    "content-type": "application/json"
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

async function readProviderResponse(response, protocol, onTextDelta) {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!response.body) throw new Error("The translation service returned no response body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let initialText = "";
  let initialDone = false;
  while (!initialDone && !initialText.trim()) {
    const first = await reader.read();
    initialDone = first.done;
    initialText += decoder.decode(first.value || new Uint8Array(), { stream: !first.done });
  }

  const looksLikeEventStream = contentType.includes("text/event-stream")
    || /^(?:event|data):/m.test(initialText.trimStart());
  if (!looksLikeEventStream) {
    let bodyText = initialText;
    while (!initialDone) {
      const next = await reader.read();
      initialDone = next.done;
      bodyText += decoder.decode(next.value || new Uint8Array(), { stream: !next.done });
    }
    const text = extractCompleteText(JSON.parse(bodyText), protocol);
    onTextDelta?.(text);
    return text;
  }

  return readEventStream(reader, decoder, initialText, initialDone, protocol, onTextDelta);
}

async function readEventStream(reader, decoder, initialText, initialDone, protocol, onTextDelta) {
  let buffer = "";
  let outputText = "";
  let done = initialDone;
  let value = new Uint8Array();

  while (true) {
    buffer += initialText;
    initialText = "";
    if (!done && !buffer) {
      ({ done, value } = await reader.read());
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    }
    const lines = buffer.split(/\r?\n/);
    buffer = done ? "" : lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.type === "error") throw new Error(event.message || event.code || "Provider stream failed.");
      if (event.type === "response.failed") {
        throw new Error(event.response?.error?.message || event.response?.error?.code || "Provider response failed.");
      }
      const delta = extractStreamDelta(event, protocol);
      if (!delta) continue;
      outputText += delta;
      onTextDelta?.(delta);
    }
    if (done) break;
    ({ done, value } = await reader.read());
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
  }
  return outputText;
}

function extractStreamDelta(event, protocol) {
  if (protocol === "responses") {
    return event.type === "response.output_text.delta" && typeof event.delta === "string"
      ? event.delta
      : "";
  }
  const content = event.choices?.[0]?.delta?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part?.text || "").join("");
  return "";
}

function extractCompleteText(body, protocol) {
  if (protocol === "chat-completions") {
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((part) => part?.text || "").join("");
  }
  if (typeof body?.output_text === "string") return body.output_text;
  const text = (body?.output || [])
    .flatMap((item) => item?.content || [])
    .filter((item) => item?.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
  if (text) return text;
  throw new Error("The translation service returned no text.");
}

function createTimeoutController(externalSignal, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Translation request timed out.")), timeoutMs);
  const abort = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abort);
    }
  };
}

async function readLimitedText(response, limit) {
  const text = await response.text().catch(() => "");
  return text.slice(0, limit).replace(/\s+/g, " ").trim();
}

function providerError(status, statusText, detail) {
  const error = new Error(`Translation service returned ${status} ${statusText}${detail ? `: ${detail}` : ""}`);
  error.code = "PROVIDER_REQUEST_FAILED";
  return error;
}
