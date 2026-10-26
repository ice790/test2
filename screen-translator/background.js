const DEFAULTS = {
  enabled: false,
  interval: 2500,
  sourceLang: "en"
};

const SOURCE_LANGUAGES = {
  en: { ocr: "eng", bing: "en", google: "en", mymemory: "en" },
  ja: { ocr: "jpn", bing: "ja", google: "ja", mymemory: "ja" },
  ko: { ocr: "kor", bing: "ko", google: "ko", mymemory: "ko" },
  ru: { ocr: "rus", bing: "ru", google: "ru", mymemory: "ru" },
  "zh-Hant": { ocr: "chi_tra", bing: "zh-Hant", google: "zh-TW", mymemory: "zh-TW" }
};

const OFFSCREEN_PATH = "offscreen.html";
const BING_SESSION_KEY = "bingSession";
const CACHE_LIMIT = 1500;
const translationCache = new Map();
const providerCooldowns = {
  bing: 0,
  google: 0,
  mymemory: 0
};

let processing = false;
let creatingOffscreen = null;
let bingSession = null;
let bingSessionPromise = null;
let lastCaptureHash = "";
let lastMeta = null;
let lastSourceLang = "";
let lastStatus = {
  at: 0,
  error: "",
  count: 0,
  ocrMs: 0,
  trMs: 0,
  provider: ""
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeout, message) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeout);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}


async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return {
    enabled: stored.enabled === true,
    interval: Number(stored.interval) || DEFAULTS.interval,
    sourceLang: SOURCE_LANGUAGES[stored.sourceLang] ? stored.sourceLang : DEFAULTS.sourceLang
  };
}

function getLanguage(sourceLang) {
  return SOURCE_LANGUAGES[sourceLang] || SOURCE_LANGUAGES.en;
}

async function syncBadge(enabled) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#0ea5e9" });
    await chrome.action.setBadgeText({ text: enabled ? "译" : "" });
    await chrome.action.setTitle({
      title: enabled ? "即译 · 实时翻译已开启" : "即译 · 屏幕实时翻译"
    });
  } catch {}
}

function cacheGet(key) {
  if (!translationCache.has(key)) {
    return undefined;
  }
  const value = translationCache.get(key);
  translationCache.delete(key);
  translationCache.set(key, value);
  return value;
}

function cacheSet(key, value) {
  if (translationCache.size >= CACHE_LIMIT) {
    const oldest = translationCache.keys().next().value;
    if (oldest !== undefined) {
      translationCache.delete(oldest);
    }
  }
  translationCache.set(key, value);
}

function resetProviderHealth() {
  providerCooldowns.bing = 0;
  providerCooldowns.google = 0;
  providerCooldowns.mymemory = 0;
}

function hashString(value) {
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }
  first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
  return `${first >>> 0}-${second >>> 0}-${value.length}`;
}

function sameMeta(captured, current) {
  return (
    captured &&
    current &&
    captured.token === current.token &&
    captured.viewportWidth === current.viewportWidth &&
    captured.viewportHeight === current.viewportHeight &&
    Math.abs(captured.scrollX - current.scrollX) < 2 &&
    Math.abs(captured.scrollY - current.scrollY) < 2
  );
}

function isTabActive(tabId) {
  return chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => {
    return tabs.some((tab) => tab.id === tabId);
  });
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0] || null;
}

async function captureVisibleTab(windowId) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, {
        format: "jpeg",
        quality: 82
      });
    } catch (error) {
      lastError = error;
      await delay(180);
    }
  }
  throw lastError || new Error("无法截取页面");
}

async function ensureOffscreen() {
  if (creatingOffscreen) {
    return creatingOffscreen;
  }

  const documentUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime
    .getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [documentUrl] })
    .catch(() => []);

  if (contexts.length > 0) {
    return;
  }

  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["WORKERS"],
      justification: "Run a local OCR model to recognize text from captured screen images"
    })
    .finally(() => {
      creatingOffscreen = null;
    });

  await creatingOffscreen;
}

async function closeOffscreen() {
  try {
    const documentUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [documentUrl]
    });
    if (contexts.length > 0) {
      await chrome.offscreen.closeDocument();
    }
  } catch {}
}

