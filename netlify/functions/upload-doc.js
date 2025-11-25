// netlify/functions/upload-doc.js

// ====== ENV ======
const TELEGRAM_TOKEN = process.env.TG_BOT_TOKEN;
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || process.env.ADMIN_CHAT_ID || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const LOG_CHAT_ID = process.env.LOG_CHAT_ID || null;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;

const TELEGRAM_API = TELEGRAM_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_TOKEN}`
  : null;

if (!TELEGRAM_TOKEN) {
  console.error("TG_BOT_TOKEN is not set (upload-doc.js)");
}
if (!OPENAI_API_KEY) {
  console.error(
    "OPENAI_API_KEY is not set (upload-doc.js) — распознавание работать не будет"
  );
}

// ===== общая функция получения списка чатов-целей =====
function getTargets() {
  const targets = new Set();
  for (const id of ADMIN_CHAT_IDS) {
    if (id) targets.add(id);
  }
  if (LOG_CHAT_ID) targets.add(LOG_CHAT_ID);
  return Array.from(targets);
}

// ===== отправка сообщения в Telegram =====
async function sendTelegramMessage(chatId, text, extra = {}) {
  if (!TELEGRAM_API || !TELEGRAM_TOKEN) {
    console.error("sendTelegramMessage: no TELEGRAM_API / TELEGRAM_TOKEN");
    return;
  }

  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        ...extra,
      }),
    });

    if (!res.ok) {
      const txt = await res.text();
      console.error("sendMessage error:", res.status, txt);
    }
  } catch (e) {
    console.error("sendTelegramMessage exception:", e);
  }
}

// ===== helper'ы для вытаскивания фото из Telegram update =====

async function downloadTelegramFileAsBase64(fileId) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_API) {
    console.error("downloadTelegramFileAsBase64: no TELEGRAM_TOKEN/TELEGRAM_API");
    return null;
  }

  try {
    const res = await fetch(
      `${TELEGRAM_API}/getFile?file_id=${encodeURIComponent(fileId)}`
    );

    if (!res.ok) {
      const txt = await res.text();
      console.error("getFile error:", res.status, txt);
      return null;
    }

    const json = await res.json();
    const filePath = json?.result?.file_path;
    if (!filePath) {
      console.error("getFile: no file_path in result");
      return null;
    }

    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
    const fileRes = await fetch(fileUrl);

    if (!fileRes.ok) {
      const txt = await fileRes.text();
      console.error("download file error:", fileRes.status, txt);
      return null;
    }

    const arrayBuffer = await fileRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64 = buffer.toString("base64");

    let mime = "image/jpeg";
    if (/\.png$/i.test(filePath)) mime = "image/png";
    else if (/\.webp$/i.test(filePath)) mime = "image/webp";
    else if (/\.gif$/i.test(filePath)) mime = "image/gif";

    return { base64, mime, filePath };
  } catch (e) {
    console.error("downloadTelegramFileAsBase64 exception:", e);
    return null;
  }
}

async function getImageFromTelegramUpdate(telegramUpdate) {
  try {
    const msg =
      telegramUpdate.message ||
      telegramUpdate.edited_message ||
      telegramUpdate.channel_post ||
      telegramUpdate.edited_channel_post ||
      null;

    if (!msg) {
      console.error("getImageFromTelegramUpdate: no message in update");
      return null;
    }

    let fileId = null;

    if (Array.isArray(msg.photo) && msg.photo.length) {
      const best = msg.photo[msg.photo.length - 1];
      fileId = best.file_id;
    } else if (
      msg.document &&
      msg.document.mime_type &&
      msg.document.mime_type.startsWith("image/")
    ) {
      fileId = msg.document.file_id;
    }

    if (!fileId) {
      console.error(
        "getImageFromTelegramUpdate: no photo/document with image mime"
      );
      return null;
    }

    return await downloadTelegramFileAsBase64(fileId);
  } catch (e) {
    console.error("getImageFromTelegramUpdate exception:", e);
    return null;
  }
}

// ===== helper для вытаскивания JSON из ответа модели =====
function parseJsonFromString(str) {
  if (!str) return null;

  // если вдруг пришло как объект, не строка
  if (typeof str !== "string") {
    try {
      return JSON.parse(JSON.stringify(str));
    } catch {
      return null;
    }
  }

  // сначала пробуем просто JSON.parse
  try {
    return JSON.parse(str);
  } catch (e) {
    // ignore
  }

  // пробуем найти блок ```json ... ```
  const match = str.match(/```json([\s\S]*?)```/i);
  if (match && match[1]) {
    try {
      return JSON.parse(match[1].trim());
    } catch (e) {
      // ignore
    }
  }

  // пробуем любой {...} блок
  const braceMatch = str.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]);
    } catch (e) {
      // ignore
    }
  }

  return null;
}

// ===== основной вызов OpenAI =====
async function extractDocDataWithOpenAI(imageDataUrl, docType) {
  if (!OPENAI_API_KEY) {
    console.error("extractDocDataWithOpenAI: no OPENAI_API_KEY");
    return {
      ok: false,
      error: "NO_KEY",
      rawText: null,
      parsed: null,
    };
  }

  const docDescription =
    docType === "vu_front"
      ? `
