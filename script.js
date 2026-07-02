const imageInput = document.querySelector("#imageInput");
const previewImage = document.querySelector("#previewImage");
const previewEmpty = document.querySelector("#previewEmpty");
const extractButton = document.querySelector("#extractButton");
const clearButton = document.querySelector("#clearButton");
const statusBox = document.querySelector("#status");
const fileName = document.querySelector("#fileName");
const todoList = document.querySelector("#todoList");
const todoCount = document.querySelector("#todoCount");
const dropZone = document.querySelector(".drop-zone");

const KEYWORD_PATTERN =
  /(課題|宿題|レポート|小テスト|テスト|試験|提出|締切|期限|予定|授業|講義|assignment|homework|report|quiz|exam|deadline|due|submit|schedule|event)/i;
const DEADLINE_PATTERN = /(締切|期限|提出期限|提出|due|deadline|submit|until|まで|迄)/i;
const TITLE_LABEL_PATTERN = /^(課題名|予定名|タイトル|件名|name|title)\s*[:：]?\s*/i;
const NOISE_PATTERN =
  /^(ホーム|通知|設定|メニュー|戻る|次へ|前へ|検索|dashboard|calendar|menu|settings|home|login|logout)$/i;

let selectedFile = null;
let objectUrl = null;

imageInput.addEventListener("change", (event) => {
  const [file] = event.target.files;
  setImage(file);
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("dragging");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("dragging");
});

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragging");
  const [file] = event.dataTransfer.files;
  setImage(file);
});

extractButton.addEventListener("click", async () => {
  if (!selectedFile) return;

  if (!window.Tesseract) {
    setStatus("OCRライブラリを読み込めませんでした。ネットワーク接続を確認してください。", true);
    return;
  }

  setLoading(true);
  setStatus("小さい文字を読み取りやすいように画像を補正しています...");

  try {
    const processedImage = await preprocessImage(selectedFile);
    const firstPass = await recognizeImage(processedImage, "single_block", 6);
    const shouldRetry = firstPass.confidence < 62 || firstPass.text.replace(/\s/g, "").length < 30;
    const secondPass = shouldRetry ? await recognizeImage(selectedFile, "sparse_text", 11) : null;
    const text = mergeOcrText(firstPass.text, secondPass?.text || "");
    const todos = extractTodos(text);

    renderTodos(todos, text);

    if (todos.length > 0) {
      setStatus(`${todos.length}件のToDo候補を時系列順に抽出しました。`);
    } else {
      setStatus("課題名や日付を特定できませんでした。OCR読み取り結果を確認してください。", true);
    }
  } catch (error) {
    console.error(error);
    setStatus("抽出中にエラーが発生しました。文字が鮮明な画像で再度試してください。", true);
  } finally {
    setLoading(false);
  }
});

clearButton.addEventListener("click", () => {
  selectedFile = null;
  imageInput.value = "";
  fileName.textContent = "未選択";
  previewImage.hidden = true;
  previewImage.removeAttribute("src");
  previewEmpty.hidden = false;
  extractButton.disabled = true;
  clearButton.disabled = true;
  renderTodos([], "");
  setStatus("画像を選択してください。");

  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
});

function setImage(file) {
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    setStatus("画像ファイルを選択してください。", true);
    return;
  }

  selectedFile = file;

  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
  }

  objectUrl = URL.createObjectURL(file);
  previewImage.src = objectUrl;
  previewImage.hidden = false;
  previewEmpty.hidden = true;
  fileName.textContent = file.name;
  extractButton.disabled = false;
  clearButton.disabled = false;
  renderTodos([], "");
  setStatus("画像を読み込みました。抽出ボタンを押してください。");
}

function setLoading(isLoading) {
  extractButton.disabled = isLoading || !selectedFile;
  extractButton.textContent = isLoading ? "抽出中..." : "課題名・締切・予定を抽出";
}

function setStatus(message, isError = false) {
  statusBox.textContent = message;
  statusBox.classList.toggle("error", isError);
}

async function preprocessImage(file) {
  const image = await loadImage(file);
  const scale = Math.min(3, Math.max(1.7, 2200 / image.width));
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });

  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  for (let index = 0; index < data.length; index += 4) {
    const gray = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
    const contrasted = Math.max(0, Math.min(255, (gray - 128) * 1.42 + 128));
    const sharpened = contrasted > 185 ? 255 : contrasted < 80 ? 0 : contrasted;
    data[index] = sharpened;
    data[index + 1] = sharpened;
    data[index + 2] = sharpened;
  }

  context.putImageData(imageData, 0, 0);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob || file), "image/png");
  });
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("画像を読み込めませんでした。"));
    };
    image.src = url;
  });
}

