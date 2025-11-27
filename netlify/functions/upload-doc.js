// netlify/functions/upload-doc.js

// ====== ENV ======
let TELEGRAM_TOKEN = process.env.TG_BOT_TOKEN; // делаем let, чтобы можно было переключать по source
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || process.env.ADMIN_CHAT_ID || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const LOG_CHAT_ID = process.env.LOG_CHAT_ID || null;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;

let TELEGRAM_API = TELEGRAM_TOKEN
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

// ===== общая функция получения списка чатов-целей (для логов, если понадобится) =====
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

// ===== отправка ОДНОГО фото в Telegram =====
async function sendTelegramPhoto(chatId, imageDataUrl, caption = "") {
  if (!TELEGRAM_API || !TELEGRAM_TOKEN) {
    console.error("sendTelegramPhoto: no TELEGRAM_API / TELEGRAM_TOKEN");
    return;
  }

  if (!imageDataUrl || typeof imageDataUrl !== "string") {
    console.error("sendTelegramPhoto: no valid imageDataUrl");
    return;
  }

  const match = imageDataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!match) {
    console.error("sendTelegramPhoto: imageDataUrl is not a data:...;base64,... URL");
    return;
  }

  const mime = match[1] || "image/jpeg";
  const base64 = match[2];

  try {
    const buffer = Buffer.from(base64, "base64");
    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    if (caption) formData.append("caption", caption);
    const file = new Blob([buffer], { type: mime });
    formData.append("photo", file, "document.jpg");

    const res = await fetch(`${TELEGRAM_API}/sendPhoto`, {
      method: "POST",
      body: formData,
    });

    if (!res.ok) {
      const txt = await res.text();
      console.error("sendPhoto error:", res.status, txt);
    }
  } catch (e) {
    console.error("sendTelegramPhoto exception:", e);
  }
}