Ты читаешь лицевую сторону водительского удостоверения Узбекистана.
Главное: 
- серия и номер ВУ (часто вверху, красные/чёрные символы, формат типа "AB1234567" или с пробелами),
- дата выдачи,
- дата окончания,
- категории,
- ФИО водителя,
- дата рождения,
- кем выдано.

Серый фон, серые водяные знаки и служебные коды типа "UZB" — *игнорируй*, это НЕ серия.
`
      : docType === "tech_front"
      ? `
Ты читаешь лицевую сторону техпаспорта (свидетельство о регистрации ТС Узбекистана).
Важно:
- серия и номер техпаспорта (обычно сверху),
- номер регистрационного знака (госномер),
- марка/модель автомобиля,
- цвет,
- тип кузова,
- ФИО собственника,
- адрес,
- VIN (если есть на лицевой стороне).

Серые служебные цифры и штрих-коды / серые коды печати НЕ считать серией техпаспорта.
`
      : `
Ты читаешь оборотную сторону техпаспорта (свидетельство о регистрации ТС Узбекистана).
Важно:
- VIN (если здесь),
- год выпуска автомобиля,
- номер кузова / шасси,
- объём двигателя,
- тип топлива,
- допускается серия/номер техпаспорта, если они повторены.
`;

  const schema = `
Верни строго JSON, без пояснений и текста вокруг.
Общий формат:

{
  "doc_type": "vu_front" | "tech_front" | "tech_back",
  "fields": {
    // для vu_front:
    "license_series": "строка без лишних пробелов",
    "license_number": "строка без лишних пробелов",
    "license_full": "серия+номер как на документе",
    "issued_date": "ГГГГ-MM-ДД или null",
    "expiry_date": "ГГГГ-MM-ДД или null",
    "categories": "строка, например 'B, B1'",
    "driver_name": "ФИО полностью",
    "birth_date": "ГГГГ-MM-ДД или null",
    "issued_by": "кем выдано или null",

    // для tech_front:
    "tech_series": "серия техпаспорта",
    "tech_number": "номер техпаспорта",
    "tech_full": "серия+номер как на документе",
    "plate_number": "госномер, как на документе",
    "owner_name": "ФИО владельца",
    "owner_address": "адрес или null",
    "car_model_text": "марка/модель как написано",
    "car_color_text": "цвет как написан",
    "vin": "VIN если есть, иначе null",

    // для tech_back:
    "vin": "VIN или null",
    "car_year": "год выпуска числом, например 2015, или null",
    "body_number": "номер кузова/шасси или null",
    "engine_volume": "объём двигателя, например '1.5' или '1498', или null",
    "fuel_type": "тип топлива или null"
  },
  "warnings": [
    "краткие предупреждения если есть неуверенность"
  ]
}

