const TESSERACT_BASE = chrome.runtime.getURL("vendor/");
const MAX_LINES = 120;
const MIN_CONFIDENCE = 35;
const CJK = "\\u3040-\\u30ff\\u3400-\\u9fff\\uac00-\\ud7af";

let worker = null;
let workerLang = null;
let workerPromise = null;
let queue = Promise.resolve();

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("截图解码失败"));
    image.src = src;
  });
}

async function prepareImage(source) {
  const image = await loadImage(source);
  let scale = 1;
  if (image.naturalWidth < 2600) {
    scale = Math.min(3, 2600 / image.naturalWidth);
  }
  if (image.naturalWidth * scale > 2600) {
    scale = 2600 / image.naturalWidth;
  }
  let width = Math.max(1, Math.round(image.naturalWidth * scale));
  let height = Math.max(1, Math.round(image.naturalHeight * scale));
  const maxPixels = 6000000;
  if (width * height > maxPixels) {
    const factor = Math.sqrt(maxPixels / (width * height));
    width = Math.max(1, Math.round(width * factor));
    height = Math.max(1, Math.round(height * factor));
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  const frame = context.getImageData(0, 0, width, height);
  const pixels = frame.data;
  const step = Math.max(4, Math.floor((width * height) / 40000)) * 4;
  let luminance = 0;
  let samples = 0;

  for (let index = 0; index < pixels.length; index += step) {
    luminance += 0.299 * pixels[index] + 0.587 * pixels[index + 1] + 0.114 * pixels[index + 2];
    samples += 1;
  }

  if (samples > 0 && luminance / samples < 100) {
    for (let index = 0; index < pixels.length; index += 4) {
      pixels[index] = 255 - pixels[index];
      pixels[index + 1] = 255 - pixels[index + 1];
      pixels[index + 2] = 255 - pixels[index + 2];
    }
    context.putImageData(frame, 0, 0);
  }

  normalizeDarkBackgrounds(context, width, height);

  return {
    dataUrl: canvas.toDataURL("image/png"),
    width,
    height
  };
}

function normalizeDarkBackgrounds(context, width, height) {
  const block = 4;
  const smallWidth = Math.ceil(width / block);
  const smallHeight = Math.ceil(height / block);
  if (smallWidth < 8 || smallHeight < 8) {
    return;
  }

  const small = document.createElement("canvas");
  small.width = smallWidth;
  small.height = smallHeight;
  const smallContext = small.getContext("2d", { willReadFrequently: true });
  smallContext.fillStyle = "#ffffff";
  smallContext.fillRect(0, 0, smallWidth, smallHeight);
  smallContext.drawImage(context.canvas, 0, 0, width, height, 0, 0, smallWidth, smallHeight);

  const smallData = smallContext.getImageData(0, 0, smallWidth, smallHeight).data;
  const mask = new Uint8Array(smallWidth * smallHeight);
  const smallLuminance = new Float32Array(smallWidth * smallHeight);

  for (let index = 0; index < smallWidth * smallHeight; index += 1) {
    const r = smallData[index * 4];
    const g = smallData[index * 4 + 1];
    const b = smallData[index * 4 + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    smallLuminance[index] = luminance;
    const colored = max - min >= 26 && luminance > 25 && luminance < 210;
    mask[index] = colored || luminance < 75 ? 1 : 0;
  }

  const visited = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  const candidates = [];

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) {
      continue;
    }

    let top = 0;
    stack[top] = start;
    top += 1;
    visited[start] = 1;

    let minX = start % smallWidth;
    let maxX = minX;
    let minY = Math.floor(start / smallWidth);
    let maxY = minY;
    let area = 0;
    let luminanceTotal = 0;

    while (top > 0) {
      top -= 1;
      const index = stack[top];
      const x = index % smallWidth;
      const y = Math.floor(index / smallWidth);
      area += 1;
      luminanceTotal += smallLuminance[index];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      const neighbors = [
        x > 0 ? index - 1 : -1,
        x < smallWidth - 1 ? index + 1 : -1,
        y > 0 ? index - smallWidth : -1,
        y < smallHeight - 1 ? index + smallWidth : -1
      ];

      for (const neighbor of neighbors) {
        if (neighbor >= 0 && mask[neighbor] && !visited[neighbor]) {
          visited[neighbor] = 1;
          stack[top] = neighbor;
          top += 1;
        }
      }
    }

    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const fill = area / (boxWidth * boxHeight);
    const meanLuminance = luminanceTotal / area;
    const aspect = boxWidth / boxHeight;

    if (area < 150 || boxWidth < 20 || boxHeight < 4) {
      continue;
    }
    if (fill < 0.35 || meanLuminance > 150 || aspect < 1.5 || aspect > 20) {
      continue;
    }
    if (boxWidth * boxHeight > smallWidth * smallHeight * 0.25) {
      continue;
    }

    const pad = 3 * block;
    const x0 = Math.max(0, minX * block - pad);
    const y0 = Math.max(0, minY * block - pad);
    const x1 = Math.min(width, (maxX + 1) * block + pad);
    const y1 = Math.min(height, (maxY + 1) * block + pad);
    candidates.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0, meanLuminance });
  }

  if (candidates.length === 0) {
    return;
  }

  const frame = context.getImageData(0, 0, width, height);
  const pixels = frame.data;

  for (const candidate of candidates.slice(0, 16)) {
    const { x: boxX, y: boxY, width: boxWidth, height: boxHeight } = candidate;
    if (boxWidth < 4 || boxHeight < 4) {
      continue;
    }

    const outside = new Uint8Array(boxWidth * boxHeight);
    const queue = new Int32Array(boxWidth * boxHeight);
    let head = 0;
    let tail = 0;

    const isPageWhite = (localX, localY) => {
      const pixel = ((boxY + localY) * width + (boxX + localX)) * 4;
      return (
        pixels[pixel] > 235 &&
        pixels[pixel + 1] > 235 &&
        pixels[pixel + 2] > 235
      );
    };

    for (let x = 0; x < boxWidth; x += 1) {
      for (const y of [0, boxHeight - 1]) {
        const local = y * boxWidth + x;
        if (!outside[local] && isPageWhite(x, y)) {
          outside[local] = 1;
          queue[tail] = local;
          tail += 1;
        }
      }
    }

    for (let y = 0; y < boxHeight; y += 1) {
      for (const x of [0, boxWidth - 1]) {
        const local = y * boxWidth + x;
        if (!outside[local] && isPageWhite(x, y)) {
          outside[local] = 1;
          queue[tail] = local;
          tail += 1;
        }
      }
    }

    while (head < tail) {
      const local = queue[head];
      head += 1;
      const x = local % boxWidth;
      const y = Math.floor(local / boxWidth);
      const neighbors = [
        x > 0 ? local - 1 : -1,
        x < boxWidth - 1 ? local + 1 : -1,
        y > 0 ? local - boxWidth : -1,
        y < boxHeight - 1 ? local + boxWidth : -1
      ];
      for (const neighbor of neighbors) {
        if (neighbor >= 0 && !outside[neighbor] && isPageWhite(neighbor % boxWidth, Math.floor(neighbor / boxWidth))) {
          outside[neighbor] = 1;
          queue[tail] = neighbor;
          tail += 1;
        }
      }
    }

    let redTotal = 0;
    let greenTotal = 0;
    let blueTotal = 0;
    let backgroundCount = 0;
    let brightCount = 0;
    let insideCount = 0;

    for (let y = 0; y < boxHeight; y += 1) {
      for (let x = 0; x < boxWidth; x += 1) {
        const local = y * boxWidth + x;
        if (outside[local]) {
          continue;
        }
        insideCount += 1;
        const pixel = ((boxY + y) * width + (boxX + x)) * 4;
        const r = pixels[pixel];
        const g = pixels[pixel + 1];
        const b = pixels[pixel + 2];
        const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
        if (luminance < candidate.meanLuminance + 15) {
          redTotal += r;
          greenTotal += g;
          blueTotal += b;
          backgroundCount += 1;
        }
        if (luminance > Math.max(175, candidate.meanLuminance + 70)) {
          brightCount += 1;
        }
      }
    }

    if (backgroundCount === 0 || insideCount === 0) {
      continue;
    }

    const textFraction = brightCount / insideCount;
    if (textFraction < 0.01 || textFraction > 0.65) {
      continue;
    }

    const backgroundRed = redTotal / backgroundCount;
    const backgroundGreen = greenTotal / backgroundCount;
    const backgroundBlue = blueTotal / backgroundCount;
    const textDistance =
      Math.hypot(255 - backgroundRed, 255 - backgroundGreen, 255 - backgroundBlue) || 1;

    for (let y = 0; y < boxHeight; y += 1) {
      for (let x = 0; x < boxWidth; x += 1) {
        const local = y * boxWidth + x;
        const pixel = ((boxY + y) * width + (boxX + x)) * 4;
        if (outside[local]) {
          pixels[pixel] = 255;
          pixels[pixel + 1] = 255;
          pixels[pixel + 2] = 255;
          continue;
        }
        const distance = Math.hypot(
          pixels[pixel] - backgroundRed,
          pixels[pixel + 1] - backgroundGreen,
          pixels[pixel + 2] - backgroundBlue
        );
        let alpha = (distance - 45) / Math.max(60, textDistance - 45);
        alpha = Math.min(1, Math.max(0, alpha));
        const value = Math.round(255 * (1 - alpha));
        pixels[pixel] = value;
        pixels[pixel + 1] = value;
        pixels[pixel + 2] = value;
      }
    }
  }

  context.putImageData(frame, 0, 0);
}

