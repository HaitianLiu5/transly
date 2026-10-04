import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const ARTICLE_HTML = await readFile(
  new URL("../fixtures/article.html", import.meta.url),
  "utf8"
);
const TWITTER_HTML = await readFile(
  new URL("../fixtures/twitter.html", import.meta.url),
  "utf8"
);
const SUBTITLE_HTML = await readFile(
  new URL("../fixtures/subtitle.html", import.meta.url),
  "utf8"
);
const SUBTITLE_SEMANTIC_HTML = await readFile(
  new URL("../fixtures/subtitle-semantic.html", import.meta.url),
  "utf8"
);
const SUBTITLE_TRACK_HTML = await readFile(
  new URL("../fixtures/subtitle-track.html", import.meta.url),
  "utf8"
);
const SUBTITLE_TARGET_HTML = await readFile(
  new URL("../fixtures/subtitle-target.html", import.meta.url),
  "utf8"
);
const SUBTITLE_TRIGGER_HTML = await readFile(
  new URL("../fixtures/subtitle-trigger.html", import.meta.url),
  "utf8"
);
const SUBTITLE_LONG_HTML = await readFile(
  new URL("../fixtures/subtitle-long.html", import.meta.url),
  "utf8"
);
const SUBTITLE_PREVIEW_HTML = await readFile(
  new URL("../fixtures/subtitle-preview.html", import.meta.url),
  "utf8"
);
const SUBTITLE_DISABLED_TRACK_HTML = await readFile(
  new URL("../fixtures/subtitle-track-disabled.html", import.meta.url),
  "utf8"
);
const SUBTITLE_VIDEO = await readFile(new URL("../fixtures/subtitle.mp4", import.meta.url));
const SUBTITLE_VTT = `WEBVTT

00:00:00.000 --> 00:00:02.500
First caption from the video.

00:00:03.000 --> 00:00:05.500
Second caption from the video.`;
const SUBTITLE_SEMANTIC_VTT = `WEBVTT

00:00:00.000 --> 00:00:02.500
Welcome to the second annual Code with Claude conference,

00:00:02.550 --> 00:00:05.500
where builders share what they learned.`;
const SUBTITLE_TARGET_VTT = `WEBVTT

00:00:00.000 --> 00:00:02.500
这段视频已经有中文字幕。

00:00:03.000 --> 00:00:05.500
因此不需要再次翻译。`;
const SUBTITLE_JSON3 = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 2500, segs: [{ utf8: "First caption from the video." }] },
    { tStartMs: 3000, dDurationMs: 2500, segs: [{ utf8: "Second caption from the video." }] }
  ]
});
const SUBTITLE_LONG_JSON3 = JSON.stringify({
  events: Array.from({ length: 15 }, (_, index) => ({
    tStartMs: index * 60_000,
    dDurationMs: 10_000,
    segs: [{ utf8: `Long cue ${index + 1}.` }]
  }))
});
const API_KEY = "transly-e2e-key";
const MODELS = [
  "openai/gpt-e2e-primary",
  "openai/gpt-e2e-fast",
  "openai/gpt-e2e-balanced",
  "openai/gpt-e2e-precise",
  "openai/gpt-e2e-long-context",
  "openai/gpt-e2e-mini",
  "openai/gpt-e2e-legacy",
  "openai/gpt-image-e2e"
];