// ===== отправка АЛЬБОМА (mediaGroup) с несколькими фото =====
async function sendTelegramMediaGroup(chatId, docsWithImages) {
  if (!TELEGRAM_API || !TELEGRAM_TOKEN) {
    console.error("sendTelegramMediaGroup: no TELEGRAM_API / TELEGRAM_TOKEN");
    return;
  }

  const validDocs = (docsWithImages || []).filter(
    (d) => d && typeof d.image === "string" && d.image.startsWith("data:")
  );
  if (!validDocs.length) {
    console.error("sendTelegramMediaGroup: no valid images");
    return;
  }

  // Если всего одно фото — просто отправим как обычное фото
  if (validDocs.length === 1) {
    const only = validDocs[0];
    const caption = humanDocTitle(only.docType, only.docTitle);
    await sendTelegramPhoto(chatId, only.image, caption);
    return;
  }

  // Telegram требует 2–10 элементов в mediaGroup, поэтому делим по 10
  const chunks = [];
  for (let i = 0; i < validDocs.length; i += 10) {
    chunks.push(validDocs.slice(i, i + 10));
  }

  for (const chunk of chunks) {
    try {
      const formData = new FormData();
      formData.append("chat_id", String(chatId));

      const media = [];
      let idx = 0;

      for (const doc of chunk) {
        const match = doc.image.match(/^data:(.+);base64,(.+)$/);
        if (!match) continue;
        const mime = match[1] || "image/jpeg";
        const base64 = match[2];

        const buffer = Buffer.from(base64, "base64");
        const fileField = `file${idx}`;
        const file = new Blob([buffer], { type: mime });

        formData.append(fileField, file, `document_${idx}.jpg`);

        const mediaItem = {
          type: "photo",
          media: `attach://${fileField}`,
        };

        // По желанию можно подписывать каждое фото
        const caption = humanDocTitle(doc.docType, doc.docTitle);
        if (caption && idx === 0) {
          // Оставим caption только на первом фото, чтобы не засорять
          mediaItem.caption = caption;
        }

        media.push(mediaItem);
        idx++;
      }

      if (media.length < 2) {
        // вдруг не собралось 2 фото, тогда fallback
        if (media.length === 1 && chunk[0]) {
          await sendTelegramPhoto(
            chatId,
            chunk[0].image,
            humanDocTitle(chunk[0].docType, chunk[0].docTitle)
          );
        }
        continue;
      }

      formData.append("media", JSON.stringify(media));

      const res = await fetch(`${TELEGRAM_API}/sendMediaGroup`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const txt = await res.text();
        console.error("sendMediaGroup error:", res.status, txt);
      }
    } catch (e) {
      console.error("sendTelegramMediaGroup exception:", e);
    }
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
Ты читаешь ЛИЦЕВУЮ сторону водительского удостоверения Узбекистана.

На примере:
- В пятом пункте удостоверения есть строка вроде "AF4908227" — это СЕРИЯ+НОМЕР ВУ целиком.
  • По стандарту: 2 латинские буквы + 7 цифр (всего 9 символов).
- Рядом по пунктам написаны:
  1. Фамилия
  2. Имя
  3. Место рождения
  4a. Дата выдачи
  4b. Дата окончания
  4c. Место проживания
  4d. ПИНФЛ (личный номер)
  5. Серия
  8. Адрес
  9. Категории (например "A, B, C").

Нужно:
- "license_series" — ТОЛЬКО буквенная серия, например "AF".
  • Ровно 2 латинские буквы (A–Z) в верхнем регистре.
  • Если видишь больше двух подряд идущих букв — возьми первые 2.
  • Никогда не добавляй цифры, "UZ"/"UZB" и любые фоновые элементы.
- "license_number" — ТОЛЬКО цифровая часть номера из этой же строки, например "4908227".
  • Ровно 7 цифр.
  • Если серия и номер слиты в одну строку (например "AF4908227"):
    – "license_series" = "AF"
    – "license_number" = "4908227" (7 цифр).
- "license_full" — полный код серии+номера ВУ как на документе, например "AF4908227".
  • Формат: 2 буквы + 7 цифр (всего 9 символов), без пробелов.

- "driver_name" — ФИО полностью (1. Фамилия + 2. Имя + отчество, если есть).
- "birth_date" — дата рождения (если указана).
- "issued_date" — дата выдачи (поле 4a).
- "expiry_date" — дата окончания (поле 4b).
- "categories" — строка из пункта 9 (например "A, B, C").
- "issued_by" — кем выдан документ (если есть отдельное поле).
- "driver_pinfl" — ПИНФЛ водителя из пункта 4d.
  • По стандарту ПИНФЛ — это ровно 14 цифр без пробелов (например "31203780220112").
  • Если строка длиннее, но внутри есть подстрока из 14 подряд идущих цифр — возьми именно её.
  • Если 14 цифр надёжно выделить нельзя — верни null и опиши проблему в "warnings".

ВАЖНО:
- Серия/номер ВУ берутся только из строки с кодом типа "AF4908227".
- Серые большие цифры на фоне, водяные знаки, надписи "UZ", "UZB" и любые фоновые элементы игнорируй.
- ПИНФЛ водителя брать ТОЛЬКО из поля 4d. Никакие другие числа на документе не считать ПИНФЛ.
- Если серию или номер не видно — ставь null и опиши это в warnings.
`
      : docType === "tech_front"
      ? `
Ты читаешь ЛИЦЕВУЮ сторону техпаспорта (свидетельство о регистрации ТС Узбекистана).

На примере:
- Вверху слева указано "DAVLAT RAQAM BELGISI" / "STATE NUMBER PLATE" — здесь госномер, например "01Y984SB".
- Ниже:
  2. Марка/модель (например "COBALT").
  3. Цвет (например "OQ BELO DIMCHATIY").
  4. Владелец (ФИО).
  5. Адрес владельца.
  6. Дата выдачи техпаспорта.
  7. Отделение ГАИ.
  8. ПИНФЛ владельца (строка из цифр).

Нужно:
- "plate_number" — госномер из пункта 1 (например "01Y984SB") как строку без пробелов.
- "owner_name" — ФИО владельца из пункта 4.
- "owner_address" — адрес из пункта 5.
- "car_model_text" — марка/модель из пункта 2 (как написано на документе).
- "car_color_text" — цвет из пункта 3 (как написан).
- "pinfl" — ПИНФЛ владельца из пункта 8.
  • По стандарту ПИНФЛ — ровно 14 цифр.
  • Если строка длиннее, но внутри есть подстрока из 14 подряд идущих цифр — возьми именно её.
  • Если 14 цифр надёжно выделить нельзя — верни null и опиши это в warnings.

ВАЖНО:
- На ЛИЦЕВОЙ стороне обычно НЕТ серии и номера техпаспорта — их тут НЕ нужно искать.
- Не придумывай "tech_series" и "tech_number" для этой стороны.
- VIN тут обычно тоже нет. Не путай ПИНФЛ, госномер или номер владельца с VIN.
`
      : `
Ты читаешь ОБОРОТНУЮ сторону техпаспорта (свидетельство о регистрации ТС Узбекистана).

На примере:
- В верхней части есть поле "ISHLAB CHIQARILGAN YILI / YEAR OF MANUFACTURE" с годом (например "2022").
- Ниже:
  10. Тип ТС (например "YENGIL SEDAN").
  11. "KUZOV / SHASSI RAQAMI / VEHICLE IDENTIFICATION NUMBER" — это НОМЕР КУЗОВА (НЕ VIN, если нет отдельной подписи "VIN").
  14. Номер двигателя.
  15. Мощность двигателя.
  16. Тип топлива (например "BENZIN").
  19. Внизу часто есть дополнительная строка с отдельным кодом и датой.

Серия и номер техпаспорта:
- В верхнем левом углу оборота есть поле "Серия" с маленьким чёрным буквенно-цифровым кодом.
- Рядом с ним или чуть правее есть поле "№" — номер техпаспорта.
- По стандарту серия техпаспорта выглядит как "AAF4222435":
  • 3 латинские буквы + 7 цифр (всего 10 символов), без пробелов.

Нужно:
- "tech_series" — серия техпаспорта ЦЕЛИКОМ из поля "Серия".
  • Формат: 3 буквы + 7 цифр (10 символов), например "AAF4222435".
  • Если видишь похожий код, но один символ неразборчив — верни лучшее предположение и добавь предупреждение в "warnings" о проблеме с длиной/читаемостью.
- "tech_number" — номер техпаспорта из поля "№", если он выделен отдельно, иначе null.
- "tech_full" — серия+номер техпаспорта так, как они написаны на документе.
  • Если фактически серия и номер слиты в один код (как "AAF4222435") — можешь продублировать значение "tech_series".
- "car_year" — год выпуска авто из строки "ISHLAB CHIQARILGAN YILI / YEAR OF MANUFACTURE" (например 2022).
- "body_number" — строка из поля "KUZOV / SHASSI RAQAMI / VEHICLE IDENTIFICATION NUMBER".
- "engine_volume" — объём двигателя (если указан отдельно, например "1.5" или "1498").
- "fuel_type" — тип топлива (BENZIN, GAS, DIESEL и т.п.).
- "vin" — ЗАПОЛНЯЙ ТОЛЬКО если на документе есть отдельное поле, явно подписанное как "VIN".
  Если есть только "KUZOV / SHASSI RAQAMI" без слова VIN — это не vin, а "body_number".

ВАЖНО:
- Не путай номер кузова и ПИНФЛ с VIN.
- Большие серые цифры, серые надписи на фоне и водяные знаки — это декор, их нельзя использовать как серию, номер или VIN.
- Если какого-то поля точно не видно, ставь null и опиши сомнение в warnings.
`;

  const schema = `
Верни СТРОГО JSON, без пояснений и текста вокруг.

Формат:

{
  "doc_type": "vu_front" | "tech_front" | "tech_back",
  "fields": {
    // для vu_front:
    "license_series": "Только буквенная серия ВУ (2 латинские буквы, например \\"AF\\"), без цифр, без UZ/UZB, или null",
    "license_number": "Только цифры номера ВУ (7 цифр, например \\"4908227\\"), без букв и пробелов, или null",
    "license_full": "Полный код серии+номера ВУ (2 буквы + 7 цифр, например \\"AF4908227\\"), без пробелов, или null",
    "issued_date": "ГГГГ-MM-ДД или null",
    "expiry_date": "ГГГГ-MM-ДД или null",
    "categories": "строка, например \\"A, B, C\\" или null",
    "driver_name": "ФИО полностью или null",
    "birth_date": "ГГГГ-MM-ДД или null",
    "issued_by": "кем выдано или null",
    "driver_pinfl": "ПИНФЛ водителя из пункта 4d (ровно 14 цифр), без пробелов, или null",

    // для tech_front:
    "plate_number": "госномер, как на документе (например \\"01Y984SB\\") или null",
    "owner_name": "ФИО владельца или null",
    "owner_address": "адрес или null",
    "car_model_text": "марка/модель как написано или null",
    "car_color_text": "цвет как написан или null",
    "pinfl": "ПИНФЛ владельца (ровно 14 цифр), если есть, иначе null",

    // для tech_back:
    "tech_series": "серия техпаспорта (3 буквы + 7 цифр, например \\"AAF4222435\\"; НЕ госномер, НЕ PINFL, НЕ номер кузова) или null",
    "tech_number": "номер техпаспорта из поля \\"№\\" или null",
    "tech_full": "серия+номер техпаспорта как на документе или null",
    "car_year": "год выпуска числом, например 2015, или null",
    "body_number": "номер кузова/шасси из поля KUZOV/SHASSI RAQAMI или null",
    "engine_volume": "объём двигателя, например \\"1.5\\" или \\"1498\\", или null",
    "fuel_type": "тип топлива или null",
    "vin": "VIN только если на документе есть отдельное поле с подписью VIN, иначе null"
  },
  "warnings": [
    "краткие предупреждения, если есть неуверенность (например: \\"license_full имеет не 9 символов\\")"
  ]
}

Правила:
- Если информации нет или её не видно — ставь null и поясняй в warnings.
- Серия/номер ВУ и техпаспорта берутся только из явных полей с кодами и подписями \\"Серия\\", \\"№\\" и т.п.
- Для license_full старайся получить 9 символов (2 буквы + 7 цифр).
- Для tech_series/tech_full старайся получить 10 символов (3 буквы + 7 цифр).
- Для ПИНФЛ (driver_pinfl и pinfl) всегда должно быть ровно 14 цифр.
- Если длина поля отличается от стандарта, выбери наилучшую подстроку и явно опиши проблему в warnings.
- ПИНФЛ никогда не считать VIN.
- Номер кузова/шасси никогда не считать VIN.
- Год выпуска (car_year) брать только из строки про год выпуска. Если не уверен — null.
`;

  const promptText = `
Ты — аккуратный ассистент, который считает данные с официальных документов Узбекистана (водительское удостоверение и техпаспорт) и возвращает строго валидный JSON.

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
          {
            role: "system",
            content:
              "Ты аккуратно извлекаешь данные из документов Узбекистана и возвращаешь СТРОГО один JSON-объект без пояснений.",
          },
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

function humanDocTitle(docType, docTitleFromMeta) {
  if (docTitleFromMeta) return docTitleFromMeta;
  if (docType === "vu_front") return "Водительское удостоверение (лицевая)";
  if (docType === "tech_front") return "Техпаспорт (лицевая)";
  if (docType === "tech_back") return "Техпаспорт (оборотная)";
  return "Документ";
}

function formatSummaryForOperators(docs, commonMeta = {}) {
  const { phone, tg_id, carModel, carColor } = commonMeta;

  // Попробуем вытащить год авто из tech_back, если есть
  let carYear = null;
  for (const d of docs) {
    if (d.docType === "tech_back" && d.result && d.result.parsed) {
      const f = d.result.parsed.fields || {};
      if (f.car_year) {
        carYear = f.car_year;
        break;
      }
    }
  }

  const headerParts = [];
  if (phone) headerParts.push(`📞 Телефон: \`${phone}\``);
  if (tg_id) headerParts.push(`💬 TG ID: \`${tg_id}\``);
  if (carModel || carColor || carYear) {
    const carLine =
      `🚗 Авто: ${carModel || "—"} / ${carColor || "—"}${carYear ? ` / ${carYear} г.` : ""}`;
    headerParts.push(carLine);
  }

  const lines = [];
  lines.push("*Новая заявка на регистрацию (документы водителя и авто)*");
  if (headerParts.length) {
    lines.push(headerParts.join("\n"));
  }

  for (const doc of docs) {
    const p = (doc.result && doc.result.parsed) || {};
    const f = p.fields || {};
    const warnings = p.warnings || [];

    lines.push("");
    lines.push(`*${humanDocTitle(doc.docType, doc.docTitle)}*`);

    if (doc.docType === "vu_front") {
      lines.push(`Серия ВУ: \`${f.license_series || ""}\``);
      lines.push(`Номер ВУ: \`${f.license_number || ""}\``);
      lines.push(`Полностью: \`${f.license_full || ""}\``);
      lines.push(`ФИО: ${f.driver_name || "—"}`);
      lines.push(`Дата рождения: \`${f.birth_date || ""}\``);
      lines.push(`ПИНФЛ водителя: \`${f.driver_pinfl || ""}\``);
      lines.push(`Категории: ${f.categories || "—"}`);
      lines.push(`Дата выдачи: \`${f.issued_date || ""}\``);
      lines.push(`Окончание срока: \`${f.expiry_date || ""}\``);
      lines.push(`Кем выдано: ${f.issued_by || "—"}`);
    } else if (doc.docType === "tech_front") {
      lines.push(`Госномер: \`${f.plate_number || ""}\``);
      lines.push(`Владелец: ${f.owner_name || "—"}`);
      lines.push(`Адрес: ${f.owner_address || "—"}`);
      lines.push(`Марка/модель (док): ${f.car_model_text || "—"}`);
      lines.push(`Цвет (док): ${f.car_color_text || "—"}`);
      lines.push(`ПИНФЛ владельца: \`${f.pinfl || ""}\``);
    } else if (doc.docType === "tech_back") {
      lines.push(`Серия техпаспорта: \`${f.tech_series || ""}\``);
      lines.push(`Номер техпаспорта: \`${f.tech_number || ""}\``);
      lines.push(`Полностью: \`${f.tech_full || ""}\``);
      lines.push(`Год выпуска авто: \`${f.car_year || ""}\``);
      lines.push(`Номер кузова/шасси: \`${f.body_number || ""}\``);
      lines.push(`Объём двигателя: \`${f.engine_volume || ""}\``);
      lines.push(`Тип топлива: ${f.fuel_type || "—"}`);
      lines.push(`VIN: \`${f.vin || ""}\``);
    } else {
      // unknown
      lines.push("Данные не распознаны или тип документа неизвестен.");
    }

    if (Array.isArray(warnings) && warnings.length) {
      lines.push("");
      lines.push("⚠️ Предупреждения:");
      for (const w of warnings) {
        lines.push(`• ${w}`);
      }
    }
  }

  return lines.join("\n");
}

// ===== обработка одного документа (без отправки в Telegram) =====
async function processSingleDoc({
  imageDataUrl,
  docType,
  docTitle,
  phone,
  tg_id,
  carModel,
  carColor,
}) {
  const aiResult = await extractDocDataWithOpenAI(imageDataUrl, docType);

  const doc = {
    docType,
    docTitle: docTitle || null,
    image: imageDataUrl || null,
    result: aiResult,
    phone: phone || null,
    tg_id: tg_id || null,
    carModel: carModel || null,
    carColor: carColor || null,
  };

  return doc;
}

// ===== отправка пачки документов и общей информации операторам =====
async function notifyOperatorsAboutDocs(docs, commonMeta, { sendPhotos = true } = {}) {
  if (!ADMIN_CHAT_IDS.length) {
    console.log("notifyOperatorsAboutDocs: no ADMIN_CHAT_IDS");
    return;
  }

  const summaryText = formatSummaryForOperators(docs, commonMeta);

  for (const chatId of ADMIN_CHAT_IDS) {
    // 1) Пачка документов: все фото одним альбомом (как раньше)
    if (sendPhotos) {
      const docsWithImages = docs.filter((d) => d && d.image);
      await sendTelegramMediaGroup(chatId, docsWithImages);
    }

    // 2) Отдельным сообщением — вся собранная информация
    await sendTelegramMessage(chatId, summaryText);
  }

  // Логи (без JSON оператору)
  if (LOG_CHAT_ID) {
    const logPayload = {
      meta: commonMeta,
      docs: docs.map((d) => ({
        docType: d.docType,
        docTitle: d.docTitle,
        parsed: d.result?.parsed || null,
        error: d.result?.ok ? null : d.result?.error || null,
      })),
    };
    try {
      await sendTelegramMessage(
        LOG_CHAT_ID,
        "Лог распознавания документов (JSON скрыт для операторов)."
      );
      // Если захочешь видеть полный JSON в отдельном чате — можно раскомментировать:
      // await sendTelegramMessage(LOG_CHAT_ID, "```json\n" + JSON.stringify(logPayload, null, 2) + "\n```");
    } catch (e) {
      console.error("notifyOperatorsAboutDocs: log send error", e);
    }
  }
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

  // --- ВАЖНО: выбираем токен в зависимости от source (hunter-бот или обычный) ---
  const source = payload?.source || payload?.meta?.source || null;

  if (source === "telegram_hunter_bot") {
    TELEGRAM_TOKEN =
      process.env.TG_HUNTER_BOT_TOKEN || process.env.TG_BOT_TOKEN || null;
  } else {
    TELEGRAM_TOKEN = process.env.TG_BOT_TOKEN || null;
  }

  TELEGRAM_API = TELEGRAM_TOKEN
    ? `https://api.telegram.org/bot${TELEGRAM_TOKEN}`
    : null;

  if (!TELEGRAM_TOKEN) {
    console.error("upload-doc: TELEGRAM_TOKEN is not set for source:", source);
  }
  // -------------------------------------------------------------------------------

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
    console.log(
      "upload-doc: got telegram_update, trying to extract image via Telegram API"
    );

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

  const commonMeta = {
    phone,
    tg_id,
    carModel,
    carColor,
  };

  // ===== БАТЧ: несколько документов =====
  if (Array.isArray(images) && images.length) {
    const results = [];
    for (const item of images) {
      if (!item || !item.image) continue;

      const imgData = item.image;
      const dType = item.docType || docType || "unknown";
      const dTitle = item.docTitle || docTitle || null;

      const doc = await processSingleDoc({
        imageDataUrl: imgData,
        docType: dType,
        docTitle: dTitle,
        phone,
        tg_id,
        carModel,
        carColor,
      });

      // сохраняем исходную картинку
      doc.image = imgData;

      results.push(doc);
    }

    // Только после того, как водитель закончил регистрацию:
    if (!previewOnly) {
      await notifyOperatorsAboutDocs(results, commonMeta, { sendPhotos: true });
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
    docTitle: docTitle || null,
    phone,
    tg_id,
    carModel,
    carColor,
  });

  singleDoc.image = image;

  if (!previewOnly) {
    await notifyOperatorsAboutDocs([singleDoc], commonMeta, { sendPhotos: true });
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, mode: "single", doc: singleDoc }),
  };
};