async function createWorker(lang) {
  const instance = await Tesseract.createWorker(lang, 1, {
    workerPath: TESSERACT_BASE + "worker.min.js",
    corePath: TESSERACT_BASE + "core",
    langPath: TESSERACT_BASE + "lang",
    gzip: true,
    workerBlobURL: false,
    logger: () => {}
  });

  await instance.setParameters({
    tessedit_pageseg_mode: "3",
    preserve_interword_spaces: "1",
    user_defined_dpi: "96"
  });

  return instance;
}

async function getWorker(lang) {
  if (worker && workerLang === lang) {
    return worker;
  }

  if (workerPromise) {
    await workerPromise.catch(() => {});
    if (worker && workerLang === lang) {
      return worker;
    }
  }

  if (worker) {
    const previous = worker;
    worker = null;
    workerLang = null;
    await previous.terminate().catch(() => {});
  }

  workerPromise = createWorker(lang);
  try {
    const instance = await workerPromise;
    worker = instance;
    workerLang = lang;
    return instance;
  } finally {
    workerPromise = null;
  }
}

async function resetWorker() {
  if (!worker) {
    return;
  }
  const previous = worker;
  worker = null;
  workerLang = null;
  await previous.terminate().catch(() => {});
}

function cleanText(text) {
  const cjkNeighbors = new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, "g");
  const cjkPunctuation = new RegExp(`([${CJK}])\\s+([，。！？；：、）》」』】])`, "g");
  return text
    .replace(/\s+/g, " ")
    .replace(cjkNeighbors, "$1")
    .replace(cjkPunctuation, "$1$2")
    .trim();
}

