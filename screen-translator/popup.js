const enabledInput = document.getElementById("enabled");
const sourceLangSelect = document.getElementById("sourceLang");
const intervalSelect = document.getElementById("interval");
const refreshButton = document.getElementById("refresh");
const statusDot = document.getElementById("statusDot");
const statusTitle = document.getElementById("statusTitle");
const statusDetail = document.getElementById("statusDetail");
const notice = document.getElementById("notice");

const PROVIDER_LABELS = {
  bing: "Bing",
  google: "Google",
  mymemory: "MyMemory",
  cache: "本地缓存"
};

let pollTimer = null;
let noticeTimer = null;

function setNotice(message, kind) {
  if (noticeTimer) {
    clearTimeout(noticeTimer);
    noticeTimer = null;
  }
  notice.className = "notice";
  notice.hidden = !message;
  notice.textContent = message || "";

  if (!message) {
    return;
  }
  if (kind === "ok") {
    notice.classList.add("ok");
  }
  if (kind === "ok") {
    noticeTimer = setTimeout(() => {
      notice.hidden = true;
      notice.textContent = "";
      notice.className = "notice";
    }, 2600);
  }
}

function formatDuration(milliseconds) {
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value <= 0) {
    return "";
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)} 秒`;
  }
  return `${Math.round(value)} 毫秒`;
}

function setStatus(dotClass, title, detail) {
  statusDot.className = `status-dot${dotClass ? ` ${dotClass}` : ""}`;
  statusTitle.textContent = title;
  statusDetail.textContent = detail;
}

function renderStatus(status) {
  if (!status) {
    setStatus("warn", "无法读取扩展状态", "请关闭弹窗后重新打开");
    return;
  }

  refreshButton.disabled = status.enabled !== true;

  if (!status.enabled) {
    setStatus("", "实时翻译已关闭", "打开右上角开关，开始翻译当前页面");
    return;
  }

  const last = status.last || {};

  if (status.busy) {
    setStatus(
      "busy",
      "正在识别屏幕文字…",
      last.at ? "正在更新当前页面的译文" : "首次使用会加载本地识别模型，请稍候"
    );
    return;
  }

  if (last.error) {
    setStatus("warn", "翻译遇到问题", last.error);
    return;
  }

  if (last.at) {
    if (Number(last.count) > 0) {
      const details = [];
      const ocr = formatDuration(last.ocrMs);
      const translate = formatDuration(last.trMs);
      if (ocr) {
        details.push(`识别 ${ocr}`);
      }
      if (translate) {
        details.push(`翻译 ${translate}`);
      }
      if (PROVIDER_LABELS[last.provider]) {
        details.push(PROVIDER_LABELS[last.provider]);
      }
      setStatus("on", `已覆盖 ${last.count} 条译文`, details.join(" · "));
    } else {
      setStatus("on", "当前画面没有可翻译文字", "画面变化后会自动刷新");
    }
    return;
  }

  setStatus("on", "已开启", "等待当前页面文字…");
}

async function pollStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ type: "get-status" });
    if (status) {
      renderStatus(status);
    }
  } catch {}
  pollTimer = setTimeout(pollStatus, 1200);
}

async function saveSettings() {
  const interval = Number(intervalSelect.value);
  await chrome.storage.local.set({
    interval: Number.isFinite(interval) ? interval : 2500,
    sourceLang: sourceLangSelect.value
  });
}

enabledInput.addEventListener("change", () => {
  const enabled = enabledInput.checked;
  setNotice("");
  refreshButton.disabled = !enabled;
  renderStatus({ enabled, busy: false, last: {} });
  chrome.storage.local.set({ enabled });
});

sourceLangSelect.addEventListener("change", () => {
  saveSettings();
});

intervalSelect.addEventListener("change", () => {
  saveSettings();
});

refreshButton.addEventListener("click", async () => {
  refreshButton.disabled = true;
  setNotice("");

  try {
    const result = await chrome.runtime.sendMessage({ type: "refresh-active-tab" });
    if (!result || !result.ok) {
      setNotice(result?.error || "刷新失败，请稍后重试");
    } else {
      setNotice("已请求刷新，请查看当前页面。", "ok");
    }
  } catch {
    setNotice("无法连接扩展后台，请重新打开弹窗");
  }

  setTimeout(() => {
    refreshButton.disabled = enabledInput.checked !== true;
  }, 700);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }
  if (changes.enabled) {
    const enabled = changes.enabled.newValue === true;
    enabledInput.checked = enabled;
    refreshButton.disabled = !enabled;
  }
  if (changes.interval) {
    intervalSelect.value = String(changes.interval.newValue);
  }
  if (changes.sourceLang) {
    sourceLangSelect.value = changes.sourceLang.newValue;
  }
});

async function init() {
  try {
    const stored = await chrome.storage.local.get({
      enabled: false,
      interval: 2500,
      sourceLang: "en"
    });

    enabledInput.checked = stored.enabled === true;

    intervalSelect.value = String(stored.interval);
    if (!intervalSelect.value) {
      intervalSelect.value = "2500";
      chrome.storage.local.set({ interval: 2500 });
    }

    sourceLangSelect.value = stored.sourceLang;
    if (!sourceLangSelect.value) {
      sourceLangSelect.value = "en";
      chrome.storage.local.set({ sourceLang: "en" });
    }
    refreshButton.disabled = !enabledInput.checked;
    renderStatus({ enabled: enabledInput.checked, busy: false, last: {} });
  } catch {
    setStatus("warn", "无法读取设置", "请重新打开弹窗");
  }

  pollStatus();
}

init();

window.addEventListener("unload", () => {
  if (pollTimer) {
    clearTimeout(pollTimer);
  }
  if (noticeTimer) {
    clearTimeout(noticeTimer);
  }
});
