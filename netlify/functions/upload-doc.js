// netlify/functions/upload-doc.js

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

/**
 * Отправка фото во все целевые чаты (операторы + лог-канал)
 */
async function sendPhotoToTelegramTargets(buffer, caption) {
  if (!TELEGRAM_API) return;

  const targets = new Set();

  // всем операторам
  for (const id of ADMIN_CHAT_IDS) {
    if (id) targets.add(id);
  }
  // и в лог-канал, если указан
  if (LOG_CHAT_ID) {
    targets.add(LOG_CHAT_ID);
  }

  for (const chatId of targets) {
    try {
      const formData = new FormData();
      formData.append("chat_id", chatId);
      formData.append(
        "photo",
        new Blob([buffer], { type: "image/jpeg" }),
        "document.jpg"
      );
      formData.append("caption", caption);

      const res = await fetch(`${TELEGRAM_API}/sendPhoto`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error("sendPhoto error:", res.status, errText);
      }
    } catch (e) {
      console.error("sendPhoto exception:", e);
    }
  }
}

/**
 * Форматирование распознанных данных в удобный блок для оператора
 */
function formatRecognizedData(docData) {
  if (!docData || typeof docData !== "object") return "";

  const LABELS = {
    // В/У
    last_name: "Фамилия",
    first_name: "Имя",
    middle_name: "Отчество",
    phone: "Телефон",
    pinfl: "ПИНФЛ",
    driving_experience_from: "Водительский стаж с",
    licence_series_number: "Серия и номер ВУ",
    issue_date: "Дата выдачи ВУ",
    valid_to: "Действует до",

    // Техпаспорт
    brand: "Марка",
    model: "Модель",
    color: "Цвет",
    year: "Год",
    plate_number: "Гос. номер",
    vin: "VIN",
    body_number: "Номер кузова",
    sts_number: "СТС",

    // общее
    doc_type: "Тип документа (распознанный)",
  };

  const lines = [];

  for (const [key, value] of Object.entries(docData)) {
    if (!value) continue;
    const label = LABELS[key] || key;
    lines.push(`${label}\n${value}`);
  }

  return lines.join("\n\n");
}

/**
 * Вызов OpenAI для распознавания документа по картинке
 * imageDataUrl — строка вида data:image/jpeg;base64,....
 */
async function extractDocDataWithOpenAI(imageDataUrl, docType) {
  if (!OPENAI_API_KEY) return null;
  if (!imageDataUrl) return null;

  try {
    const systemPrompt = `
Ты помощник таксопарка ASR TAXI.
Твоя задача — аккуратно считать данные с водительских документов Узбекистана.
Отвечай СТРОГО одним JSON-объектом без комментариев и текста вокруг.
Если какое-то поле не видно или не читается, возвращай для него пустую строку.
Используй кириллицу так же, как на документе.`;

    let userInstruction = `
На изображении один документ водителя.
Аккуратно прочитай все видимые поля и верни JSON.`;

    // Небольшая специализация по типу документа
    if (docType === "vu_front") {
      userInstruction = `
На изображении ВОДИТЕЛЬСКОЕ УДОСТОВЕРЕНИЕ (лицевая сторона).
Верни JSON строго в формате:

{
  "doc_type": "driver_license_front",
  "last_name": "",
  "first_name": "",
  "middle_name": "",
  "phone": "",
  "pinfl": "",
  "driving_experience_from": "",
  "licence_series_number": "",
  "issue_date": "",
  "valid_to": ""
}

Заполни поля по возможности. Если поле невозможно прочитать или его нет, оставь пустую строку.`;
    } else if (docType === "tech_front" || docType === "tech_back") {
      userInstruction = `
На изображении ТЕХПАСПОРТ/СВИДЕТЕЛЬСТВО О РЕГИСТРАЦИИ АВТО.
Верни JSON строго в формате:

{
  "doc_type": "tech_passport",
  "brand": "",
  "model": "",
  "color": "",
  "year": "",
  "plate_number": "",
  "vin": "",
  "body_number": "",
  "sts_number": ""
}

Заполни максимум данных, которые видишь на этой стороне документа. Остальные поля оставь пустыми строками.`;
    }

    const body = {
      model: "gpt-4o",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userInstruction },
            {
              type: "image_url",
              image_url: {
                url: imageDataUrl,
              },
            },
          ],
        },
      ],
    };

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("OpenAI vision error:", resp.status, errText);
      return null;
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    try {
      const parsed = JSON.parse(content);
      return parsed;
    } catch (e) {
      console.error("OpenAI vision JSON parse error:", e, content);
      return null;
    }
  } catch (e) {
    console.error("extractDocDataWithOpenAI exception:", e);
    return null;
  }
}

exports.handler = async (event) => {
  console.log("=== upload-doc invoked ===");

  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200 };
    }

    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method not allowed" };
    }

    let payload;
    try {
      payload = JSON.parse(event.body || "{}");
    } catch (e) {
      console.error("Bad JSON in upload-doc:", e);
      return { statusCode: 400, body: "Bad JSON" };
    }

    // phone сюда теперь прилетает из инпута на странице (если есть),
    // либо из query-параметра, если пользователь инпут не менял
    const { image, tg_id, phone, docType, docTitle, carColor } = payload || {};

    if (!image) {
      return { statusCode: 400, body: "No image" };
    }

    // image — либо dataURL ("data:image/jpeg;base64,..."), либо чистый base64
    let base64 = image;
    let imageDataUrlForVision = image;

    const m = /^data:image\/\w+;base64,/.exec(base64);
    if (m) {
      // если уже dataURL — режем префикс для буфера, но оставляем полную строку для OpenAI
      base64 = base64.replace(m[0], "");
    } else {
      // если пришёл просто base64 — собираем dataURL для OpenAI
      imageDataUrlForVision = `data:image/jpeg;base64,${base64}`;
    }

    const buffer = Buffer.from(base64, "base64");

    // === Распознавание документа через OpenAI (если есть ключ) ===
    let recognizedBlock = "";
    try {
      const docData = await extractDocDataWithOpenAI(
        imageDataUrlForVision,
        docType
      );
      if (docData) {
        const formatted = formatRecognizedData(docData);
        if (formatted) {
          recognizedBlock = formatted;
        }
      }
    } catch (e) {
      console.error("Doc OCR global error:", e);
    }

    // === Формируем подпись к фото для операторов ===
    const captionLines = [
      "📄 Новый документ от водителя ASR TAXI",
      phone ? `Телефон (из формы/ссылки): ${phone}` : null,
      tg_id ? `Chat ID: ${tg_id}` : null,
      docTitle ? `Документ: ${docTitle}` : null,
      docType ? `Тип документа (из формы): ${docType}` : "Тип документа: document",
      carColor ? `Цвет авто (из формы): ${carColor}` : null,
      "",
      "Фото прикреплено выше.",
    ].filter(Boolean);

    if (recognizedBlock) {
      captionLines.push("");
      captionLines.push("Распознанные данные с документа:");
      captionLines.push(recognizedBlock);
    }

    const caption = captionLines.join("\n");

    await sendPhotoToTelegramTargets(buffer, caption);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true }),
    };
  } catch (err) {
    console.error("upload-doc handler error:", err);
    return { statusCode: 500, body: "Internal error" };
  }
};