function buildLine(words) {
  if (!words.length) {
    return null;
  }

  const text = cleanText(words.map((word) => word.text).join(" "));
  const left = Math.min(...words.map((word) => word.left));
  const top = Math.min(...words.map((word) => word.top));
  const right = Math.max(...words.map((word) => word.right));
  const bottom = Math.max(...words.map((word) => word.bottom));
  const width = right - left;
  const height = bottom - top;
  const compactLength = text.replace(/\s/g, "").length;
  const hasCjk = new RegExp(`[${CJK}]`, "u").test(text);
  const confidences = words.map((word) => word.confidence);
  const averageConfidence = confidences.reduce((total, value) => total + value, 0) / confidences.length;
  const maxConfidence = Math.max(...confidences);

  if (!text || width < 4 || height < 6) {
    return null;
  }
  if (compactLength < 2 && !hasCjk) {
    return null;
  }
  if (averageConfidence < MIN_CONFIDENCE && maxConfidence < 70) {
    return null;
  }

  return {
    text,
    left,
    top,
    width,
    height,
    confidence: averageConfidence
  };
}

function parseTsv(tsv) {
  if (typeof tsv !== "string" || !tsv) {
    return [];
  }

  const groups = new Map();

  for (const row of tsv.split("\n")) {
    if (!row) {
      continue;
    }
    const columns = row.split("\t");
    if (columns.length < 12 || columns[0] !== "5") {
      continue;
    }

    const confidence = Number.parseFloat(columns[10]);
    const text = columns.slice(11).join("\t").trim();
    if (!text || !Number.isFinite(confidence) || confidence < 5) {
      continue;
    }
    if (!/[\p{L}\p{N}]/u.test(text)) {
      continue;
    }

    const left = Number(columns[6]);
    const top = Number(columns[7]);
    const width = Number(columns[8]);
    const height = Number(columns[9]);
    if (!(width > 0 && height > 0)) {
      continue;
    }

    const key = `${columns[2]}:${columns[3]}:${columns[4]}`;
    let group = groups.get(key);
    if (!group) {
      group = { words: [] };
      groups.set(key, group);
    }
    group.words.push({
      text,
      left,
      top,
      right: left + width,
      bottom: top + height,
      confidence
    });
  }

  const lines = [];

  for (const group of groups.values()) {
    const words = group.words.slice().sort((first, second) => first.left - second.left);
    if (!words.length) {
      continue;
    }

    const gaps = [];
    for (let index = 1; index < words.length; index += 1) {
      gaps.push(words[index].left - words[index - 1].right);
    }
    const sortedGaps = gaps.slice().sort((first, second) => first - second);
    const medianGap = sortedGaps.length
      ? sortedGaps[Math.floor(sortedGaps.length / 2)]
      : 0;
    const heights = words
      .map((word) => word.bottom - word.top)
      .sort((first, second) => first - second);
    const medianHeight = heights[Math.floor(heights.length / 2)] || 0;
    const splitThreshold = Math.max(18, medianHeight * 1.3, medianGap * 2.5);

    let segment = [words[0]];
    for (let index = 1; index < words.length; index += 1) {
      const gap = words[index].left - words[index - 1].right;
      if (gap > splitThreshold) {
        const line = buildLine(segment);
        if (line) {
          lines.push(line);
        }
        segment = [];
      }
      segment.push(words[index]);
    }
    if (segment.length) {
      const line = buildLine(segment);
      if (line) {
        lines.push(line);
      }
    }
  }

  lines.sort((first, second) => {
    if (Math.abs(first.top - second.top) > 8) {
      return first.top - second.top;
    }
    return first.left - second.left;
  });

  return lines.slice(0, MAX_LINES);
}

async function recognize(image, lang) {
  const startedAt = performance.now();
  const prepared = await prepareImage(image);
  const instance = await getWorker(lang);

  let result;
  try {
    result = await Promise.race([
      instance.recognize(
        prepared.dataUrl,
        { rotateAuto: false },
        { text: false, blocks: false, hocr: false, tsv: true }
      ),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("文字识别超时")), 45000);
      })
    ]);
  } catch (error) {
    await resetWorker();
    throw error;
  }

  const lines = parseTsv(result?.data?.tsv || "");

  return {
    lines,
    imageWidth: prepared.width,
    imageHeight: prepared.height,
    ocrMs: Math.round(performance.now() - startedAt)
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== "offscreen" || message.type !== "ocr") {
    return false;
  }

  queue = queue
    .catch(() => {})
    .then(() => recognize(message.image, message.lang))
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      console.error("即译 OCR 失败", error);
      sendResponse({ ok: false, error: error?.message || "文字识别失败" });
    });

  return true;
});
