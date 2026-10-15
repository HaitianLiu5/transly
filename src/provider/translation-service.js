import { parseJsonOutput } from "./json-output.js";
import { requestModel } from "./openai-compatible.js";
import { createRequestQueue } from "./request-queue.js";
import { createResponseCache, hashCacheIdentity } from "./response-cache.js";
import { createStreamingStringArrayParser } from "./stream-items.js";
import { assertPlaceholderIntegrity, summarizePlaceholderIntegrity } from "./translation-quality.js";
import { buildTranslationRequest, normalizeTranslationResult } from "./translation-prompt.js";

const CACHE_IDENTITY_VERSION = 2;
const DEFAULT_MAX_CONCURRENT = 5;

export function createTranslationService(options = {}) {
  const modelRequest = options.requestModel || requestModel;
  const queue = options.queue || createRequestQueue(options.maxConcurrent || DEFAULT_MAX_CONCURRENT);
  const responseCache = options.cache || createResponseCache();
  const hotResponses = new Map();
  const inFlightResponses = new Map();

  async function translate(payload, context = {}) {
    validateTranslationPayload(payload);
    const request = buildTranslationRequest(payload);
    const cacheIdentity = payload.cacheKey
      ? await buildCacheIdentity("translation", context.config, payload.cacheKey, request)
      : null;
    return resolveCached(
      cacheIdentity,
      () => translateUncached(payload, request, context, 1),
      { shareInFlight: !context.signal }
    );
  }

  async function translateUncached(payload, preparedRequest, context, attempt) {
    const parser = createStreamingStringArrayParser(payload.items.map((item) => item.id));
    const response = await queue.run(() => modelRequest(context.config, preparedRequest, {
      signal: context.signal,
      sessionId: context.sessionId,
      onTextDelta(delta) {
        const items = parser.push(delta)
          .filter((item) => typeof item.translation === "string")
          .map((item) => ({ id: item.id, translation: item.translation.trim() }));
        if (!items.length) return;
        context.onProgress?.({
          type: "translation-items",
          clientRequestId: payload.clientRequestId || null,
          mode: payload.mode,
          phase: payload.phase || null,
          batchIndex: payload.batchIndex ?? null,
          batchCount: payload.batchCount ?? null,
          items
        });
      }
    }));

    const parsed = parseJsonOutput(response.outputText);
    let result = normalizeTranslationResult(parsed, payload);
    let integrity = summarizePlaceholderIntegrity(payload.items, result.items);
    if (integrity.affectedItemCount && attempt === 1) {
      const affectedIds = new Set(integrity.affectedItemIds);
      const repairPayload = {
        ...payload,
        cacheKey: null,
        placeholderRepair: true,
        phase: `${payload.phase || "translate"}-placeholder-repair`,
        items: payload.items.filter((item) => affectedIds.has(item.id))
      };
      const repaired = await translateUncached(
        repairPayload,
        buildTranslationRequest(repairPayload),
        context,
        attempt + 1
      );
      const repairedById = new Map(repaired.items.map((item) => [item.id, item.translation]));
      result = {
        items: result.items.map((item) => repairedById.has(item.id)
          ? { ...item, translation: repairedById.get(item.id) }
          : item)
      };
      integrity = summarizePlaceholderIntegrity(payload.items, result.items);
    }
    assertPlaceholderIntegrity(integrity);
    return result;
  }

  async function audit(payload, context = {}) {
    validateAuditPayload(payload);
    if (!payload.blocks.length) return { actions: [], notes: ["No blocks to audit."] };
    const prompt = buildAuditPrompt(payload);
    const request = {
      instructions: "Return only valid JSON. Do not include Markdown fences or commentary.",
      prompt
    };
    const cacheIdentity = payload.auditKey
      ? await buildCacheIdentity("article-audit", context.config, payload.auditKey, request)
      : null;
    return resolveCached(cacheIdentity, async () => {
      const response = await queue.run(() => modelRequest(context.config, request, {
        signal: context.signal,
        sessionId: context.sessionId
      }));
      return normalizeAuditResult(parseJsonOutput(response.outputText), payload);
    }, { shareInFlight: !context.signal });
  }

  async function resolveCached(cacheIdentity, produce, options = {}) {
    if (!cacheIdentity) return produce();
    if (hotResponses.has(cacheIdentity)) return hotResponses.get(cacheIdentity);
    const shareInFlight = options.shareInFlight !== false;
    if (shareInFlight && inFlightResponses.has(cacheIdentity)) return inFlightResponses.get(cacheIdentity);

    const operation = (async () => {
      const cached = await responseCache.get(cacheIdentity).catch(() => ({ hit: false }));
      if (cached.hit) {
        rememberHot(cacheIdentity, cached.value);
        return cached.value;
      }
      const value = await produce();
      rememberHot(cacheIdentity, value);
      await responseCache.set(cacheIdentity, value).catch(() => false);
      return value;
    })();
    if (shareInFlight) inFlightResponses.set(cacheIdentity, operation);
    try {
      return await operation;
    } finally {
      if (shareInFlight && inFlightResponses.get(cacheIdentity) === operation) inFlightResponses.delete(cacheIdentity);
    }
  }

  function rememberHot(key, value) {
    hotResponses.set(key, value);
    if (hotResponses.size > 100) hotResponses.delete(hotResponses.keys().next().value);
  }

  return { translate, audit, queueStats: () => queue.stats() };
}