Если инфы нет — ставь null или пустую строку.
Особое внимание:
- *серия* = буквенно-цифровой код рядом/над номером, НЕ серые водяные знаки.
- Год машины (car_year) старайся извлечь точно, не придумывай. Если не уверен — null.
`;

  const promptText = `
Ты — ассистент, который аккуратно считывает данные с официальных документов Узбекистана (водительское удостоверение и техпаспорт).

Тип документа: ${docType || "unknown"}

${docDescription}

${schema}
`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          { role: "system", content: "Ты аккуратно извлекаешь данные из документов и возвращаешь строгий JSON." },
          {
            role: "user",
            content: [
              { type: "text", text: promptText },
              {
                type: "image_url",
                image_url: {
                  url: imageDataUrl,
                },
              },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const txt = await res.text();
      console.error("OpenAI error:", res.status, txt);
      return {
        ok: false,
        error: `HTTP_${res.status}`,
        rawText: txt,
        parsed: null,
      };
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || "";
    const parsed = parseJsonFromString(content);

    return {
      ok: true,
      rawText: content,
      parsed,
    };
  } catch (e) {
    console.error("extractDocDataWithOpenAI exception:", e);
    return {
      ok: false,
      error: "EXCEPTION",
      rawText: String(e),
      parsed: null,
    };
  }
}

// ===== форматирование для операторов =====
function formatDocForOperators(doc) {
  const {
    docType,
    result,
    phone,
    tg_id,
    carModel,
    carColor,
  } = doc;

  const p = (result && result.parsed) || {};
  const f = p.fields || {};
  const warnings = p.warnings || [];

  let title =
    docType === "vu_front"
      ? "📄 Водительское удостоверение (лицевая)"
      : docType === "tech_front"
      ? "📄 Техпаспорт (лицевая)"
      : docType === "tech_back"
      ? "📄 Техпаспорт (оборот)"
      : "📄 Документ";

  const headerParts = [];
  if (phone) headerParts.push(`📞 Телефон: \`${phone}\``);
  if (tg_id) headerParts.push(`💬 TG ID: \`${tg_id}\``);
  if (carModel || carColor) {
    headerParts.push(
      `🚗 Авто: ${carModel || "—"} / ${carColor || "—"}`
    );
  }

  let lines = [];
  lines.push(`*${title}*`);
  if (headerParts.length) {
    lines.push(headerParts.join("\n"));
  }
  lines.push("");

  if (docType === "vu_front") {
    lines.push(`Серия ВУ: \`${f.license_series || ""}\``);
    lines.push(`Номер ВУ: \`${f.license_number || ""}\``);
    lines.push(`Полностью: \`${f.license_full || ""}\``);
    lines.push(`ФИО: ${f.driver_name || "—"}`);
    lines.push(`Дата рождения: \`${f.birth_date || ""}\``);
    lines.push(`Категории: ${f.categories || "—"}`);
    lines.push(`Дата выдачи: \`${f.issued_date || ""}\``);
    lines.push(`Окончание срока: \`${f.expiry_date || ""}\``);
    lines.push(`Кем выдано: ${f.issued_by || "—"}`);
  } else if (docType === "tech_front") {
    lines.push(`Серия техпаспорта: \`${f.tech_series || ""}\``);
    lines.push(`Номер техпаспорта: \`${f.tech_number || ""}\``);
    lines.push(`Полностью: \`${f.tech_full || ""}\``);
    lines.push(`Госномер: \`${f.plate_number || ""}\``);
    lines.push(`Владелец: ${f.owner_name || "—"}`);
    lines.push(`Адрес: ${f.owner_address || "—"}`);
    lines.push(`Марка/модель (док): ${f.car_model_text || "—"}`);
    lines.push(`Цвет (док): ${f.car_color_text || "—"}`);
    lines.push(`VIN: \`${f.vin || ""}\``);
  } else if (docType === "tech_back") {
    lines.push(`VIN: \`${f.vin || ""}\``);
    lines.push(`Год выпуска авто: \`${f.car_year || ""}\``);
    lines.push(`Номер кузова/шасси: \`${f.body_number || ""}\``);
    lines.push(`Объём двигателя: \`${f.engine_volume || ""}\``);
    lines.push(`Тип топлива: ${f.fuel_type || "—"}`);
  }

  if (warnings.length) {
    lines.push("");
    lines.push("⚠️ Предупреждения:");
    for (const w of warnings) {
      lines.push(`• ${w}`);
    }
  }

  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(p, null, 2));
  lines.push("```");

  return lines.join("\n");
}