async function ocrImage(image, lang) {
  await ensureOffscreen();
  let lastError = null;
  let timeoutRetried = false;
  let timeout = 3500;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await withTimeout(
        chrome.runtime.sendMessage({
          target: "offscreen",
          type: "ocr",
          image,
          lang
        }),
        timeout,
        "文字识别超时"
      );
      if (!response) {
        throw new Error("识别进程未响应");
      }
      if (!response.ok) {
        throw new Error(response.error || "文字识别失败");
      }
      return response;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || "");
      if (/Receiving end does not exist|message port closed|Could not establish/i.test(message)) {
        await closeOffscreen();
        await ensureOffscreen();
        await delay(200);
        continue;
      }
      if (!timeoutRetried && /超时/.test(message)) {
        timeoutRetried = true;
        timeout = 8000;
        await delay(150);
        continue;
      }
      await closeOffscreen();
      break;
    }
  }

  throw lastError || new Error("文字识别失败");
}

async function fetchText(url, timeout, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      ...options,
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function buildTextChunks(texts, maxCharacters) {
  const chunks = [];
  let current = [];
  let length = 0;

  for (const text of texts) {
    const extra = text.length + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && length + extra > maxCharacters) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(text);
    length += text.length + (current.length > 1 ? 1 : 0);
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

async function getBingSession(force) {
  if (!force && bingSession && bingSession.expiresAt > Date.now() + 120000) {
    return bingSession;
  }

  if (!force && !bingSession) {
    const stored = await chrome.storage.local.get(BING_SESSION_KEY).catch(() => null);
    const cached = stored?.[BING_SESSION_KEY];
    if (
      cached &&
      cached.expiresAt > Date.now() + 120000 &&
      cached.ig &&
      cached.key &&
      cached.token
    ) {
      bingSession = cached;
      return bingSession;
    }
  }

  if (bingSessionPromise) {
    return bingSessionPromise;
  }

  bingSessionPromise = (async () => {
    const raw = await fetchText(
      "https://www.bing.com/translator?from=en&to=zh-Hans",
      35000,
      {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
        }
      }
    );
    const igMatch = raw.match(/\bIG:"([A-Fa-f0-9]{32})"/);
    const helperMatch = raw.match(
      /params_AbusePreventionHelper\s*=\s*\[(\d+)\s*,\s*"([^"]+)"\s*,\s*(\d+)\s*\]/
    );

    if (!igMatch || !helperMatch) {
      throw new Error("Bing 会话初始化失败");
    }

    const ttl = Number(helperMatch[3]) || 3600000;
    bingSession = {
      ig: igMatch[1],
      key: helperMatch[1],
      token: helperMatch[2],
      expiresAt: Date.now() + Math.min(ttl, 3600000) - 120000
    };
    providerCooldowns.bing = 0;
    await chrome.storage.local.set({ [BING_SESSION_KEY]: bingSession }).catch(() => {});
    return bingSession;
  })().finally(() => {
    bingSessionPromise = null;
  });

  return bingSessionPromise;
}

function warmBingSession() {
  getBingSession(false).catch(() => {});
}

async function postBing(text, lang, session) {
  const body = new URLSearchParams();
  body.set("fromLang", lang.bing);
  body.set("to", "zh-Hans");
  body.set("tone", "Casual");
  body.set("text", text);
  body.set("token", session.token);
  body.set("key", session.key);

  const raw = await fetchText(
    `https://www.bing.com/ttranslatev3?isVertical=1&&IG=${encodeURIComponent(session.ig)}&IID=translator.5025&SFX=2`,
    8000,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    }
  );

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Bing 返回数据异常");
  }

  if (data?.statusCode) {
    const error = new Error(`Bing 会话失效 (${data.statusCode})`);
    error.sessionExpired = true;
    throw error;
  }

  const translated = data?.[0]?.translations?.[0]?.text;
  if (typeof translated !== "string" || !translated.trim()) {
    throw new Error("Bing 未返回译文");
  }
  return translated;
}