async function recognizeImage(imageSource, label, pageSegMode) {
  const result = await Tesseract.recognize(imageSource, "jpn+eng", {
    tessedit_pageseg_mode: String(pageSegMode),
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
    logger: (message) => {
      if (message.status === "recognizing text") {
        const percent = Math.round(message.progress * 100);
        setStatus(`OCR実行中 (${label})... ${percent}%`);
      }
    },
  });

  return {
    text: result.data.text.trim(),
    confidence: result.data.confidence || 0,
  };
}

function mergeOcrText(primaryText, fallbackText) {
  const lines = [...primaryText.split(/\r?\n/), ...fallbackText.split(/\r?\n/)]
    .map((line) => normalizeLine(line))
    .filter(Boolean);
  return [...new Set(lines)].join("\n");
}

function extractTodos(text) {
  const lines = buildLogicalLines(text);
  if (lines.length === 0) return [];

  const datedItems = [];

  lines.forEach((line, index) => {
    const dateInfo = parseDateTime(line);
    if (!dateInfo) return;

    const context = collectContext(lines, index, 3);
    const title = findTitleCandidate(context, line, dateInfo.raw);
    const sourceScore = scoreContext(context.map((item) => item.text).join(" "));

    datedItems.push({
      title: title || "課題または予定",
      dueDate: dateInfo.dateText,
      time: dateInfo.timeText || "時刻未検出",
      sortValue: dateInfo.sortValue,
      confidence: sourceScore,
    });
  });

  const undatedItems = findUndatedItems(lines, datedItems);
  return uniqueTodos([...datedItems, ...undatedItems])
    .sort(compareTodos)
    .slice(0, 12);
}

function buildLogicalLines(text) {
  const rawLines = text
    .split(/\r?\n/)
    .map((line) => normalizeLine(line))
    .filter(Boolean);

  const merged = [];

  rawLines.forEach((line) => {
    const previous = merged[merged.length - 1];
    const shouldJoin =
      previous &&
      !parseDateTime(previous) &&
      !parseDateTime(line) &&
      previous.length + line.length < 70 &&
      (KEYWORD_PATTERN.test(previous) || TITLE_LABEL_PATTERN.test(previous));

    if (shouldJoin) {
      merged[merged.length - 1] = `${previous} ${line}`;
    } else {
      merged.push(line);
    }
  });

  return merged;
}