async function buildCacheIdentity(kind, config, clientCacheKey, request) {
  return hashCacheIdentity({
    version: CACHE_IDENTITY_VERSION,
    kind,
    provider: {
      apiUrl: config.apiUrl,
      model: config.model,
      protocol: config.protocol
    },
    clientCacheKey,
    instructions: request.instructions,
    prompt: request.prompt
  });
}

function validateTranslationPayload(payload) {
  if (!payload || typeof payload !== "object") throw requestError("Missing translation payload.");
  if (!Array.isArray(payload.items) || !payload.items.length || payload.items.length > 250) {
    throw requestError("Translation request must contain 1 to 250 items.");
  }
  if (!["article", "selection", "subtitle"].includes(payload.mode)) throw requestError("Unsupported translation mode.");
  if (typeof payload.targetLanguage !== "string" || !payload.targetLanguage || payload.targetLanguage.length > 40) {
    throw requestError("Invalid target language.");
  }
  const ids = new Set();
  let totalChars = 0;
  for (const item of payload.items) {
    if (!item || typeof item.id !== "string" || !item.id || item.id.length > 128 || ids.has(item.id)) {
      throw requestError("Translation item IDs must be unique strings.");
    }
    if (typeof item.text !== "string" || !item.text) throw requestError("Translation item text must be non-empty.");
    ids.add(item.id);
    totalChars += item.text.length;
  }
  if (totalChars > 1_500_000) throw requestError("Translation text is too large.");
}

function validateAuditPayload(payload) {
  if (!payload || typeof payload !== "object") throw requestError("Missing audit payload.");
  if (!Array.isArray(payload.blocks) || payload.blocks.length > 120) {
    throw requestError("Audit request must contain at most 120 blocks.");
  }
  if (typeof payload.targetLanguage !== "string" || !payload.targetLanguage || payload.targetLanguage.length > 40) {
    throw requestError("Invalid target language.");
  }
}

function normalizeAuditResult(parsed, payload) {
  const allowedIds = new Set(payload.blocks.map((block) => block.id));
  const allowedTypes = new Set(["translate_missing", "retranslate", "ignore", "needs_review"]);
  return {
    actions: (parsed?.actions || [])
      .filter((action) => allowedIds.has(action?.blockId) && allowedTypes.has(action?.type))
      .map((action) => ({
        type: action.type,
        blockId: action.blockId,
        confidence: Number.isFinite(Number(action.confidence)) ? Number(action.confidence) : 0,
        reason: String(action.reason || "").slice(0, 500)
      })),
    notes: Array.isArray(parsed?.notes)
      ? parsed.notes.map((note) => String(note).slice(0, 500)).slice(0, 8)
      : []
  };
}

function buildAuditPrompt(payload) {
  const blocks = payload.blocks.map((block) => ({
    id: block.id,
    reason: block.reason,
    path: block.path,
    tag: block.tag,
    textSample: block.textSample,
    textChars: block.textChars,
    hasTranslation: block.hasTranslation,
    sourceLinkCount: block.sourceLinkCount,
    translationLinkCount: block.translationLinkCount,
    translationTextChars: block.translationTextChars,
    rect: block.rect,
    ancestorHints: block.ancestorHints
  }));
  return [
    "You are a webpage translation QA planner.",
    "You do not translate text. You only decide which visible text blocks need repair.",
    `Target language: ${payload.targetLanguage}.`,
    "The JSON shape must be: {\"actions\":[{\"type\":\"translate_missing|retranslate|ignore|needs_review\",\"blockId\":\"...\",\"confidence\":0.0,\"reason\":\"...\"}],\"notes\":[\"...\"]}",
    "",
    "Rules:",
    "- Use translate_missing only for visible article/body content that should have a translation but does not.",
    "- Use retranslate when the block already has a translation but it is likely broken, too short, or lost links.",
    "- Use ignore for navigation, subscribe/paywall widgets, buttons, comments metadata, recommendations, ads, labels, timestamps, and UI chrome.",
    "- Use needs_review if the sample is ambiguous.",
    "- Prefer precision over recall. Never invent block ids.",
    "",
    "Page summary:",
    JSON.stringify(payload.summary || {}),
    "",
    "Blocks JSON:",
    JSON.stringify(blocks)
  ].join("\n");
}

function requestError(message) {
  const error = new Error(message);
  error.code = "INVALID_TRANSLATION_REQUEST";
  return error;
}