function splitBingLines(text, count) {
  const parts = String(text)
    .split("\n")
    .map((part) => part.trim());

  while (parts.length > count && parts[parts.length - 1] === "") {
    parts.pop();
  }

  if (parts.length !== count) {
    return null;
  }
  return parts;
}

async function translateChunkWithBing(lines, lang) {
  let session = await getBingSession(false);

  const run = async () => {
    const translated = await postBing(lines.join("\n"), lang, session);
    const aligned = splitBingLines(translated, lines.length);
    if (aligned) {
      return aligned;
    }

    const results = [];
    for (const line of lines) {
      const single = await postBing(line, lang, session);
      results.push(single.replace(/\s+/g, " ").trim());
    }
    return results;
  };

  try {
    return await run();
  } catch (error) {
    if (!error?.sessionExpired) {
      throw error;
    }
    bingSession = null;
    await chrome.storage.local.remove(BING_SESSION_KEY).catch(() => {});
    session = await getBingSession(true);
    return run();
  }
}

async function translateWithBing(texts, lang) {
  const chunks = buildTextChunks(texts, 900);
  const results = [];

  for (const chunk of chunks) {
    const translated = await translateChunkWithBing(chunk, lang);
    results.push(...translated);
  }

  if (results.filter(Boolean).length === 0) {
    throw new Error("Bing 未返回译文");
  }
  return results;
}