function normalizeLine(line) {
  return line
    .normalize("NFKC")
    .replace(/[|｜]/g, " ")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDateTime(line) {
  const normalized = normalizeLine(line)
    .replace(/(\d)\s*年\s*(\d)/g, "$1年$2")
    .replace(/(\d)\s*月\s*(\d)/g, "$1月$2")
    .replace(/(\d)\s*日/g, "$1日")
    .replace(/(\d)\s*[:：]\s*(\d{2})/g, "$1:$2");

  const patterns = [
    /((20\d{2})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})日?)/,
    /((\d{1,2})[\/\-.月](\d{1,2})日?)/,
  ];
  const dateMatch = patterns.map((pattern) => normalized.match(pattern)).find(Boolean);
  if (!dateMatch) return null;

  const timeMatch = normalized.match(/(?:^|[^\d])([01]?\d|2[0-3])[:：]([0-5]\d)(?:[^\d]|$)/);
  const hasYear = dateMatch.length === 5;
  const currentYear = new Date().getFullYear();
  const year = hasYear ? Number(dateMatch[2]) : currentYear;
  const month = Number(hasYear ? dateMatch[3] : dateMatch[2]);
  const day = Number(hasYear ? dateMatch[4] : dateMatch[3]);

  if (!isValidDate(year, month, day)) return null;

  const hour = timeMatch ? Number(timeMatch[1]) : 23;
  const minute = timeMatch ? Number(timeMatch[2]) : 59;
  const sortValue = new Date(year, month - 1, day, hour, minute).getTime();

  return {
    raw: [dateMatch[0], timeMatch?.[0] || ""].join(" ").trim(),
    dateText: formatDate(year, month, day, !hasYear),
    timeText: timeMatch ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` : "",
    sortValue,
  };
}

function isValidDate(year, month, day) {
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function formatDate(year, month, day, inferredYear) {
  const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return inferredYear ? `${date} (年推定)` : date;
}

function collectContext(lines, dateIndex, radius) {
  const start = Math.max(0, dateIndex - radius);
  const end = Math.min(lines.length - 1, dateIndex + radius);
  const context = [];

  for (let index = start; index <= end; index += 1) {
    context.push({
      text: lines[index],
      distance: Math.abs(index - dateIndex),
      index,
    });
  }

  return context;
}

function findTitleCandidate(context, dateLine, rawDate) {
  const candidates = context
    .map((item) => {
      const withoutDate = stripDateTime(item.text, rawDate);
      return {
        text: cleanTitle(withoutDate),
        score: scoreTitleLine(withoutDate, item.distance),
      };
    })
    .filter((item) => isUsableTitle(item.text))
    .sort((a, b) => b.score - a.score);

  const sameLineTitle = cleanTitle(stripDateTime(dateLine, rawDate));
  if (isUsableTitle(sameLineTitle) && scoreTitleLine(sameLineTitle, 0) >= (candidates[0]?.score || 0) - 1) {
    return sameLineTitle;
  }

  return candidates[0]?.text || "";
}

function stripDateTime(line, rawDate) {
  return line
    .replace(rawDate, " ")
    .replace(/(?:20\d{2}[\/\-.年])?\d{1,2}[\/\-.月]\d{1,2}日?/g, " ")
    .replace(/\([月火水木金土日]\)/g, " ")
    .replace(/(?:[01]?\d|2[0-3])[:：][0-5]\d/g, " ")
    .replace(DEADLINE_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreContext(text) {
  let score = 0;
  if (KEYWORD_PATTERN.test(text)) score += 2;
  if (DEADLINE_PATTERN.test(text)) score += 3;
  return score;
}

function scoreTitleLine(line, distance) {
  let score = 8 - distance * 1.5;
  if (TITLE_LABEL_PATTERN.test(line)) score += 5;
  if (/(課題|宿題|レポート|小テスト|提出|assignment|homework|report|quiz)/i.test(line)) score += 4;
  if (/(予定|授業|講義|schedule|event)/i.test(line)) score += 2;
  if (DEADLINE_PATTERN.test(line)) score += 2;
  if (line.length >= 8 && line.length <= 48) score += 1.5;
  if (NOISE_PATTERN.test(line)) score -= 10;
  return score;
}

function isUsableTitle(title) {
  if (!title || title.length < 2 || title.length > 90) return false;
  if (NOISE_PATTERN.test(title)) return false;
  if (/^[\d\s:：\/\-.年月日まで迄]+$/.test(title)) return false;
  if (/^[()月火水木金土日\s]+$/.test(title)) return false;
  return true;
}

function cleanTitle(title) {
  return title
    .replace(TITLE_LABEL_PATTERN, "")
    .replace(/^(提出|締切|期限|予定|due|deadline|schedule)\s*[:：-]?\s*/i, "")
    .replace(/^[・\-*●○\s]+/, "")
    .replace(/[。,:：\-]+$/g, "")
    .trim();
}

function findUndatedItems(lines, datedItems) {
  const existingTitles = new Set(datedItems.map((item) => item.title));
  return lines
    .filter((line) => KEYWORD_PATTERN.test(line) && !parseDateTime(line))
    .map((line) => cleanTitle(line))
    .filter((title) => isUsableTitle(title) && !existingTitles.has(title))
    .slice(0, 4)
    .map((title) => ({
      title,
      dueDate: "期限不明",
      time: "時刻未検出",
      sortValue: Number.POSITIVE_INFINITY,
      confidence: 1,
    }));
}

function uniqueTodos(todos) {
  const seen = new Set();
  return todos.filter((todo) => {
    const key = `${todo.title}-${todo.dueDate}-${todo.time}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareTodos(a, b) {
  if (a.sortValue !== b.sortValue) return a.sortValue - b.sortValue;
  return b.confidence - a.confidence;
}

function renderTodos(todos, rawText) {
  todoCount.textContent = `${todos.length}件`;
  todoList.innerHTML = "";

  if (todos.length === 0 && !rawText) {
    todoList.innerHTML = '<p class="empty">抽出結果はまだありません。</p>';
    return;
  }

  todos.forEach((todo) => {
    const item = document.createElement("label");
    item.className = "todo-item";
    item.innerHTML = `
      <input type="checkbox" />
      <span>
        <p class="todo-title"></p>
        <p class="todo-meta"></p>
      </span>
    `;
    item.querySelector(".todo-title").textContent = todo.title;
    item.querySelector(".todo-meta").textContent = `締切日: ${todo.dueDate} / 時刻: ${todo.time}`;
    todoList.appendChild(item);
  });

  if (rawText) {
    const raw = document.createElement("details");
    raw.className = "raw-text";
    raw.innerHTML = "<summary>OCR読み取り結果</summary><div></div>";
    raw.querySelector("div").textContent = rawText || "文字を読み取れませんでした。";
    todoList.appendChild(raw);
  }
}