export async function startMockProvider({ apiKey = API_KEY } = {}) {
  const state = {
    offline: false,
    failNextTranslation: false,
    failTranslationNumber: 0,
    streamDelayMs: 260,
    abortedTranslations: 0,
    requests: []
  };

  const server = createServer(async (request, response) => {
    setCorsHeaders(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }

    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/article.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(ARTICLE_HTML);
      return;
    }
    if (request.method === "GET" && url.pathname === "/twitter.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(TWITTER_HTML);
      return;
    }
    if (request.method === "GET" && url.pathname === "/subtitle.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(SUBTITLE_HTML);
      return;
    }
    if (request.method === "GET" && url.pathname === "/subtitle-semantic.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(SUBTITLE_SEMANTIC_HTML);
      return;
    }
    if (request.method === "GET" && url.pathname === "/subtitle-track.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(SUBTITLE_TRACK_HTML);
      return;
    }
    if (request.method === "GET" && url.pathname === "/subtitle-target.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(SUBTITLE_TARGET_HTML);
      return;
    }
    if (request.method === "GET" && url.pathname === "/subtitle-trigger.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(SUBTITLE_TRIGGER_HTML);
      return;
    }
    if (request.method === "GET" && url.pathname === "/subtitle-long.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(SUBTITLE_LONG_HTML);
      return;
    }
    if (request.method === "GET" && url.pathname === "/subtitle-preview.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(SUBTITLE_PREVIEW_HTML);
      return;
    }
    if (request.method === "GET" && url.pathname === "/subtitle-track-disabled.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(SUBTITLE_DISABLED_TRACK_HTML);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/timedtext") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(url.searchParams.get("variant") === "long" ? SUBTITLE_LONG_JSON3 : SUBTITLE_JSON3);
      return;
    }
    if (request.method === "GET" && url.pathname === "/captions.vtt") {
      response.writeHead(200, { "content-type": "text/vtt; charset=utf-8" });
      response.end(SUBTITLE_VTT);
      return;
    }
    if (request.method === "GET" && url.pathname === "/captions-semantic.vtt") {
      response.writeHead(200, { "content-type": "text/vtt; charset=utf-8" });
      response.end(SUBTITLE_SEMANTIC_VTT);
      return;
    }
    if (request.method === "GET" && url.pathname === "/captions-target.vtt") {
      response.writeHead(200, { "content-type": "text/vtt; charset=utf-8" });
      response.end(SUBTITLE_TARGET_VTT);
      return;
    }
    if (request.method === "GET" && url.pathname === "/subtitle.mp4") {
      response.writeHead(200, {
        "accept-ranges": "bytes",
        "content-length": SUBTITLE_VIDEO.length,
        "content-type": "video/mp4"
      });
      response.end(SUBTITLE_VIDEO);
      return;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      respondJson(response, 200, { ok: true });
      return;
    }
    if (state.offline && url.pathname.startsWith("/v1/")) {
      respondJson(response, 503, { error: { message: "Provider is offline" } });
      return;
    }
    if (apiKey && url.pathname.startsWith("/v1/") && request.headers.authorization !== `Bearer ${apiKey}`) {
      respondJson(response, 401, { error: { message: "Missing or invalid API key" } });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      state.requests.push({ kind: "models", authorization: request.headers.authorization });
      respondJson(response, 200, { data: MODELS.map((id) => ({ id })) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/responses") {
      const body = JSON.parse(await readRequestBody(request));
      const instructions = String(body.instructions || "");
      const prompt = String(body.input?.[0]?.content?.[0]?.text || "");
      const kind = instructions.includes("webpage translation QA planner") ? "audit" : "translation";
      state.requests.push({
        kind,
        model: body.model,
        authorization: request.headers.authorization,
        instructions,
        prompt
      });

      const translationNumber = state.requests.filter((entry) => entry.kind === "translation").length;
      if (
        kind === "translation"
        && (state.failNextTranslation || state.failTranslationNumber === translationNumber)
      ) {
        state.failNextTranslation = false;
        respondJson(response, 503, { error: { message: "Planned provider outage" } });
        return;
      }

      const output = kind === "audit"
        ? JSON.stringify({ actions: [], notes: [] })
        : JSON.stringify(extractPassages(prompt).map(translatePassage));
      let finished = false;
      response.once("finish", () => { finished = true; });
      response.once("close", () => {
        if (!finished && kind === "translation") state.abortedTranslations++;
      });
      await streamResponse(response, output, kind === "translation" ? state.streamDelayMs : 0);
      return;
    }

    respondJson(response, 404, { error: { message: "Not found" } });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    apiKey,
    apiUrl: `${origin}/v1`,
    articleUrl: `${origin}/article.html`,
    twitterUrl: `${origin}/twitter.html`,
    subtitleUrl: `${origin}/subtitle.html`,
    subtitleSemanticUrl: `${origin}/subtitle-semantic.html`,
    subtitleTrackUrl: `${origin}/subtitle-track.html`,
    subtitleTargetUrl: `${origin}/subtitle-target.html`,
    subtitleTriggerUrl: `${origin}/subtitle-trigger.html`,
    subtitleLongUrl: `${origin}/subtitle-long.html`,
    subtitlePreviewUrl: `${origin}/subtitle-preview.html`,
    subtitleDisabledTrackUrl: `${origin}/subtitle-track-disabled.html`,
    models: MODELS.slice(),
    state,
    translationRequests() {
      return state.requests.filter((request) => request.kind === "translation");
    },
    auditRequests() {
      return state.requests.filter((request) => request.kind === "audit");
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

function setCorsHeaders(response) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "authorization, content-type");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
}

function respondJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function streamResponse(response, output, delayMs) {
  response.writeHead(200, {
    "cache-control": "no-cache",
    "content-type": "text/event-stream; charset=utf-8"
  });

  const chunks = splitJsonOutput(output);
  for (const chunk of chunks) {
    if (response.destroyed) return;
    response.write(`data: ${JSON.stringify({
      type: "response.output_text.delta",
      delta: chunk
    })}\n\n`);
    if (delayMs) await delay(delayMs);
  }
  if (response.destroyed) return;
  response.write("data: [DONE]\n\n");
  response.end();
}

function splitJsonOutput(output) {
  if (!output.startsWith("[")) return [output];
  const values = JSON.parse(output);
  if (!Array.isArray(values) || values.length < 2) return [output];
  return values.map((value, index) => (
    `${index === 0 ? "[" : ""}${index ? "," : ""}${JSON.stringify(value)}${index === values.length - 1 ? "]" : ""}`
  ));
}

function extractPassages(prompt) {
  const source = prompt.split("TEXT TO TRANSLATE\n").at(-1) || "";
  const marker = source.match(/<<<TRANSLY_PASSAGE_BREAK(?:_)*>>>/)?.[0];
  return marker
    ? source.split(marker).map((passage) => passage.trim()).filter(Boolean)
    : [source.trim()].filter(Boolean);
}

function translatePassage(source, index) {
  const placeholders = source.match(/\[\[TRANSLY_PH_\d+]]/g) || [];
  if (source.includes("We take a different view of agent orchestration.")) {
    // Keep only protected structure: a model need not infer lost source newlines.
    return source
      .replace(/\s+/g, " ")
      .replace(/(\[\[TRANSLY_PH_\d+]]) @hatchet_dev (\[\[TRANSLY_PH_\d+]])/, "$1@hatchet_dev$2")
      .replace("We take a different view of agent orchestration.", "我们对智能体编排有不同的看法。")
      .replace("Our plan is:", "我们的计划是：")
      .replace("- Integrate with durable sandbox providers.", "- 与持久化沙箱提供商深度集成。")
      .replace("- Run deterministic tools across distributed compute.", "- 在分布式计算环境中运行确定性工具。")
      .replace("- Keep the orchestration layer open.", "- 保持编排层开放。")
      .replace("We started building this a year ago. Follow", "我们一年前开始构建它。关注")
      .replace("We also preserve ordinary HTML spacing inside this paragraph.", "本段中的普通 HTML 空白仍然合并为空格。");
  }
  if (source.includes("Normal HTML indentation stays within one paragraph.")) {
    return "普通 HTML 缩进仍然保持在同一段中。";
  }
  if (source.includes("First caption from the video")) return "视频中的第一句字幕。";
  if (source.includes("Second caption from the video")) return "视频中的第二句字幕。";
  const longCue = source.match(/Long cue (\d+)\./);
  if (longCue) return `长视频第 ${longCue[1]} 句。`;
  const translations = [
    "上下文让翻译更准确",
    "孤立来看，产品名称可能只有一种含义；放进完整文章后，它往往会变得更精确。",
    "读者在阅读自然流畅的译文时，也应保留原始引用。",
    "模型完成一段后，就应展示完整的译文。",
    "请求失败后，应当可以直接重试，无需重新加载扩展。"
  ];
  return [translations[index] || `第 ${index + 1} 段译文`, ...placeholders].join(" ");
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