function buildChunks(texts, maxLength, maxItems) {
  const chunks = [];
  let current = [];
  let length = 0;

  for (const text of texts) {
    const size = encodeURIComponent(text).length + 2;
    if (current.length > 0 && (length + size > maxLength || current.length >= maxItems)) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(text);
    length += size;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

function extractGoogleTranslation(payload) {
  if (Array.isArray(payload)) {
    const value = payload[0];
    return typeof value === "string" ? value : "";
  }
  if (payload && Array.isArray(payload.value)) {
    return typeof payload.value[0] === "string" ? payload.value[0] : "";
  }
  if (payload && typeof payload.value === "string") {
    return payload.value;
  }
  return "";
}

async function translateChunkWithGoogle(texts, lang) {
  const params = new URLSearchParams();
  params.set("client", "gtx");
  params.set("sl", lang.google);
  params.set("tl", "zh-CN");
  for (const text of texts) {
    params.append("q", text);
  }

  const raw = await fetchText(
    `https://translate.googleapis.com/translate_a/t?${params.toString()}`,
    8000
  );
  const payload = JSON.parse(raw);
  const items = Array.isArray(payload) ? payload : [payload];

  if (items.length !== texts.length) {
    throw new Error("Google 批量结果数量不匹配");
  }

  return items.map((item) => {
    if (typeof item === "string") {
      return item;
    }
    if (Array.isArray(item?.value)) {
      return typeof item.value[0] === "string" ? item.value[0] : "";
    }
    if (typeof item?.value === "string") {
      return item.value;
    }
    return extractGoogleTranslation(item);
  });
}

async function translateWithGoogle(texts, lang) {
  const chunks = buildChunks(texts, 2200, 24);
  const results = new Array(chunks.length);
  let cursor = 0;

  async function run() {
    while (cursor < chunks.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await translateChunkWithGoogle(chunks[index], lang);
    }
  }

  await Promise.all([run(), run(), run()]);
  const flattened = results.flat();
  if (flattened.filter(Boolean).length === 0) {
    throw new Error("Google 未返回译文");
  }
  return flattened;
}

async function translateWithMyMemory(texts, lang) {
  const results = new Array(texts.length).fill("");
  const limit = Math.min(texts.length, 40);
  let cursor = 0;

  async function run() {
    while (cursor < limit) {
      const index = cursor;
      cursor += 1;
      const text = texts[index];
      if (!text || text.length > 480) {
        continue;
      }
      try {
        const params = new URLSearchParams();
        params.set("q", text);
        params.set("langpair", `${lang.mymemory}|zh-CN`);
        const raw = await fetchText(
          `https://api.mymemory.translated.net/get?${params.toString()}`,
          6000
        );
        const data = JSON.parse(raw);
        const translated = data?.responseData?.translatedText;
        if (
          typeof translated === "string" &&
          translated &&
          translated.trim().toLowerCase() !== text.trim().toLowerCase() &&
          !/MYMEMORY WARNING|SELECT TWO DISTINCT|QUERY LENGTH LIMIT/i.test(translated)
        ) {
          results[index] = translated;
        }
      } catch {}
    }
  }

  await Promise.all(Array.from({ length: 6 }, () => run()));

  if (results.filter(Boolean).length === 0) {
    throw new Error("MyMemory 未返回译文");
  }
  return results;
}

async function translateBatch(texts, lang) {
  const now = Date.now();
  const deadline = now + 12000;

  if (!bingSession) {
    const stored = await chrome.storage.local.get(BING_SESSION_KEY).catch(() => null);
    const cached = stored?.[BING_SESSION_KEY];
    if (
      cached &&
      cached.expiresAt > now + 120000 &&
      cached.ig &&
      cached.key &&
      cached.token
    ) {
      bingSession = cached;
    }
  }

  const bingReady = Boolean(
    bingSession && bingSession.expiresAt > now + 120000
  );
  if (!bingReady) {
    warmBingSession();
  }

  const order = bingReady
    ? ["bing", "google", "mymemory"]
    : ["mymemory", "google"];
  const providers = order.filter((name) => providerCooldowns[name] <= now);

  const errors = [];

  for (const provider of providers) {
    const remaining = deadline - Date.now();
    if (remaining < 500) {
      break;
    }
    try {
      let work;
      if (provider === "bing") {
        work = translateWithBing(texts, lang);
      } else if (provider === "google") {
        work = translateWithGoogle(texts, lang);
      } else {
        work = translateWithMyMemory(texts, lang);
      }

      const translated = await withTimeout(
        work,
        Math.min(remaining, 8000),
        `${provider} 翻译超时`
      );

      const filled = translated.filter(Boolean).length;
      if (
        translated.length === texts.length &&
        filled > 0 &&
        (texts.length <= 3 || filled / texts.length >= 0.5)
      ) {
        return { translated, provider };
      }
      errors.push(`${provider} 返回数据不完整`);
    } catch (error) {
      const cooldown = provider === "google" ? 90000 : provider === "bing" ? 60000 : 180000;
      providerCooldowns[provider] = Date.now() + cooldown;
      errors.push(error?.message || String(error));
    }
  }

  throw new Error(errors[0] || "翻译服务暂时不可用");
}

function shouldTranslate(text) {
  if (!text || text.length < 2 || text.length > 400) {
    return false;
  }
  return /\p{L}/u.test(text);
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

async function translateTexts(lines, sourceLang) {
  const lang = getLanguage(sourceLang);
  const translationMap = new Map();
  const missing = [];

  for (const line of lines) {
    const text = line.text.trim();
    if (!shouldTranslate(text)) {
      continue;
    }
    const key = `${sourceLang}\u0000${text}`;
    const cached = cacheGet(key);
    if (cached !== undefined) {
      translationMap.set(text, cached);
    } else {
      missing.push(text);
    }
  }

  const uniqueMissing = [...new Set(missing)];
  if (uniqueMissing.length === 0) {
    return { map: translationMap, provider: "cache" };
  }

  const { translated, provider } = await translateBatch(uniqueMissing, lang);

  uniqueMissing.forEach((text, index) => {
    const value = String(translated[index] || "").trim();
    if (value) {
      const key = `${sourceLang}\u0000${text}`;
      cacheSet(key, value);
      translationMap.set(text, value);
    }
  });

  return { map: translationMap, provider };
}

function describeError(error) {
  const message = String(error?.message || error || "");
  if (/识别|OCR|Tesseract|模型|UTF|语言数据/i.test(message)) {
    return "文字识别失败，请稍后重试";
  }
  if (/截取|截图/.test(message)) {
    return "无法截取当前页面，请刷新后重试";
  }
  if (/abort|timeout|超时|timed out/i.test(message)) {
    return "翻译服务响应超时，请稍后重试";
  }
  if (/翻译|HTTP|fetch|network|Google|MyMemory|Bing|结果/i.test(message)) {
    return "翻译服务暂时不可用，请检查网络";
  }
  return "处理失败，请稍后重试";
}

async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {}
}

async function runJob(job) {
  const startedAt = performance.now();

  try {
    const ocr = await ocrImage(job.image, getLanguage(job.sourceLang).ocr);
    const ocrMs = Math.round(performance.now() - startedAt);
    const candidates = (ocr.lines || [])
      .filter((line) => line.text && shouldTranslate(line.text))
      .slice(0, 120);

    const translationStartedAt = performance.now();
    const { map: translations, provider } = await translateTexts(candidates, job.sourceLang);
    const trMs = Math.round(performance.now() - translationStartedAt);

    const rendered = [];
    for (const line of candidates) {
      const translated = translations.get(line.text.trim());
      if (!translated || normalizeText(translated) === normalizeText(line.text)) {
        continue;
      }
      rendered.push({
        text: translated,
        left: line.left,
        top: line.top,
        width: line.width,
        height: line.height
      });
    }

    await sendToTab(job.tabId, {
      type: "render",
      token: job.token,
      lines: rendered,
      imageWidth: ocr.imageWidth,
      imageHeight: ocr.imageHeight,
      meta: job.meta,
      stats: { count: rendered.length, ocrMs, trMs }
    });

    lastStatus = {
      at: Date.now(),
      error: "",
      count: rendered.length,
      ocrMs,
      trMs,
      provider
    };
  } catch (error) {
    console.error("即译处理失败", error);
    const message = describeError(error);
    lastStatus = {
      at: Date.now(),
      error: message,
      count: 0,
      ocrMs: 0,
      trMs: 0,
      provider: ""
    };
    await sendToTab(job.tabId, {
      type: "error",
      token: job.token,
      meta: job.meta,
      message
    });
  } finally {
    processing = false;
  }
}

function normalizeMeta(meta) {
  if (!meta || typeof meta !== "object") {
    return null;
  }
  const values = ["viewportWidth", "viewportHeight", "scrollX", "scrollY"];
  const valid = values.every((key) => Number.isFinite(Number(meta[key])));
  if (!valid || typeof meta.token !== "string" || meta.token.length < 6) {
    return null;
  }
  return {
    token: meta.token,
    viewportWidth: Number(meta.viewportWidth),
    viewportHeight: Number(meta.viewportHeight),
    scrollX: Number(meta.scrollX),
    scrollY: Number(meta.scrollY),
    force: meta.force === true
  };
}

async function beginCapture(message, sender) {
  if (processing) {
    return { ok: false, reason: "busy" };
  }

  const settings = await getSettings();
  if (!settings.enabled) {
    return { ok: false, reason: "disabled" };
  }

  const tab = sender.tab;
  if (!tab || tab.id === undefined || tab.windowId === undefined) {
    return { ok: false, reason: "no-tab" };
  }

  const meta = normalizeMeta(message.meta);
  if (!meta) {
    return { ok: false, reason: "bad-meta" };
  }

  if (!(await isTabActive(tab.id))) {
    return { ok: false, reason: "inactive" };
  }

  const window = await chrome.windows.get(tab.windowId).catch(() => null);
  if (!window || window.focused === false) {
    return { ok: false, reason: "unfocused" };
  }

  if (tab.status === "loading") {
    return { ok: false, reason: "loading" };
  }

  processing = true;

  let image;
  try {
    image = await captureVisibleTab(tab.windowId);
  } catch (error) {
    processing = false;
    console.error("即译截图失败", error);
    return { ok: false, reason: "capture-failed" };
  }

  const sourceLang = settings.sourceLang;
  const hash = hashString(image);
  const unchanged =
    !meta.force &&
    hash === lastCaptureHash &&
    sameMeta(lastMeta, meta) &&
    lastSourceLang === sourceLang &&
    !lastStatus.error;
  lastCaptureHash = hash;
  lastMeta = meta;
  lastSourceLang = sourceLang;

  if (unchanged) {
    processing = false;
    lastStatus = { ...lastStatus, at: Date.now() };
    return { ok: true, skipped: true };
  }

  runJob({
    image,
    meta,
    token: meta.token,
    tabId: tab.id,
    sourceLang
  });

  return { ok: true, queued: true };
}

async function pingContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "ping" });
    return response?.ok === true;
  } catch {
    return false;
  }
}