// ===== обработка одного документа =====
async function processSingleDoc({
  imageDataUrl,
  docType,
  phone,
  tg_id,
  carModel,
  carColor,
  previewOnly,
}) {
  const aiResult = await extractDocDataWithOpenAI(imageDataUrl, docType);

  const doc = {
    docType,
    result: aiResult,
    phone: phone || null,
    tg_id: tg_id || null,
    carModel: carModel || null,
    carColor: carColor || null,
  };

  if (!previewOnly) {
    const text = formatDocForOperators(doc);
    const targets = getTargets();
    for (const chatId of targets) {
      await sendTelegramMessage(chatId, text);
    }
  }

  return doc;
}

// ====== handler ======
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: "Method Not Allowed",
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    console.error("upload-doc: invalid JSON body", e);
    return { statusCode: 400, body: "Invalid JSON" };
  }

  let {
    images, // батч-формат: [{ image, docType, docTitle }, ...]
    image, // старый одиночный формат
    tg_id,
    phone,
    docType,
    docTitle,
    carColor,
    carModel,
    previewOnly, // если true — не слать операторам, только вернуть JSON
    telegram_update,
    meta,
  } = payload || {};

  // ==== если пришло из телеграм-бота: вытащить картинку и мету ====
  if (telegram_update) {
    console.log("upload-doc: got telegram_update, trying to extract image via Telegram API");

    const img = await getImageFromTelegramUpdate(telegram_update);
    if (!img || !img.base64) {
      console.error("upload-doc: telegram_update has no usable image");
      return { statusCode: 400, body: "No image in telegram_update" };
    }

    image = `data:${img.mime || "image/jpeg"};base64,${img.base64}`;

    const m = meta || {};

    tg_id =
      tg_id ||
      m.tg_id ||
      m.chat_id ||
      telegram_update.message?.chat?.id ||
      telegram_update.callback_query?.message?.chat?.id ||
      null;

    phone =
      phone ||
      m.phone ||
      m.phoneNormalized ||
      m.phone_normalized ||
      null;

    carColor =
      carColor ||
      m.carColor ||
      m.carColorLabel ||
      m.car_color_label ||
      m.car_color ||
      null;

    carModel =
      carModel ||
      m.carModel ||
      m.carModelLabel ||
      m.car_model_label ||
      m.car_model ||
      null;

    docType = docType || m.docType || m.doc_type || null;
    docTitle = docTitle || m.docTitle || m.doc_title || m.title || null;
  }

  // ===== БАТЧ: несколько документов =====
  if (Array.isArray(images) && images.length) {
    const results = [];
    for (const item of images) {
      if (!item || !item.image) continue;

      const imgData = item.image;
      const dType = item.docType || docType || "unknown";

      const doc = await processSingleDoc({
        imageDataUrl: imgData,
        docType: dType,
        phone,
        tg_id,
        carModel,
        carColor,
        previewOnly,
      });

      results.push(doc);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, mode: "batch", results }),
    };
  }

  // ===== ОДИНОЧНЫЙ документ =====
  if (!image) {
    return { statusCode: 400, body: "No image" };
  }

  const singleDoc = await processSingleDoc({
    imageDataUrl: image,
    docType: docType || "unknown",
    phone,
    tg_id,
    carModel,
    carColor,
    previewOnly,
  });

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, mode: "single", doc: singleDoc }),
  };
};
