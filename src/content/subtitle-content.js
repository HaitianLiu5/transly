(function initializeSubtitleContentScript(global) {
  const core = global.TranslySubtitleCore;
  if (!core) return;

  const SUBTITLE_MAX_CUES = 5000;
  const CAPTURE_DEBOUNCE_MS = 120;
  const NO_CAPTIONS_TIMEOUT_MS = 6000;
  const SUBTITLE_PREFETCH_BEHIND_SECONDS = 60;
  const SUBTITLE_PREFETCH_AHEAD_SECONDS = 180;
  const SUBTITLE_PRIMARY_WINDOW_SECONDS = 60;
  const SUBTITLE_PRIMARY_MAX_CHARS = 6000;
  const SUBTITLE_PRIMARY_MAX_ITEMS = 40;
  const SUBTITLE_NORMAL_MAX_IN_FLIGHT = 1;
  const SUBTITLE_SEEK_MAX_IN_FLIGHT = 2;
  const DEFAULT_APPEARANCE = Object.freeze({
    subtitleDisplayMode: "bilingual",
    subtitleLanguageOrder: "source-first",
    subtitleSourceFontSizePx: 25,
    subtitleTranslationFontSizePx: 30,
    subtitlePositionPercent: 6,
    subtitleBackgroundOpacity: 0.76
  });
  const trackedVideos = new Map();
  const sourceCueSets = new Map();
  const sourceSessionIds = new Map();
  const targetLanguageSources = new Map();
  const translatedById = new Map();
  const pendingCueIds = new Set();
  const progressRequestRuns = new Map();
  const captureState = global.TranslySubtitleCapture;
  let subtitleEnabled = false;
  let targetLanguage = "zh-CN";
  let activeCues = [];
  let activeSourceKey = "";
  let translationTimer = null;
  let noCaptionsTimer = null;
  let renderFrame = 0;
  let controlsPositionFrame = 0;
  let translationPlanning = false;
  let translationInFlight = 0;
  let translationQueued = false;
  let translationQueuedUrgent = false;
  let subtitleRunId = 0;
  let subtitleStatus = "off";
  let uiLanguage = "auto";
  const PLAYER_TEXT_EN = {
    title: "Translated subtitles",
    settings: "Transly subtitle settings",
    openSettings: "Open subtitle settings",
    turnOn: "Turn on translated subtitles",
    turnOff: "Turn off translated subtitles",
    show: "Show",
    displayMode: "Subtitle display mode",
    original: "Original",
    translation: "Translation",
    both: "Both",
    order: "Order",
    orderGroup: "Bilingual subtitle order",
    originalFirst: "Original first",
    translationFirst: "Translation first",
    textSize: "Text size",
    position: "Position",
    background: "Background",
    statusDetecting: "Looking for captions…",
    statusTranslating: "Translating captions…",
    statusReady: "Showing translated captions",
    statusNative: "Captions are already in your language",
    statusNoCaptions: "This video has no captions to translate",
    failed: "Couldn't translate the captions"
  };
  const PLAYER_TEXT_ZH = {
    title: "翻译字幕",
    settings: "Transly 字幕设置",
    openSettings: "打开字幕设置",
    turnOn: "开启翻译字幕",
    turnOff: "关闭翻译字幕",
    show: "显示",
    displayMode: "字幕显示方式",
    original: "原文",
    translation: "译文",
    both: "双语",
    order: "顺序",
    orderGroup: "双语字幕顺序",
    originalFirst: "原文在上",
    translationFirst: "译文在上",
    textSize: "字号",
    position: "位置",
    background: "背景",
    statusDetecting: "正在查找字幕…",
    statusTranslating: "正在翻译字幕…",
    statusReady: "正在显示翻译字幕",
    statusNative: "字幕已经是目标语言",
    statusNoCaptions: "此视频没有可翻译的字幕",
    failed: "无法翻译字幕"
  };
  let subtitleError = "";
  let subtitleLastError = "";
  let subtitleLastErrorAt = 0;
  let subtitleSourceLanguage = "";
  let subtitleSourceType = "";
  let subtitleSkipReason = "";
  let targetLanguageMediaKey = "";
  let lastDiagnosticSignature = "";
  let videoSequence = 0;
  let observedUrl = location.href;
  let appearance = { ...DEFAULT_APPEARANCE };
  let playerControlsHost = null;
  let playerControlsShadow = null;
  let playerControlsVideo = null;
  let playerPanelOpen = false;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "TRANSLY_TRANSLATION_PROGRESS" && message.data?.mode === "subtitle") {
      renderSubtitleTranslationProgress(message.data);
      return false;
    }

    if (message?.type === "TRANSLY_ENABLE_SUBTITLES") {
      enableSubtitles(message.targetLanguage || targetLanguage)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === "TRANSLY_DISABLE_SUBTITLES") {
      disableSubtitles();
      sendResponse({ ok: true, data: subtitleState() });
      return true;
    }

    if (message?.type === "TRANSLY_GET_SUBTITLE_STATE") {
      sendResponse({ ok: true, data: subtitleState() });
      return true;
    }
    return false;
  });

  if (captureState) {
    captureState.listeners.add(handleCapture);
    for (const capture of captureState.captures) handleCapture(capture);
  }

  observeVideos();
  getSettings().then((settings) => {
    uiLanguage = settings.uiLanguage || uiLanguage;
    targetLanguage = settings.targetLanguage || targetLanguage;
    applyAppearanceSettings(settings);
    if (settings.subtitleEnabled) enableSubtitles(targetLanguage).catch(() => {});
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    const nextSettings = Object.fromEntries(
      Object.entries(changes).map(([key, change]) => [key, change.newValue])
    );
    if (changes.uiLanguage) uiLanguage = changes.uiLanguage.newValue || "auto";
    applyAppearanceSettings(nextSettings);
    if (changes.targetLanguage?.newValue) targetLanguage = changes.targetLanguage.newValue;
    if (!changes.subtitleEnabled) return;
    if (changes.subtitleEnabled.newValue) enableSubtitles(targetLanguage).catch((error) => {
      setSubtitleStatus("error", error);
    });
    else disableSubtitles();
  });

  async function enableSubtitles(language) {
    const languageChanged = targetLanguage !== language;
    targetLanguage = language;
    subtitleEnabled = true;
    if (languageChanged) {
      translatedById.clear();
      pendingCueIds.clear();
      targetLanguageSources.clear();
      targetLanguageMediaKey = "";
      subtitleRunId++;
    }
    setSubtitleStatus(activeCues.length ? "translating" : "detecting");
    ensureCaptionWindow();
    scanVideos();
    activateTextTrackCandidate();
    triggerSiteCaptions();
    chooseBestSource();
    if (activeCues.length) scheduleTranslation();
    else armNoCaptionsTimeout();
    return subtitleState();
  }

  function disableSubtitles() {
    subtitleEnabled = false;
    subtitleRunId++;
    translationQueued = false;
    translationQueuedUrgent = false;
    clearTimeout(translationTimer);
    clearTimeout(noCaptionsTimer);
    translationTimer = null;
    noCaptionsTimer = null;
    cancelAnimationFrame(renderFrame);
    renderFrame = 0;
    restoreTextTracks();
    document.documentElement.dataset.translySubtitlesRendering = "false";
    document.querySelector("#transly-caption-window")?.remove();
    setSubtitleStatus("off");
  }

  function handleCapture(capture) {
    if (!capture || typeof capture.body !== "string") return;
    const cues = core.parseSubtitle(capture.body, capture.url).slice(0, SUBTITLE_MAX_CUES);
    if (!cues.length) return;
    const declaredLanguage = core.subtitleLanguageFromUrl(capture.url);
    const inferredLanguage = core.inferSubtitleLanguage(cues);
    const language = effectiveSubtitleLanguage(declaredLanguage, inferredLanguage);
    const currentVideo = chooseVideo();
    const capturedVideoId = youtubeVideoId(capture.url);
    const mediaKey = capturedVideoId
      ? `youtube:${capturedVideoId}`
      : mediaIdentityForVideo(currentVideo);
    const video = !mediaKey || mediaIdentityForVideo(currentVideo) === mediaKey
      ? currentVideo
      : null;
    if (
      core.sameLanguage(language, targetLanguage)
    ) {
      registerTargetLanguageSource({
        key: `native:${mediaKey || capture.url}`,
        type: "network",
        language: language || targetLanguage,
        video,
        mediaKey,
        updatedAt: Date.now()
      });
      return;
    }
    const key = mediaKey
      ? `network:${mediaKey}:${language || "unknown"}`
      : `network:${capture.url}`;
    sourceCueSets.set(key, {
      key,
      type: "network",
      cues,
      language,
      video,
      mediaKey,
      updatedAt: Date.now()
    });
    chooseBestSource(key);
  }

  function observeVideos() {
    scanVideos();
    const observer = new MutationObserver(() => scanVideos());
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["active", "playing"]
    });
    global.addEventListener("resize", schedulePlayerControlsPosition, { passive: true });
    global.addEventListener("scroll", schedulePlayerControlsPosition, { passive: true, capture: true });
  }

  function scanVideos() {
    if (observedUrl !== location.href) resetForNavigation();
    pruneDisconnectedVideos();
    for (const video of document.querySelectorAll("video")) trackVideo(video);
    ensurePlayerControls();
  }

  function trackVideo(video) {
    if (trackedVideos.has(video)) {
      const record = trackedVideos.get(video);
      record.mediaKey = mediaIdentityForVideo(video);
      observePlayerState(video, record);
      scanTextTracks(video);
      return;
    }
    const record = {
      id: `video-${++videoSequence}`,
      mediaKey: mediaIdentityForVideo(video),
      tracks: new Map(),
      playerRoot: null,
      playerStateObserver: null,
      remove: []
    };
    trackedVideos.set(video, record);
    const refresh = () => scanTextTracks(video);
    const refreshPlayback = () => scheduleTranslation();
    const refreshUrgently = () => scheduleTranslation({ urgent: true });
    video.textTracks?.addEventListener?.("addtrack", refresh);
    video.addEventListener("timeupdate", refreshPlayback);
    video.addEventListener("loadedmetadata", refreshPlayback);
    video.addEventListener("seeking", refreshUrgently);
    video.addEventListener("seeked", refreshUrgently);
    record.remove.push(() => video.textTracks?.removeEventListener?.("addtrack", refresh));
    record.remove.push(() => video.removeEventListener("timeupdate", refreshPlayback));
    record.remove.push(() => video.removeEventListener("loadedmetadata", refreshPlayback));
    record.remove.push(() => video.removeEventListener("seeking", refreshUrgently));
    record.remove.push(() => video.removeEventListener("seeked", refreshUrgently));
    observePlayerState(video, record);
    scanTextTracks(video);
  }

  function observePlayerState(video, record) {
    const playerRoot = video.closest("#movie_player.html5-video-player")
      || youtubePreviewContainer(video);
    if (record.playerRoot === playerRoot) return;
    record.playerStateObserver?.disconnect();
    record.playerRoot = playerRoot;
    record.playerStateObserver = null;
    if (!playerRoot) return;
    record.playerStateObserver = new MutationObserver(() => schedulePlayerControlsPosition());
    record.playerStateObserver.observe(playerRoot, {
      attributes: true,
      attributeFilter: ["class"]
    });
  }

  function scanTextTracks(video) {
    const record = trackedVideos.get(video);
    if (!record?.tracks || !video.textTracks) return;
    for (const track of [...video.textTracks]) {
      if (record.tracks.has(track)) {
        ingestTextTrack(video, track);
        continue;
      }
      const trackRecord = {
        key: `texttrack:${record.id}:${track.language || "unknown"}:${track.label || track.kind || "track"}`,
        restoreMode: null,
        listener: () => ingestTextTrack(video, track)
      };
      record.tracks.set(track, trackRecord);
      track.addEventListener?.("cuechange", trackRecord.listener);
      ingestTextTrack(video, track);
    }
  }

  function pruneDisconnectedVideos() {
    for (const [video, record] of trackedVideos) {
      if (video.isConnected) continue;
      for (const remove of record.remove) remove();
      record.playerStateObserver?.disconnect();
      for (const [track, trackRecord] of record.tracks) {
        track.removeEventListener?.("cuechange", trackRecord.listener);
        sourceCueSets.delete(trackRecord.key);
        sourceSessionIds.delete(trackRecord.key);
      }
      trackedVideos.delete(video);
    }
    if (playerControlsVideo && !playerControlsVideo.isConnected) playerControlsVideo = null;
  }

  function resetForNavigation() {
    observedUrl = location.href;
    subtitleRunId++;
    translatedById.clear();
    pendingCueIds.clear();
    sourceCueSets.clear();
    sourceSessionIds.clear();
    targetLanguageSources.clear();
    activeCues = [];
    activeSourceKey = "";
    targetLanguageMediaKey = "";
    clearSourceMetadata();
    restoreTextTracks();
    if (subtitleEnabled) {
      setSubtitleStatus("detecting");
      armNoCaptionsTimeout();
      setTimeout(() => {
        if (!subtitleEnabled) return;
        activateTextTrackCandidate();
        triggerSiteCaptions();
      }, 0);
    }
  }

  function ingestTextTrack(video, track) {
    const record = trackedVideos.get(video)?.tracks?.get(track);
    if (!record) return;
    const cueList = [...(track.cues || [])];
    if (!cueList.length) return;
    const incoming = cueList.map((cue) => ({
      start: cue.startTime,
      end: cue.endTime,
      text: cue.text
    }));
    const inferredLanguage = core.inferSubtitleLanguage(incoming);
    const language = effectiveSubtitleLanguage(track.language, inferredLanguage);
    if (
      core.sameLanguage(language, targetLanguage)
    ) {
      registerTargetLanguageSource({
        key: `native:${record.key}`,
        type: "texttrack",
        language: language || targetLanguage,
        video,
        mediaKey: trackedVideos.get(video)?.mediaKey || "",
        track,
        updatedAt: Date.now()
      });
      return;
    }
    const previous = sourceCueSets.get(record.key)?.cues || [];
    const cues = core.mergeCues(previous, incoming, SUBTITLE_MAX_CUES);
    sourceCueSets.set(record.key, {
      key: record.key,
      type: "texttrack",
      cues,
      language,
      video,
      mediaKey: trackedVideos.get(video)?.mediaKey || "",
      track,
      updatedAt: Date.now()
    });
    chooseBestSource(record.key);
  }

  function chooseBestSource(preferredKey = "") {
    const currentVideo = chooseVideo();
    const currentMediaKey = mediaIdentityForVideo(currentVideo);
    const allCandidates = [...sourceCueSets.values()];
    const associatedCandidates = currentVideo
      ? allCandidates.filter((source) => (
        source.video === currentVideo
        || Boolean(currentMediaKey && source.mediaKey === currentMediaKey)
      ))
      : allCandidates;
    const candidates = (associatedCandidates.length
      ? associatedCandidates
      : allCandidates.filter((source) => !source.video)
    ).sort((left, right) => (
      sourceScore(right, currentVideo, preferredKey) - sourceScore(left, currentVideo, preferredKey)
    ));
    const newestSource = candidates
      .slice()
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    const targetSource = [...targetLanguageSources.values()]
      .filter((source) => (
        source.video === currentVideo
        || Boolean(currentMediaKey && source.mediaKey === currentMediaKey)
      ))
      .filter((source) => (
        (source.type === "texttrack" && source.track?.mode === "showing")
        || (source.type === "network" && source.updatedAt >= (newestSource?.updatedAt || 0))
      ))
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (targetSource) {
      activateTargetLanguageSource(targetSource);
      return;
    }
    if (!sourceCueSets.size) return;
    const best = candidates[0];
    if (!best?.cues?.length) return;
    activeSourceKey = best.key;
    activeCues = best.cues;
    targetLanguageMediaKey = "";
    subtitleSourceLanguage = best.language || "unknown";
    subtitleSourceType = best.type || "unknown";
    subtitleSkipReason = "";
    clearTimeout(noCaptionsTimer);
    if (subtitleEnabled) {
      setSubtitleStatus(hasAnyTranslation() ? "ready" : "translating");
      scheduleTranslation();
    }
  }

  function registerTargetLanguageSource(source) {
    if (!source?.mediaKey && !source?.video) return;
    targetLanguageSources.set(source.key, source);
    chooseBestSource(source.key);
  }

  function activateTargetLanguageSource(source) {
    const nextMediaKey = source.mediaKey || mediaIdentityForVideo(source.video);
    const changed = targetLanguageMediaKey !== nextMediaKey || subtitleStatus !== "native";
    targetLanguageMediaKey = nextMediaKey;
    subtitleSourceLanguage = source.language || targetLanguage;
    subtitleSourceType = source.type || "unknown";
    subtitleSkipReason = "source-matches-target";
    activeSourceKey = "";
    activeCues = [];
    clearTimeout(translationTimer);
    clearTimeout(noCaptionsTimer);
    translationTimer = null;
    noCaptionsTimer = null;
    translationQueued = false;
    translationQueuedUrgent = false;
    if (changed) {
      subtitleRunId++;
      pendingCueIds.clear();
    }
    restoreTextTracks();
    if (source.type === "texttrack" && source.track) {
      const record = trackedVideos.get(source.video)?.tracks?.get(source.track);
      if (record && record.restoreMode === null) record.restoreMode = source.track.mode;
      source.track.mode = "showing";
    }
    document.documentElement.dataset.translySubtitleCurrentCueState = "native";
    hideCaption(document.querySelector("#transly-caption-window"));
    if (subtitleEnabled) setSubtitleStatus("native");
  }

  function effectiveSubtitleLanguage(declaredLanguage, inferredLanguage) {
    const declared = String(declaredLanguage || "").trim();
    const normalized = declared.toLowerCase().replace(/_/g, "-").split("-")[0];
    const declaredIsKnown = Boolean(
      normalized && !["und", "unknown", "auto", "mul", "zxx"].includes(normalized)
    );
    return declaredIsKnown ? declared : inferredLanguage || "";
  }

  function clearSourceMetadata() {
    subtitleSourceLanguage = "";
    subtitleSourceType = "";
    subtitleSkipReason = "";
  }

  function sourceScore(source, currentVideo, preferredKey) {
    const currentMediaKey = mediaIdentityForVideo(currentVideo);
    const videoBonus = source.video && source.video === currentVideo ? 1_000_000 : 0;
    const mediaBonus = currentMediaKey && source.mediaKey === currentMediaKey ? 500_000 : 0;
    const preferredBonus = source.key === preferredKey ? 100_000 : 0;
    const textTrackBonus = source.type === "texttrack" ? 10_000 : 0;
    return videoBonus + mediaBonus + preferredBonus + textTrackBonus + Math.min(source.cues.length, 9000);
  }

  function scheduleTranslation({ urgent = false } = {}) {
    if (!subtitleEnabled || !activeCues.length) return;
    translationQueued = true;
    translationQueuedUrgent = translationQueuedUrgent || urgent;
    clearTimeout(translationTimer);
    translationTimer = setTimeout(() => {
      translationTimer = null;
      const queuedUrgent = translationQueuedUrgent;
      translationQueued = false;
      translationQueuedUrgent = false;
      translateMissingCues({ urgent: queuedUrgent }).catch((error) => {
        setSubtitleStatus("error", error);
      });
    }, translationQueuedUrgent ? 0 : CAPTURE_DEBOUNCE_MS);
  }

  async function translateMissingCues({ urgent = false } = {}) {
    if (translationPlanning) {
      translationQueued = true;
      translationQueuedUrgent = translationQueuedUrgent || urgent;
      return;
    }
    translationPlanning = true;
    let waitingForCapacity = false;

    try {
      const groups = core.groupCuesByMeaning(activeCues);
      const video = chooseVideo();
      const currentTime = video?.currentTime || 0;
      const playbackGroups = core.selectCueGroupsForPlayback(groups, currentTime, {
        behindSeconds: SUBTITLE_PREFETCH_BEHIND_SECONDS,
        aheadSeconds: SUBTITLE_PREFETCH_AHEAD_SECONDS
      });
      const missingGroups = playbackGroups.filter((group) => (
        group.cues.some((cue) => !translatedById.has(cueStateKey(cue.id)))
        && group.cues.every((cue) => !pendingCueIds.has(cueStateKey(cue.id)))
      ));
      if (!missingGroups.length) {
        if (hasAnyTranslation()) setSubtitleStatus("ready");
        return;
      }

      const settings = await getSettings();
      const maxInFlight = urgent ? SUBTITLE_SEEK_MAX_IN_FLIGHT : SUBTITLE_NORMAL_MAX_IN_FLIGHT;
      const availableSlots = Math.max(0, maxInFlight - translationInFlight);
      if (!availableSlots) {
        translationQueued = true;
        translationQueuedUrgent = translationQueuedUrgent || urgent;
        waitingForCapacity = true;
        return;
      }

      const runId = subtitleRunId;
      const sourceKey = activeSourceKey;
      const mediaKey = activeMediaIdentity();
      const cuesSnapshot = activeCues.slice();
      const batches = core.chunkCueGroupsForPlayback(missingGroups, currentTime, {
        maxChars: Number(settings.subtitleBatchChars || 1200),
        maxItems: Number(settings.subtitleBatchMaxItems || 12),
        primaryBehindSeconds: SUBTITLE_PRIMARY_WINDOW_SECONDS,
        primaryAheadSeconds: SUBTITLE_PRIMARY_WINDOW_SECONDS,
        primaryMaxChars: SUBTITLE_PRIMARY_MAX_CHARS,
        primaryMaxItems: SUBTITLE_PRIMARY_MAX_ITEMS
      });
      const batchesToStart = batches.slice(0, availableSlots);
      if (!batchesToStart.length) return;
      setSubtitleStatus("translating");

      for (const [index, batch] of batchesToStart.entries()) {
        translateCueBatch({
          batch,
          batchIndex: index + 1,
          batchCount: batches.length,
          cuesSnapshot,
          runId,
          sourceKey,
          mediaKey
        });
      }
    } finally {
      translationPlanning = false;
      if (translationQueued && !waitingForCapacity && subtitleEnabled) {
        scheduleTranslation({ urgent: translationQueuedUrgent });
      }
    }
  }

  function sourceSessionId(sourceKey) {
    if (!sourceSessionIds.has(sourceKey)) sourceSessionIds.set(sourceKey, crypto.randomUUID());
    return sourceSessionIds.get(sourceKey);
  }

  async function translateCueBatch({ batch, batchIndex, batchCount, cuesSnapshot, runId, sourceKey, mediaKey }) {
    const requestedCues = batch.slice();
    const clientRequestId = `subtitle-${crypto.randomUUID()}`;
    let succeeded = false;
    translationInFlight++;
    for (const cue of requestedCues) pendingCueIds.add(cueStateKey(cue.id, mediaKey));
    progressRequestRuns.set(clientRequestId, { runId, sourceKey, mediaKey });

    try {
      const source = sourceCueSets.get(sourceKey);
      const videoMetadata = subtitleVideoMetadata(chooseVideo());
      const cacheKey = await sha256([
        "subtitle-v3",
        targetLanguage,
        source?.language || "unknown",
        source?.mediaKey || videoMetadata.title || location.href,
        batch.map((cue) => `${cue.subtitleGroup}:${cue.text}`).join("\n")
      ].join("\n"));
      const response = await requestTranslation({
        mode: "subtitle",
        phase: "translate",
        clientRequestId,
        sessionId: sourceSessionId(sourceKey),
        batchIndex,
        batchCount,
        sourceBlockCount: cuesSnapshot.length,
        targetLanguage,
        url: location.href,
        title: videoMetadata.title || document.title,
        context: buildSubtitleContext(cuesSnapshot, batch, videoMetadata),
        cacheKey,
        items: batch.map(({ id, text, subtitleGroup }) => ({ id, text, subtitleGroup }))
      });
      if (runId !== subtitleRunId || sourceKey !== activeSourceKey) return;
      applyTranslations(response.items, mediaKey);
      succeeded = true;
      setSubtitleStatus("ready");
    } catch (error) {
      if (runId === subtitleRunId && sourceKey === activeSourceKey) {
        rememberSubtitleError(error);
        if (hasAnyTranslation()) setSubtitleStatus("ready");
        else setSubtitleStatus("error", error);
      }
    } finally {
      progressRequestRuns.delete(clientRequestId);
      for (const cue of requestedCues) pendingCueIds.delete(cueStateKey(cue.id, mediaKey));
      translationInFlight = Math.max(0, translationInFlight - 1);
      if (succeeded && runId === subtitleRunId && sourceKey === activeSourceKey && subtitleEnabled) {
        scheduleTranslation({ urgent: translationQueuedUrgent });
      }
    }
  }

  function renderSubtitleTranslationProgress(data) {
    const requestRun = progressRequestRuns.get(data?.clientRequestId);
    if (
      !subtitleEnabled
      || !Array.isArray(data?.items)
      || requestRun?.runId !== subtitleRunId
      || requestRun?.sourceKey !== activeSourceKey
    ) return;
    applyTranslations(data.items, requestRun.mediaKey);
    if (hasAnyTranslation()) setSubtitleStatus("ready");
  }

  function applyTranslations(items, mediaKey = activeMediaIdentity()) {
    for (const item of items || []) {
      const translation = core.compactText(item?.translation);
      if (item?.id && translation) translatedById.set(cueStateKey(item.id, mediaKey), translation);
    }
  }

  function ensureCaptionWindow() {
    let node = document.querySelector("#transly-caption-window");
    if (!node) {
      node = document.createElement("div");
      node.id = "transly-caption-window";
      node.className = "notranslate";
      node.setAttribute("translate", "no");
      node.innerHTML = "<div class=\"transly-caption-original\"></div><div class=\"transly-caption-translation\"></div>";
      document.documentElement.appendChild(node);
    }
    applyAppearanceToCaption(node);
    if (!renderFrame) renderLoop();
    return node;
  }

  function renderLoop() {
    renderCaption();
    positionPlayerControls();
    renderFrame = requestAnimationFrame(renderLoop);
  }

  function renderCaption() {
    const windowEl = document.querySelector("#transly-caption-window");
    const video = chooseVideo();
    if (!subtitleEnabled || !windowEl || !video || !activeCues.length) {
      hideCaption(windowEl);
      return;
    }
    const cue = core.activeCueAt(activeCues, video.currentTime || 0);
    const translation = cue ? translatedById.get(cueStateKey(cue.id)) : "";
    if (!cue || !translation) {
      const cueState = cue ? "pending" : "none";
      if (document.documentElement.dataset.translySubtitleCurrentCueState !== cueState) {
        document.documentElement.dataset.translySubtitleCurrentCueState = cueState;
        if (cue) scheduleTranslation({ urgent: true });
      }
      if (cue && subtitleStatus === "ready") setSubtitleStatus("translating");
      hideCaption(windowEl);
      return;
    }

    document.documentElement.dataset.translySubtitleCurrentCueState = "translated";

    const rect = video.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 80 || rect.bottom <= 0 || rect.top >= innerHeight) {
      hideCaption(windowEl);
      return;
    }
    const inset = subtitleBottomInset(video, rect);
    applyCaptionContext(windowEl, video, rect);
    windowEl.style.display = "flex";
    windowEl.style.left = `${rect.left + rect.width / 2}px`;
    windowEl.style.bottom = `${Math.max(12, innerHeight - rect.bottom + inset)}px`;
    windowEl.style.maxWidth = `${Math.min(980, Math.max(240, rect.width * 0.9))}px`;
    windowEl.querySelector(".transly-caption-original").textContent = cue.text;
    windowEl.querySelector(".transly-caption-translation").textContent = translation;
    document.documentElement.dataset.translySubtitlesRendering = "true";
    hideSelectedTextTrack();
  }

  function ensurePlayerControls() {
    const video = chooseVideo();
    if (!video) {
      switchActiveVideo(null);
      if (playerControlsHost) playerControlsHost.style.display = "none";
      setPlayerPanelOpen(false);
      return;
    }
    switchActiveVideo(video);
    if (!playerControlsHost) createPlayerControls();

    if (playerControlsHost.parentElement !== document.documentElement) {
      document.documentElement.appendChild(playerControlsHost);
    }
    playerControlsHost.dataset.placement = "floating";
    playerControlsHost.dataset.context = youtubePreviewForVideo(video) ? "preview" : "playback";
    updatePlayerControls();
    schedulePlayerControlsPosition();
  }

  function switchActiveVideo(video) {
    if (playerControlsVideo === video) return;
    playerControlsVideo = video;
    subtitleRunId++;
    pendingCueIds.clear();
    activeSourceKey = "";
    activeCues = [];
    targetLanguageMediaKey = "";
    document.documentElement.dataset.translySubtitleCurrentCueState = "none";
    clearSourceMetadata();
    if (!subtitleEnabled || !video) return;
    setSubtitleStatus("detecting");
    chooseBestSource();
    if (!activeCues.length) {
      activateTextTrackCandidate();
      triggerSiteCaptions();
      armNoCaptionsTimeout();
    }
  }

  function createPlayerControls() {
    playerControlsHost = document.createElement("div");
    playerControlsHost.id = "transly-subtitle-controls";
    playerControlsHost.className = "notranslate";
    playerControlsHost.setAttribute("translate", "no");
    playerControlsShadow = playerControlsHost.attachShadow({ mode: "open" });
    playerControlsShadow.innerHTML = `
      <style>
        :host { color-scheme: dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        :host([data-placement="floating"]) { position: fixed; z-index: 2147483647; display: flex; }
        .control {
          position: relative; display: flex; align-items: center; height: 36px;
          border-radius: 18px; background: rgba(0,0,0,.5);
          box-shadow: inset 0 0 0 1px rgba(255,255,255,.06);
          -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); overflow: visible;
        }
        button { box-sizing: border-box; border: 0; color: rgba(255,255,255,.88); background: transparent; font: inherit; cursor: pointer; }
        button:hover { background: rgba(255,255,255,.1); }
        button:focus-visible { outline: 2px solid #fff; outline-offset: -4px; }
        .menu-trigger {
          position: relative; display: flex; align-items: center; justify-content: center; gap: 4px;
          width: 52px; height: 36px; padding: 0 6px; border-radius: 18px;
        }
        :host([data-context="preview"]) .control,
        :host([data-context="preview"]) .menu-trigger { width: 36px; border-radius: 50%; }
        :host([data-context="preview"]) .menu-trigger { padding: 0; }
        :host([data-context="preview"]) .brand-icon { width: 20px; height: 20px; }
        :host([data-context="preview"]) .caret,
        :host([data-context="preview"]) .panel { display: none !important; }
        :host([data-context="preview"]) .status-dot { left: 25px; top: 2px; }
        .brand-icon { display: block; width: 22px; height: 22px; opacity: .82; }
        .status-dot { position: absolute; left: 25px; top: 3px; width: 4px; height: 4px; border-radius: 50%; background: transparent; }
        :host([data-state="detecting"]) .status-dot,
        :host([data-state="translating"]) .status-dot { background: #f5b800; animation: pulse 1s ease-in-out infinite; }
        :host([data-state="ready"]) .status-dot,
        :host([data-state="native"]) .status-dot {
          left: 24px; top: 0; width: 7px; height: 4px; border-radius: 0;
          border-right: 1.5px solid #22c55e; border-bottom: 1.5px solid #22c55e;
          background: transparent; transform: rotate(45deg);
        }
        :host([data-state="error"]) .status-dot { background: #ef4444; }
        :host([data-state="no-captions"]) .status-dot { background: rgba(255,255,255,.42); }
        :host([data-enabled="true"]) .brand-icon { opacity: 1; }
        .caret { display: inline-block; width: 5px; height: 5px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; opacity: .68; transform: translateY(-1px) rotate(45deg); }
        .panel {
          position: absolute; right: 0; bottom: calc(100% + 8px); width: 304px; box-sizing: border-box;
          padding: 4px; border: 1px solid rgba(255,255,255,.12); border-radius: 14px;
          background: rgba(26,26,28,.94); color: #f4f4f2; box-shadow: 0 18px 48px rgba(0,0,0,.45);
          -webkit-backdrop-filter: blur(20px) saturate(140%); backdrop-filter: blur(20px) saturate(140%);
          max-height: var(--transly-panel-max-height, 420px); overflow-y: auto;
          font-size: 13px; line-height: 1.4; -webkit-font-smoothing: antialiased;
          scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.24) transparent;
        }
        .panel[hidden] { display: none; }
        .section { padding: 12px; }
        .section + .section { border-top: 1px solid rgba(255,255,255,.08); }
        .enable-setting { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
        .enable-label { font-size: 14px; font-weight: 600; }
        .status { display: flex; align-items: center; gap: 7px; margin: 6px 0 0; color: rgba(255,255,255,.66); font-size: 12px; }
        .status[hidden] { display: none; }
        .status-indicator { width: 6px; height: 6px; flex: none; border-radius: 50%; background: rgba(255,255,255,.45); }
        :host([data-state="detecting"]) .status-indicator,
        :host([data-state="translating"]) .status-indicator { background: #f5b800; animation: pulse 1s ease-in-out infinite; }
        :host([data-state="ready"]) .status-indicator,
        :host([data-state="native"]) .status-indicator { background: #22c55e; }
        :host([data-state="error"]) .status-indicator { background: #ef4444; }
        :host([data-state="error"]) .status-text { color: #fca5a5; }
        .error { margin: 8px 0 0; padding: 6px 8px; border-radius: 7px; background: rgba(239,68,68,.12); color: #fecaca; font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
        .error:empty { display: none; }
        .subtitle-switch { position: relative; width: 36px; height: 22px; flex: 0 0 auto; padding: 0; border-radius: 11px; background: rgba(255,255,255,.2); }
        .subtitle-switch:hover { background: rgba(255,255,255,.28); }
        .subtitle-switch::after { content: ""; position: absolute; left: 3px; top: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform 140ms ease; }
        .subtitle-switch[aria-checked="true"] { background: #fff; }
        .subtitle-switch[aria-checked="true"]::after { background: #111; transform: translateX(14px); }
        .setting-label { display: block; margin: 0 0 7px; color: rgba(255,255,255,.6); font-size: 12px; }
        .segment { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 2px; padding: 2px; border-radius: 8px; background: rgba(255,255,255,.08); }
        .segment.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .segment button { height: 28px; padding: 0 6px; border-radius: 6px; color: rgba(255,255,255,.76); font-size: 12px; white-space: nowrap; }
        .segment button:hover { background: rgba(255,255,255,.08); }
        .segment button[aria-pressed="true"] { color: #111; background: rgba(255,255,255,.94); font-weight: 600; }
        .order-setting { margin-top: 12px; }
        .order-setting[hidden] { display: none; }
        .sliders { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 18px; }
        .sliders-title { grid-column: 1 / -1; margin-bottom: -8px; }
        .slider-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 7px; }
        .slider-head label { overflow: hidden; color: rgba(255,255,255,.84); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
        output { color: #f4f4f2; font-size: 12px; font-variant-numeric: tabular-nums; }
        input[type="range"] { --fill: 50%; display: block; width: 100%; height: 16px; margin: 0; background: transparent; cursor: pointer; -webkit-appearance: none; appearance: none; }
        input[type="range"]::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: linear-gradient(to right, #fff var(--fill), rgba(255,255,255,.18) var(--fill)); }
        input[type="range"]::-webkit-slider-thumb { width: 14px; height: 14px; margin-top: -5px; border: 0; border-radius: 50%; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.5); -webkit-appearance: none; appearance: none; }
        input[type="range"]::-moz-range-track { height: 4px; border-radius: 2px; background: rgba(255,255,255,.18); }
        input[type="range"]::-moz-range-progress { height: 4px; border-radius: 2px; background: #fff; }
        input[type="range"]::-moz-range-thumb { width: 14px; height: 14px; border: 0; border-radius: 50%; background: #fff; }
        input[type="range"]:focus-visible { outline: none; }
        input[type="range"]:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 3px rgba(255,196,26,.6); }
        @keyframes pulse { 50% { opacity: .32; } }
      </style>
      <div class="control">
        <button class="menu-trigger" type="button" aria-label="Transly subtitle settings" title="Transly subtitle settings" aria-expanded="false">
          <img class="brand-icon" src="${chrome.runtime.getURL("assets/icons/transly-player.svg")}" alt="" aria-hidden="true">
          <span class="status-dot" aria-hidden="true"></span>
          <span class="caret" aria-hidden="true"></span>
        </button>
        <div class="panel" hidden>
          <div class="section">
            <div class="enable-setting">
              <span class="enable-label" data-label="title"></span>
              <button class="subtitle-switch" type="button" role="switch" aria-checked="false"></button>
            </div>
            <p class="status" role="status" hidden><span class="status-indicator" aria-hidden="true"></span><span class="status-text"></span></p>
            <p class="error"></p>
          </div>
          <div class="section">
            <span class="setting-label" data-label="show"></span>
            <div class="segment" data-label-aria="displayMode">
              <button type="button" data-mode="source-only" aria-pressed="false" data-label="original"></button>
              <button type="button" data-mode="translation-only" aria-pressed="false" data-label="translation"></button>
              <button type="button" data-mode="bilingual" aria-pressed="true" data-label="both"></button>
            </div>
            <div class="order-setting">
              <span class="setting-label" data-label="order"></span>
              <div class="segment two" data-label-aria="orderGroup">
                <button type="button" data-order="source-first" aria-pressed="true" data-label="originalFirst"></button>
                <button type="button" data-order="translation-first" aria-pressed="false" data-label="translationFirst"></button>
              </div>
            </div>
          </div>
          <div class="section sliders">
            <span class="setting-label sliders-title" data-label="textSize"></span>
            <div class="slider">
              <div class="slider-head"><label for="transly-source-size" data-label="original"></label><output data-output="subtitleSourceFontSizePx"></output></div>
              <input id="transly-source-size" data-setting="subtitleSourceFontSizePx" type="range" min="14" max="56" step="1">
            </div>
            <div class="slider">
              <div class="slider-head"><label for="transly-translation-size" data-label="translation"></label><output data-output="subtitleTranslationFontSizePx"></output></div>
              <input id="transly-translation-size" data-setting="subtitleTranslationFontSizePx" type="range" min="14" max="56" step="1">
            </div>
            <div class="slider">
              <div class="slider-head"><label for="transly-position" data-label="position"></label><output data-output="subtitlePositionPercent"></output></div>
              <input id="transly-position" data-setting="subtitlePositionPercent" type="range" min="2" max="30" step="1">
            </div>
            <div class="slider">
              <div class="slider-head"><label for="transly-background" data-label="background"></label><output data-output="subtitleBackgroundOpacity"></output></div>
              <input id="transly-background" data-setting="subtitleBackgroundOpacity" type="range" min="0" max="0.9" step="0.05">
            </div>
          </div>
        </div>
      </div>
    `;

    const menuTrigger = playerControlsShadow.querySelector(".menu-trigger");
    menuTrigger.addEventListener("click", (event) => {
      event.stopPropagation();
      if (playerControlsHost.dataset.context === "preview") {
        setSubtitleEnabledFromPlayer(!subtitleEnabled).catch((error) => setSubtitleStatus("error", error));
        return;
      }
      setPlayerPanelOpen(!playerPanelOpen);
    });
    playerControlsShadow.querySelector(".subtitle-switch").addEventListener("click", () => {
      setSubtitleEnabledFromPlayer(!subtitleEnabled).catch((error) => setSubtitleStatus("error", error));
    });
    playerControlsShadow.querySelector(".panel").addEventListener("click", (event) => event.stopPropagation());
    for (const button of playerControlsShadow.querySelectorAll("[data-mode]")) {
      button.addEventListener("click", () => saveAppearance({ subtitleDisplayMode: button.dataset.mode }));
    }
    for (const button of playerControlsShadow.querySelectorAll("[data-order]")) {
      button.addEventListener("click", () => saveAppearance({ subtitleLanguageOrder: button.dataset.order }));
    }
    for (const input of playerControlsShadow.querySelectorAll("input[data-setting]")) {
      input.addEventListener("input", () => saveAppearance({ [input.dataset.setting]: Number(input.value) }));
    }
    document.addEventListener("pointerdown", closePlayerPanelOnOutsideClick, true);
    updatePlayerControls();
  }

  function closePlayerPanelOnOutsideClick(event) {
    if (!playerPanelOpen || event.composedPath().includes(playerControlsHost)) return;
    setPlayerPanelOpen(false);
  }

  function setPlayerPanelOpen(open) {
    playerPanelOpen = open && playerControlsHost?.dataset.context !== "preview";
    if (!playerControlsShadow) return;
    playerControlsShadow.querySelector(".panel").hidden = !playerPanelOpen;
    playerControlsShadow.querySelector(".menu-trigger").setAttribute("aria-expanded", String(playerPanelOpen));
    schedulePlayerControlsPosition();
  }

  async function setSubtitleEnabledFromPlayer(enabled) {
    setSubtitleStatus(enabled ? "detecting" : "off");
    const response = await saveSettings({ subtitleEnabled: enabled, targetLanguage });
    if (response?.ok === false) throw new Error(response.error || "Could not save subtitle setting");
    if (enabled) await enableSubtitles(targetLanguage);
    else disableSubtitles();
  }

  function schedulePlayerControlsPosition() {
    if (controlsPositionFrame) return;
    controlsPositionFrame = requestAnimationFrame(() => {
      controlsPositionFrame = 0;
      positionPlayerControls();
    });
  }

  function positionPlayerControls() {
    if (!playerControlsHost?.isConnected) return;
    const video = chooseVideo();
    if (!video) {
      if (playerControlsHost.dataset.placement === "floating") playerControlsHost.style.display = "none";
      return;
    }
    switchActiveVideo(video);
    const rect = video.getBoundingClientRect();
    if (playerControlsHost.dataset.placement !== "floating") return;
    const preview = youtubePreviewForVideo(video);
    if (preview) {
      const ccControl = preview.querySelector(
        "yt-inline-player-controls yt-closed-captions-toggle-button, yt-closed-captions-toggle-button"
      );
      const ccRect = ccControl?.getBoundingClientRect();
      if (!ccRect || ccRect.width < 1 || ccRect.height < 1) {
        playerControlsHost.style.display = "none";
        return;
      }
      playerControlsHost.dataset.context = "preview";
      playerControlsHost.style.display = "flex";
      const controlRect = playerControlsHost.getBoundingClientRect();
      const controlWidth = controlRect.width || 36;
      const controlHeight = controlRect.height || 36;
      playerControlsHost.style.left = `${ccRect.left + (ccRect.width - controlWidth) / 2}px`;
      playerControlsHost.style.top = `${ccRect.bottom + 6}px`;
      playerControlsHost.style.setProperty("--transly-panel-max-height", "0px");
      return;
    }
    playerControlsHost.dataset.context = "playback";
    const youtubePlayer = video.closest("#movie_player.html5-video-player");
    if (youtubePlayer?.classList.contains("ytp-autohide") && !playerPanelOpen) {
      playerControlsHost.style.display = "none";
      return;
    }
    if (rect.width < 180 || rect.height < 100 || rect.bottom <= 0 || rect.top >= innerHeight) {
      playerControlsHost.style.display = "none";
      return;
    }
    playerControlsHost.style.display = "flex";
    const controlWidth = playerControlsHost.getBoundingClientRect().width || 52;
    const youtubeControls = youtubePlayer?.querySelector(".ytp-right-controls");
    const youtubeControlsRect = youtubeControls?.getBoundingClientRect();
    const hasVisibleYoutubeControls = youtubeControlsRect
      && youtubeControlsRect.width > 0
      && youtubeControlsRect.height > 0;
    const controlHeight = playerControlsHost.getBoundingClientRect().height || 36;
    const controlTop = hasVisibleYoutubeControls
      ? youtubeControlsRect.top + (youtubeControlsRect.height - controlHeight) / 2
      : rect.bottom - controlHeight - 12;
    const controlLeft = hasVisibleYoutubeControls
      ? youtubeControlsRect.left - controlWidth - 8
      : rect.right - controlWidth - 16;
    playerControlsHost.style.left = `${Math.max(8, controlLeft)}px`;
    playerControlsHost.style.top = `${controlTop}px`;
    playerControlsHost.style.setProperty(
      "--transly-panel-max-height",
      `${Math.max(120, Math.min(420, controlTop - 16))}px`
    );
  }

  function applyAppearanceSettings(settings) {
    appearance = {
      subtitleDisplayMode: allowedSetting(
        settings.subtitleDisplayMode,
        ["bilingual", "source-only", "translation-only"],
        appearance.subtitleDisplayMode
      ),
      subtitleLanguageOrder: allowedSetting(
        settings.subtitleLanguageOrder,
        ["source-first", "translation-first"],
        appearance.subtitleLanguageOrder
      ),
      subtitleSourceFontSizePx: subtitleFontSize(
        settings,
        "subtitleSourceFontSizePx",
        "subtitleSourceFontScale",
        appearance.subtitleSourceFontSizePx
      ),
      subtitleTranslationFontSizePx: subtitleFontSize(
        settings,
        "subtitleTranslationFontSizePx",
        "subtitleTranslationFontScale",
        appearance.subtitleTranslationFontSizePx
      ),
      subtitlePositionPercent: clampNumber(settings.subtitlePositionPercent, 2, 30, appearance.subtitlePositionPercent),
      subtitleBackgroundOpacity: clampNumber(settings.subtitleBackgroundOpacity, 0, 0.9, appearance.subtitleBackgroundOpacity)
    };
    applyAppearanceToCaption(document.querySelector("#transly-caption-window"));
    updatePlayerControls();
  }

  function applyAppearanceToCaption(node) {
    if (!node) return;
    node.dataset.displayMode = appearance.subtitleDisplayMode;
    node.dataset.languageOrder = appearance.subtitleLanguageOrder;
    node.style.setProperty(
      "--transly-subtitle-source-font-size",
      `${appearance.subtitleSourceFontSizePx}px`
    );
    node.style.setProperty(
      "--transly-subtitle-translation-font-size",
      `${appearance.subtitleTranslationFontSizePx}px`
    );
    node.style.setProperty("--transly-subtitle-background-opacity", String(appearance.subtitleBackgroundOpacity));
  }

  function applyCaptionContext(node, video, rect) {
    const preview = youtubePreviewForVideo(video);
    node.dataset.context = preview ? "preview" : "playback";
    if (!preview) {
      node.style.removeProperty("--transly-rendered-source-font-size");
      node.style.removeProperty("--transly-rendered-translation-font-size");
      return;
    }
    node.style.setProperty(
      "--transly-rendered-source-font-size",
      `${Math.round(clampNumber(rect.width * 0.035, 13, 18, 15))}px`
    );
    node.style.setProperty(
      "--transly-rendered-translation-font-size",
      `${Math.round(clampNumber(rect.width * 0.042, 15, 21, 17))}px`
    );
  }

  function updatePlayerControls() {
    if (!playerControlsHost || !playerControlsShadow) return;
    playerControlsHost.dataset.enabled = String(subtitleEnabled);
    playerControlsHost.dataset.state = subtitleStatus;
    const toggle = playerControlsShadow.querySelector(".subtitle-switch");
    const action = playerText(subtitleEnabled ? "turnOff" : "turnOn");
    const menuTrigger = playerControlsShadow.querySelector(".menu-trigger");
    const stateLabel = subtitleStatusLabel();
    menuTrigger.setAttribute(
      "aria-label",
      playerControlsHost.dataset.context === "preview" ? action : playerText("settings")
    );
    menuTrigger.title = stateLabel
      ? `${stateLabel}. ${playerControlsHost.dataset.context === "preview" ? action : playerText("openSettings")}`
      : playerControlsHost.dataset.context === "preview" ? action : playerText("settings");
    toggle.setAttribute("aria-label", action);
    toggle.setAttribute("aria-checked", String(subtitleEnabled));
    for (const node of playerControlsShadow.querySelectorAll("[data-label]")) {
      node.textContent = playerText(node.dataset.label);
    }
    for (const node of playerControlsShadow.querySelectorAll("[data-label-aria]")) {
      node.setAttribute("aria-label", playerText(node.dataset.labelAria));
    }
    const status = playerControlsShadow.querySelector(".status");
    status.hidden = subtitleStatus === "off" || !subtitleStatusMessage();
    status.querySelector(".status-text").textContent = subtitleStatusMessage();
    for (const button of playerControlsShadow.querySelectorAll("[data-mode]")) {
      button.setAttribute("aria-pressed", String(button.dataset.mode === appearance.subtitleDisplayMode));
    }
    for (const button of playerControlsShadow.querySelectorAll("[data-order]")) {
      button.setAttribute("aria-pressed", String(button.dataset.order === appearance.subtitleLanguageOrder));
    }
    playerControlsShadow.querySelector(".order-setting").hidden = appearance.subtitleDisplayMode !== "bilingual";
    for (const input of playerControlsShadow.querySelectorAll("input[data-setting]")) {
      input.value = String(appearance[input.dataset.setting]);
      const min = Number(input.min);
      const fill = ((Number(input.value) - min) / (Number(input.max) - min)) * 100;
      input.style.setProperty("--fill", `${Math.round(fill)}%`);
    }
    const sourceFontOutput = playerControlsShadow.querySelector('[data-output="subtitleSourceFontSizePx"]');
    const translationFontOutput = playerControlsShadow.querySelector('[data-output="subtitleTranslationFontSizePx"]');
    const positionOutput = playerControlsShadow.querySelector('[data-output="subtitlePositionPercent"]');
    const backgroundOutput = playerControlsShadow.querySelector('[data-output="subtitleBackgroundOpacity"]');
    sourceFontOutput.value = `${Math.round(appearance.subtitleSourceFontSizePx)}px`;
    translationFontOutput.value = `${Math.round(appearance.subtitleTranslationFontSizePx)}px`;
    positionOutput.value = `${Math.round(appearance.subtitlePositionPercent)}%`;
    backgroundOutput.value = `${Math.round(appearance.subtitleBackgroundOpacity * 100)}%`;
    playerControlsShadow.querySelector(".error").textContent = subtitleStatus === "error" ? subtitleError : "";
  }

  function saveAppearance(patch) {
    applyAppearanceSettings(patch);
    saveSettings(patch).catch((error) => setSubtitleStatus("error", error));
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  }

  function subtitleFontSize(settings, pixelKey, legacyScaleKey, fallback) {
    if (settings[pixelKey] !== undefined) return clampNumber(settings[pixelKey], 14, 56, fallback);
    if (settings[legacyScaleKey] !== undefined) {
      return clampNumber(Math.round(Number(settings[legacyScaleKey]) * 30), 14, 56, fallback);
    }
    return fallback;
  }

  function allowedSetting(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
  }

  function hideCaption(windowEl) {
    if (windowEl) windowEl.style.display = "none";
    document.documentElement.dataset.translySubtitlesRendering = "false";
  }

  function subtitleBottomInset(video, rect) {
    const preferredInset = Math.max(12, rect.height * (appearance.subtitlePositionPercent / 100));
    const youtubePlayer = video.closest(".html5-video-player");
    if (!youtubePlayer || youtubePlayer.classList.contains("ytp-autohide")) return preferredInset;
    return preferredInset + Math.min(72, Math.max(48, rect.height * 0.08));
  }

  function chooseVideo() {
    return [...trackedVideos.keys()]
      .filter((video) => video.isConnected && isEligibleVideo(video))
      .map((video) => {
        const rect = video.getBoundingClientRect();
        const visibleWidth = Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left));
        const visibleHeight = Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
        const playingBonus = !video.paused && !video.ended ? 1_000_000_000 : 0;
        return { video, score: playingBonus + visibleWidth * visibleHeight };
      })
      .sort((left, right) => right.score - left.score)[0]?.video || null;
  }

  function isEligibleVideo(video) {
    const preview = youtubePreviewContainer(video);
    if (preview) return Boolean(youtubePreviewForVideo(video));
    const hostname = location.hostname.toLowerCase();
    const isYouTube = hostname === "youtube.com"
      || hostname.endsWith(".youtube.com")
      || hostname === "youtube-nocookie.com"
      || hostname.endsWith(".youtube-nocookie.com");
    if (isYouTube) {
      const path = location.pathname;
      const isPlaybackPage = path === "/watch"
        || path.startsWith("/embed/")
        || path.startsWith("/live/")
        || path.startsWith("/shorts/")
        || path.startsWith("/clip/");
      if (!isPlaybackPage) return false;
    }

    const youtubePlayer = video.closest(".html5-video-player");
    return !youtubePlayer || youtubePlayer.id === "movie_player";
  }

  function youtubePreviewContainer(video) {
    return video?.closest?.("ytd-video-preview") || null;
  }

  function youtubePreviewForVideo(video) {
    const preview = youtubePreviewContainer(video);
    if (!preview?.hasAttribute("active") || !preview.hasAttribute("playing")) return null;
    return video.closest("#inline-preview-player.html5-video-player") ? preview : null;
  }

  function mediaIdentityForVideo(video) {
    if (!video) return "";
    const preview = youtubePreviewContainer(video);
    const previewHref = preview?.querySelector("#media-container-link[href], .ytp-title-link[href]")
      ?.getAttribute("href");
    const videoId = youtubeVideoId(previewHref || location.href);
    if (videoId) return `youtube:${videoId}`;
    const source = video.currentSrc || video.getAttribute("src") || "";
    return source ? `media:${source}` : `page:${location.origin}${location.pathname}`;
  }

  function youtubeVideoId(value) {
    try {
      const url = new URL(value, location.href);
      if (url.searchParams.get("v")) return url.searchParams.get("v");
      const match = url.pathname.match(/^\/(?:embed|live|shorts|clip)\/([^/?#]+)/);
      return match?.[1] || "";
    } catch {
      return "";
    }
  }

  function hideSelectedTextTrack() {
    const source = sourceCueSets.get(activeSourceKey);
    if (source?.type !== "texttrack" || !source.track) return;
    const record = trackedVideos.get(source.video)?.tracks?.get(source.track);
    if (!record || source.track.mode !== "showing") return;
    if (record.restoreMode === null) record.restoreMode = source.track.mode;
    source.track.mode = "hidden";
  }

  function activateTextTrackCandidate() {
    if (!subtitleEnabled || activeCues.length) return;
    const video = chooseVideo();
    const record = trackedVideos.get(video);
    if (!record) return;
    const candidates = [...record.tracks.keys()].filter((track) => (
      ["captions", "subtitles"].includes(track.kind)
    ));
    const track = candidates.find((candidate) => candidate.mode !== "disabled") || candidates[0];
    const trackRecord = record.tracks.get(track);
    if (!track || !trackRecord) return;
    if (track.mode === "disabled") {
      trackRecord.restoreMode = track.mode;
      track.mode = core.sameLanguage(track.language, targetLanguage) ? "showing" : "hidden";
    }
    ingestTextTrack(video, track);
  }

  function restoreTextTracks() {
    for (const record of trackedVideos.values()) {
      for (const [track, trackRecord] of record.tracks) {
        if (trackRecord.restoreMode !== null) track.mode = trackRecord.restoreMode;
        trackRecord.restoreMode = null;
      }
    }
  }

  function triggerSiteCaptions() {
    setTimeout(() => {
      if (!subtitleEnabled || activeCues.length) return;
      const video = chooseVideo();
      const preview = youtubePreviewForVideo(video);
      const button = preview
        ? preview.querySelector("yt-closed-captions-toggle-button button, button.ytmClosedCaptioningButtonButton")
        : video?.closest("#movie_player.html5-video-player")?.querySelector(".ytp-subtitles-button");
      if (!button) return;
      const enabled = button.getAttribute("aria-pressed") === "true";
      if (!enabled) button.click();
    }, 250);
  }

  function armNoCaptionsTimeout() {
    clearTimeout(noCaptionsTimer);
    noCaptionsTimer = setTimeout(() => {
      if (subtitleEnabled && !activeCues.length) setSubtitleStatus("no-captions");
    }, NO_CAPTIONS_TIMEOUT_MS);
  }

  function setSubtitleStatus(status, error = "") {
    subtitleStatus = status;
    subtitleError = error ? String(error?.message || error) : "";
    if (subtitleError) rememberSubtitleError(subtitleError);
    document.documentElement.dataset.translySubtitlesEnabled = String(subtitleEnabled);
    document.documentElement.dataset.translySubtitleStatus = status;
    document.documentElement.dataset.translySubtitleCueCount = String(activeCues.length);
    document.documentElement.dataset.translySubtitleSourceLanguage = subtitleSourceLanguage;
    document.documentElement.dataset.translySubtitleTargetLanguage = targetLanguage;
    document.documentElement.dataset.translySubtitleSourceType = subtitleSourceType;
    document.documentElement.dataset.translySubtitleSkipReason = subtitleSkipReason;
    if (subtitleError) document.documentElement.dataset.translySubtitleError = subtitleError;
    else delete document.documentElement.dataset.translySubtitleError;
    updatePlayerControls();
    recordSubtitleDiagnostic();
  }

  function subtitleState() {
    return {
      subtitleEnabled,
      subtitleStatus,
      subtitleError,
      subtitleLastError,
      subtitleLastErrorAt: subtitleLastErrorAt || null,
      subtitleCueCount: activeCues.length,
      subtitleTranslatedCueCount: activeCues.filter((cue) => (
        translatedById.has(cueStateKey(cue.id))
      )).length,
      subtitleSourceLanguage,
      subtitleTargetLanguage: targetLanguage,
      subtitleSourceType,
      subtitleSourceKey: activeSourceKey || targetLanguageMediaKey,
      subtitleSkipReason,
      subtitleCurrentCueState: document.documentElement.dataset.translySubtitleCurrentCueState || "none",
      pageUrl: location.href,
      pageTitle: document.title
    };
  }

  function subtitleStatusLabel() {
    if (subtitleStatus === "error") return subtitleError || playerText("failed");
    return subtitleStatusMessage();
  }

  function subtitleStatusMessage() {
    const key = {
      native: "statusNative",
      error: "failed",
      "no-captions": "statusNoCaptions",
      detecting: "statusDetecting",
      translating: "statusTranslating",
      ready: "statusReady"
    }[subtitleStatus];
    return key ? playerText(key) : "";
  }

  function playerText(key) {
    const language = uiLanguage === "en" || uiLanguage === "zh-CN"
      ? uiLanguage
      : (navigator.language || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
    return (language === "zh-CN" ? PLAYER_TEXT_ZH : PLAYER_TEXT_EN)[key] || PLAYER_TEXT_EN[key] || "";
  }

  function recordSubtitleDiagnostic() {
    const state = subtitleState();
    const signature = JSON.stringify({
      status: state.subtitleStatus,
      error: state.subtitleError,
      lastError: state.subtitleLastError,
      sourceLanguage: state.subtitleSourceLanguage,
      targetLanguage: state.subtitleTargetLanguage,
      sourceKey: state.subtitleSourceKey,
      skipReason: state.subtitleSkipReason,
      cueCount: state.subtitleCueCount,
      translatedCueCount: state.subtitleTranslatedCueCount
    });
    if (signature === lastDiagnosticSignature) return;
    lastDiagnosticSignature = signature;
    chrome.runtime.sendMessage({
      type: "TRANSLY_RECORD_DIAGNOSTIC",
      payload: state
    }, () => void chrome.runtime.lastError);
  }

  function hasAnyTranslation() {
    return activeCues.some((cue) => translatedById.has(cueStateKey(cue.id)));
  }

  function activeMediaIdentity() {
    return mediaIdentityForVideo(chooseVideo()) || activeSourceKey || "page";
  }

  function cueStateKey(cueId, mediaKey = activeMediaIdentity()) {
    return `${mediaKey || "page"}::${cueId}`;
  }

  function rememberSubtitleError(error) {
    const message = String(error?.message || error || "");
    if (!message) return;
    subtitleLastError = message;
    subtitleLastErrorAt = Date.now();
  }

  function buildSubtitleContext(cues, batch = [], videoMetadata = {}) {
    const requestedIds = new Set(batch.map((cue) => cue.id));
    const requestedIndexes = cues
      .map((cue, index) => requestedIds.has(cue.id) ? index : -1)
      .filter((index) => index >= 0);
    const first = requestedIndexes.length ? Math.max(0, Math.min(...requestedIndexes) - 6) : 0;
    const last = requestedIndexes.length ? Math.min(cues.length, Math.max(...requestedIndexes) + 7) : cues.length;
    const metadata = [
      videoMetadata.title ? `Title: ${videoMetadata.title}` : "",
      videoMetadata.channel ? `Channel: ${videoMetadata.channel}` : "",
      videoMetadata.description ? `Description: ${videoMetadata.description}` : ""
    ].filter(Boolean).join("\n");
    const transcript = cues.slice(first, last).map((cue) => cue.text).join("\n").slice(0, 12000);
    return [
      metadata ? `VIDEO CONTEXT (reference only)\n${metadata}` : "",
      transcript ? `TRANSCRIPT CONTEXT (reference only)\n${transcript}` : ""
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  function subtitleVideoMetadata(video) {
    const isYouTubeSurface = /(^|\.)youtube\.com$/i.test(location.hostname)
      || Boolean(video?.closest?.("ytd-video-preview, #movie_player.html5-video-player"));
    if (!video || !isYouTubeSurface) {
      return { title: cleanYouTubeTitle(document.title), channel: "", description: "" };
    }

    const card = video.closest(
      "ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer"
    );
    const preview = youtubePreviewContainer(video);
    const localRoot = card || preview;
    const title = firstContextText(localRoot, [
      "#video-title",
      "a#video-title",
      "[data-title]"
    ]) || firstContextText(document, [
      "ytd-watch-metadata h1 yt-formatted-string",
      "h1.ytd-watch-metadata",
      "h1"
    ]) || metaContext("meta[property='og:title'], meta[name='title']") || cleanYouTubeTitle(document.title);
    const channel = firstContextText(localRoot, [
      "ytd-channel-name a",
      "#channel-name a",
      "#channel-name"
    ]) || firstContextText(document, [
      "ytd-watch-metadata ytd-channel-name a",
      "#owner #channel-name a"
    ]) || metaContext("meta[itemprop='author']");
    const description = firstContextText(document, [
      "ytd-watch-metadata #description-inline-expander",
      "ytd-watch-metadata #description",
      "#description-inline-expander"
    ]) || metaContext("meta[property='og:description'], meta[name='description']");

    return {
      title: compactContextText(title, 300),
      channel: compactContextText(channel, 160),
      description: compactContextText(description, 1600)
    };
  }

  function firstContextText(root, selectors) {
    if (!root?.querySelector) return "";
    for (const selector of selectors) {
      const element = root.querySelector(selector);
      const value = element?.getAttribute?.("title")
        || element?.getAttribute?.("data-title")
        || element?.textContent;
      if (String(value || "").trim()) return value;
    }
    return "";
  }

  function metaContext(selector) {
    return document.querySelector(selector)?.getAttribute("content") || "";
  }

  function cleanYouTubeTitle(value) {
    return String(value || "").replace(/\s+-\s+YouTube\s*$/i, "").trim();
  }

  function compactContextText(value, maxLength) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
  }

  function requestTranslation(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "TRANSLY_TRANSLATE", payload }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.ok) {
          resolve(response.data);
        } else {
          reject(new Error(response?.error || "Subtitle translation failed"));
        }
      });
    });
  }

  function getSettings() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "TRANSLY_GET_SETTINGS" }, (response) => {
        resolve(response?.data || {});
      });
    });
  }

  function saveSettings(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "TRANSLY_SAVE_SETTINGS", payload }, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response || { ok: true });
      });
    });
  }

  async function sha256(input) {
    const bytes = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
})(globalThis);