async function ensureContentScript(tabId) {
  if (await pingContentScript(tabId)) {
    return true;
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
  return true;
}

async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs
    .query({ url: ["http://*/*", "https://*/*", "file:///*"] })
    .catch(() => []);

  await Promise.allSettled(
    tabs
      .filter((tab) => tab.id !== undefined && !tab.discarded)
      .map((tab) => ensureContentScript(tab.id))
  );
}

async function ensureActiveContentScript() {
  const tab = await getActiveTab();
  if (!tab || tab.id === undefined) {
    return false;
  }
  try {
    await ensureContentScript(tab.id);
    return true;
  } catch {
    lastStatus = {
      at: Date.now(),
      error: "当前页面不支持翻译，请切换到普通网页",
      count: 0,
      ocrMs: 0,
      trMs: 0,
      provider: ""
    };
    return false;
  }
}

async function refreshActiveTab() {
  const settings = await getSettings();
  if (!settings.enabled) {
    return { ok: false, error: "请先开启实时翻译" };
  }

  const tab = await getActiveTab();
  if (!tab || tab.id === undefined) {
    return { ok: false, error: "没有可用的标签页" };
  }

  try {
    await ensureContentScript(tab.id);
  } catch {
    return { ok: false, error: "当前页面不支持翻译" };
  }

  resetProviderHealth();
  warmBingSession();
  lastCaptureHash = "";
  lastMeta = null;
  lastStatus = { ...lastStatus, error: "" };

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "force-refresh" });
    return { ok: true };
  } catch {
    return { ok: false, error: "当前页面不支持翻译" };
  }
}

