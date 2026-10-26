(() => {
  if (window.__jiscreenTranslatorLoaded) {
    return;
  }
  window.__jiscreenTranslatorLoaded = true;

  const DEFAULTS = {
    enabled: false,
    interval: 2500,
    sourceLang: "en"
  };

  const SHADOW_STYLE = `
    :host {
      all: initial;
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: block;
      pointer-events: none;
      contain: layout style;
    }
    .layer {
      position: absolute;
      inset: 0;
      overflow: hidden;
      pointer-events: none;
      font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif;
    }
    .box {
      position: fixed;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      padding: 1px 6px;
      border: 1px solid rgba(14, 165, 233, 0.5);
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.96);
      color: #0b2540;
      box-shadow: 0 4px 14px rgba(3, 36, 64, 0.16);
      font-weight: 500;
      line-height: 1.25;
      letter-spacing: 0.01em;
      text-align: left;
      white-space: normal;
      overflow-wrap: anywhere;
      pointer-events: none;
    }
    .busy,
    .toast {
      position: fixed;
      right: 16px;
      z-index: 1;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.02em;
      pointer-events: none;
    }
    .busy {
      bottom: 16px;
      padding: 7px 14px;
      border: 1px solid rgba(186, 230, 253, 0.36);
      background: rgba(8, 47, 73, 0.9);
      color: #e0f2fe;
      box-shadow: 0 8px 24px rgba(3, 36, 64, 0.24);
    }
    .busy::before {
      content: "";
      display: inline-block;
      width: 8px;
      height: 8px;
      margin-right: 7px;
      border-radius: 50%;
      background: #38bdf8;
      box-shadow: 0 0 0 0 rgba(56, 189, 248, 0.55);
      animation: pulse 1.4s ease-out infinite;
    }
    .toast {
      bottom: 16px;
      max-width: min(340px, calc(100vw - 32px));
      padding: 10px 15px;
      border-radius: 12px;
      background: rgba(8, 47, 73, 0.95);
      color: #f0f9ff;
      line-height: 1.5;
      white-space: normal;
      box-shadow: 0 12px 32px rgba(3, 36, 64, 0.3);
    }
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(56, 189, 248, 0.55); }
      70% { box-shadow: 0 0 0 8px rgba(56, 189, 248, 0); }
      100% { box-shadow: 0 0 0 0 rgba(56, 189, 248, 0); }
    }
    @media (prefers-reduced-motion: reduce) {
      .busy::before { animation: none; }
    }
  `;

  const state = {
    enabled: false,
    interval: DEFAULTS.interval,
    sourceLang: DEFAULTS.sourceLang,
    token: createToken(),
    host: null,
    layer: null,
    boxes: [],
    busy: false,
    timer: null,
    safetyTimer: null,
    scrollTimer: null,
    scrollHold: false,
    toast: null,
    toastTimer: null,
    lastToastAt: 0,
    fullscreenBound: false,
    forcePending: false
  };

  function createToken() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function ensureHost() {
    const parent = document.fullscreenElement || document.documentElement;
    if (!parent) {
      return;
    }

    if (state.host && state.host.isConnected && state.host.parentNode === parent) {
      return;
    }

    if (!state.host) {
      const host = document.createElement("div");
      host.id = "jiscreen-translator-host";
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = SHADOW_STYLE;
      const layer = document.createElement("div");
      layer.className = "layer";
      layer.setAttribute("aria-hidden", "true");
      shadow.append(style, layer);
      state.host = host;
      state.layer = layer;
    }

    parent.appendChild(state.host);
  }

  function setHostVisible(visible) {
    if (state.host) {
      state.host.style.display = visible ? "block" : "none";
    }
  }

  function removeHost() {
    if (state.host) {
      state.host.remove();
    }
    state.host = null;
    state.layer = null;
    state.boxes = [];
    state.toast = null;
  }

  function clearBoxes() {
    if (state.layer) {
      state.layer.querySelectorAll(".box").forEach((box) => box.remove());
    }
    state.boxes = [];
    removeToast();
  }

  function clearBusy() {
    if (state.layer) {
      state.layer.querySelectorAll(".busy").forEach((element) => element.remove());
    }
  }

  function showBusy() {
    ensureHost();
    if (!state.layer) {
      return;
    }
    clearBusy();
    const element = document.createElement("div");
    element.className = "busy";
    element.textContent = state.boxes.length > 0 ? "即译 · 正在更新" : "即译 · 正在识别";
    state.layer.appendChild(element);
  }

  function removeToast() {
    if (state.toast) {
      state.toast.remove();
      state.toast = null;
    }
    if (state.toastTimer) {
      clearTimeout(state.toastTimer);
      state.toastTimer = null;
    }
  }

  function showToast(message) {
    const now = Date.now();
    if (now - state.lastToastAt < 6000) {
      return;
    }
    state.lastToastAt = now;
    ensureHost();
    if (!state.layer) {
      return;
    }
    removeToast();
    const element = document.createElement("div");
    element.className = "toast";
    element.textContent = message;
    state.layer.appendChild(element);
    state.toast = element;
    state.toastTimer = setTimeout(() => {
      if (state.toast === element) {
        removeToast();
      }
    }, 4200);
  }

  function buildMeta(force) {
    return {
      token: state.token,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      force: force === true
    };
  }

  function clearTimer() {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  function clearSafety() {
    if (state.safetyTimer) {
      clearTimeout(state.safetyTimer);
      state.safetyTimer = null;
    }
  }

  function isAvailable() {
    return state.enabled && document.visibilityState === "visible";
  }

  function schedule(delay) {
    clearTimer();
    if (!state.enabled) {
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      runOnce();
    }, Math.max(0, delay));
  }

  function startLoop(immediate) {
    if (!isAvailable()) {
      return;
    }
    schedule(immediate ? 0 : state.interval);
  }

  function stopEverything() {
    clearTimer();
    clearSafety();
    if (state.scrollTimer) {
      clearTimeout(state.scrollTimer);
      state.scrollTimer = null;
    }
    state.scrollHold = false;
    state.busy = false;
    state.forcePending = false;
    clearBoxes();
    clearBusy();
    removeToast();
    removeHost();
  }

  async function runOnce() {
    if (!state.enabled || document.visibilityState !== "visible") {
      return;
    }
    if (state.busy || state.scrollHold) {
      schedule(350);
      return;
    }

    state.busy = true;
    clearSafety();
    state.safetyTimer = setTimeout(() => {
      state.busy = false;
      clearSafety();
      clearBusy();
      setHostVisible(true);
      schedule(state.interval);
    }, 25000);

    await hideForCapture();

    const force = state.forcePending;
    chrome.runtime.sendMessage({ type: "capture", meta: buildMeta(force) }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      setHostVisible(true);

      if (runtimeError || !response || !response.ok) {
        state.busy = false;
        clearSafety();
        clearBusy();
        if (response?.reason === "capture-failed" || response?.reason === "error") {
          showToast("无法截取当前页面，请刷新后重试");
        }
        schedule(state.interval);
        return;
      }

      if (response.skipped) {
        state.busy = false;
        clearSafety();
        clearBusy();
        schedule(state.interval);
        return;
      }

      showBusy();
    });
  }

  async function hideForCapture() {
    ensureHost();
    setHostVisible(false);
    await nextFrame();
    await nextFrame();
  }

  function handleRender(message) {
    if (message.token !== state.token) {
      return;
    }

    state.busy = false;
    clearSafety();
    clearBusy();

    if (state.scrollHold || !state.enabled || document.visibilityState !== "visible") {
      schedule(0);
      return;
    }

    const meta = message.meta || {};
    if (
      Math.abs(Number(meta.viewportWidth) - window.innerWidth) > 3 ||
      Math.abs(Number(meta.viewportHeight) - window.innerHeight) > 3
    ) {
      schedule(0);
      return;
    }

    const imageWidth = Number(message.imageWidth);
    const imageHeight = Number(message.imageHeight);
    const viewportAspect = Number(meta.viewportWidth) / Number(meta.viewportHeight);
    const imageAspect = imageWidth / imageHeight;
    if (
      Number.isFinite(imageAspect) &&
      Number.isFinite(viewportAspect) &&
      imageAspect > 0 &&
      viewportAspect > 0 &&
      Math.abs(imageAspect - viewportAspect) / viewportAspect > 0.08
    ) {
      schedule(0);
      return;
    }

    const dx = Number(meta.scrollX) - window.scrollX;
    const dy = Number(meta.scrollY) - window.scrollY;
    if (Math.abs(dx) > 120 || Math.abs(dy) > 120) {
      schedule(0);
      return;
    }

    state.forcePending = false;
    renderBoxes(message, Number.isFinite(dx) ? dx : 0, Number.isFinite(dy) ? dy : 0);
    schedule(state.interval);
  }

  function handleError(message) {
    if (message.token !== state.token) {
      return;
    }

    state.busy = false;
    clearSafety();
    clearBusy();
    if (state.enabled) {
      showToast(message.message || "翻译失败，请稍后重试");
      schedule(state.interval);
    }
  }

  function renderBoxes(message, dx, dy) {
    ensureHost();
    if (!state.layer) {
      return;
    }

    clearBoxes();

    const imageWidth = Number(message.imageWidth) || 0;
    const imageHeight = Number(message.imageHeight) || 0;
    const viewportWidth = Number(message.meta?.viewportWidth) || window.innerWidth;
    const viewportHeight = Number(message.meta?.viewportHeight) || window.innerHeight;
    const lines = Array.isArray(message.lines) ? message.lines : [];

    if (!imageWidth || !imageHeight) {
      return;
    }

    const scaleX = viewportWidth / imageWidth;
    const scaleY = viewportHeight / imageHeight;
    const fragment = document.createDocumentFragment();
    const rightMargin = 8;
    const bottomMargin = 4;

    for (const line of lines) {
      if (!line || typeof line.text !== "string" || !line.text.trim()) {
        continue;
      }

      let left = Number(line.left) * scaleX + dx;
      let top = Number(line.top) * scaleY + dy;
      const width = Math.max(8, Number(line.width) * scaleX);
      const height = Math.max(8, Number(line.height) * scaleY);

      if (!Number.isFinite(left) || !Number.isFinite(top)) {
        continue;
      }
      if (top + height < 0 || top > window.innerHeight) {
        continue;
      }

      left = clamp(left, 2, Math.max(2, window.innerWidth - 24));
      top = clamp(top, 2, Math.max(2, window.innerHeight - 12));
      if (top + height > window.innerHeight - bottomMargin) {
        top = Math.max(2, window.innerHeight - height - bottomMargin);
      }

      const maxWidth = Math.max(60, window.innerWidth - left - rightMargin);
      const minWidth = Math.min(Math.max(24, width), maxWidth);
      const fontSize = clamp(height * 0.78, 12, 24);

      const box = document.createElement("div");
      box.className = "box";
      box.textContent = line.text.trim();
      box.style.left = `${left.toFixed(1)}px`;
      box.style.top = `${top.toFixed(1)}px`;
      box.style.minWidth = `${minWidth.toFixed(1)}px`;
      box.style.maxWidth = `${maxWidth.toFixed(1)}px`;
      box.style.minHeight = `${height.toFixed(1)}px`;
      box.style.fontSize = `${fontSize.toFixed(1)}px`;
      fragment.appendChild(box);
    }

    state.layer.appendChild(fragment);
    state.boxes = Array.from(state.layer.querySelectorAll(".box"));
  }

  function handleScroll() {
    if (!state.enabled) {
      return;
    }

    state.forcePending = true;
    state.scrollHold = true;
    clearBoxes();
    clearBusy();
    setHostVisible(false);

    if (state.scrollTimer) {
      clearTimeout(state.scrollTimer);
    }

    state.scrollTimer = setTimeout(() => {
      state.scrollTimer = null;
      state.scrollHold = false;
      setHostVisible(true);
      if (!state.busy) {
        schedule(0);
      }
    }, 340);
  }

  function handleViewportChange() {
    if (!state.enabled) {
      return;
    }
    state.forcePending = true;
    state.scrollHold = true;
    clearBoxes();
    clearBusy();
    setHostVisible(false);
    ensureHost();

    if (state.scrollTimer) {
      clearTimeout(state.scrollTimer);
    }

    state.scrollTimer = setTimeout(() => {
      state.scrollTimer = null;
      state.scrollHold = false;
      setHostVisible(true);
      if (!state.busy) {
        schedule(0);
      }
    }, 280);
  }

  function bindFullscreen() {
    if (state.fullscreenBound) {
      return;
    }
    state.fullscreenBound = true;
    document.addEventListener("fullscreenchange", () => {
      ensureHost();
      handleViewportChange();
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") {
      return false;
    }

    if (message.type === "ping") {
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "force-refresh") {
      if (!state.enabled) {
        sendResponse({ ok: false, reason: "disabled" });
        return false;
      }
      state.scrollHold = false;
      state.lastToastAt = 0;
      state.forcePending = true;
      if (!state.busy) {
        schedule(0);
      }
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "render") {
      handleRender(message);
      return false;
    }

    if (message.type === "error") {
      handleError(message);
      return false;
    }

    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") {
      return;
    }

    if (changes.enabled) {
      state.enabled = changes.enabled.newValue === true;
      state.token = createToken();
      if (state.enabled) {
        state.busy = false;
        state.scrollHold = false;
        startLoop(true);
      } else {
        stopEverything();
      }
    }

    if (changes.interval) {
      const next = Number(changes.interval.newValue);
      if (Number.isFinite(next) && next >= 1000) {
        state.interval = next;
        if (state.enabled && !state.busy) {
          schedule(state.interval);
        }
      }
    }

    if (changes.sourceLang && changes.sourceLang.newValue !== state.sourceLang) {
      state.sourceLang = changes.sourceLang.newValue;
      state.token = createToken();
      state.busy = false;
      clearSafety();
      clearBusy();
      clearBoxes();
      if (state.enabled) {
        state.forcePending = true;
        schedule(0);
      }
    }
  });

  document.addEventListener("scroll", handleScroll, { capture: true, passive: true });
  window.addEventListener("resize", handleViewportChange, { passive: true });
  window.addEventListener("orientationchange", handleViewportChange, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      startLoop(true);
    } else {
      clearTimer();
      clearSafety();
      state.busy = false;
      clearBusy();
      setHostVisible(true);
    }
  });

  bindFullscreen();

  chrome.storage.local
    .get(DEFAULTS)
    .then((settings) => {
      state.enabled = settings.enabled === true;
      state.interval = Number(settings.interval) || DEFAULTS.interval;
      state.sourceLang = settings.sourceLang || DEFAULTS.sourceLang;
      if (state.enabled) {
        startLoop(true);
      }
    })
    .catch(() => {});
})();