async function getStatus() {
  const settings = await getSettings();
  return {
    ...settings,
    busy: processing,
    last: lastStatus,
    providers: {
      bing: providerCooldowns.bing > Date.now(),
      google: providerCooldowns.google > Date.now(),
      mymemory: providerCooldowns.mymemory > Date.now()
    }
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === "offscreen") {
    return false;
  }

  if (message.type === "capture") {
    beginCapture(message, sender)
      .then((result) => sendResponse(result))
      .catch((error) => {
        processing = false;
        console.error("即译截图请求失败", error);
        sendResponse({ ok: false, reason: "error" });
      });
    return true;
  }

  if (message.type === "get-status") {
    getStatus()
      .then((status) => sendResponse(status))
      .catch(() => sendResponse(null));
    return true;
  }

  if (message.type === "refresh-active-tab") {
    refreshActiveTab()
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ ok: false, error: "刷新失败，请稍后重试" }));
    return true;
  }

  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }

  if (changes.enabled) {
    const enabled = changes.enabled.newValue === true;
    syncBadge(enabled);
    if (enabled) {
      resetProviderHealth();
      lastCaptureHash = "";
      lastMeta = null;
      lastStatus = { ...lastStatus, error: "" };
      ensureActiveContentScript();
      injectIntoOpenTabs();
      warmBingSession();
    } else {
      closeOffscreen();
      lastCaptureHash = "";
      lastMeta = null;
    }
  }

  if (changes.sourceLang) {
    lastCaptureHash = "";
    lastMeta = null;
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-translation") {
    return;
  }
  const settings = await getSettings();
  await chrome.storage.local.set({ enabled: !settings.enabled });
});

chrome.runtime.onInstalled.addListener(() => {
  (async () => {
    const settings = await getSettings();
    await syncBadge(settings.enabled);
    if (settings.enabled) {
      await injectIntoOpenTabs();
    }
    warmBingSession();
  })().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  getSettings()
    .then((settings) => {
      syncBadge(settings.enabled);
      if (settings.enabled) {
        warmBingSession();
      }
    })
    .catch(() => {});
});

getSettings()
  .then((settings) => {
    syncBadge(settings.enabled);
    if (settings.enabled) {
      warmBingSession();
    }
  })
  .catch(() => {});

