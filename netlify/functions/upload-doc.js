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

// ===== общая функция получения списка чатов-целей =====
function getTargets() {
  const targets = new Set();
  for (const id of ADMIN_CHAT_IDS) {
    if (id) targets.add(id);
  }
  if (LOG_CHAT_ID) {
    targets.add(LOG_CHAT_ID);
  }
  return Array.from(targets);
}

/**
 * Отправка ОДНОГО фото (старый режим, на всякий случай)
 */
async function sendPhotoToTelegramTargets(buffer, caption) {
  if (!TELEGRAM_API) return;

  const targets = getTargets();

  for (const chatId of targets) {
    try {
      const formData = new FormData();
      formData.append("chat_id", chatId);
      formData.append(
        "photo",
        new Blob([buffer], { type: "image/jpeg" }),
        "document.jpg"
      );
      if (caption) {
        formData.append("caption", caption);
      }

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
 * Отправка НЕСКОЛЬКИХ фото одним альбомом (sendMediaGroup)
 * docs: [{ buffer, caption }, ...]
 */
async function sendDocsBatchToTelegramTargets(docs) {
  if (!TELEGRAM_API) return;
  if (!docs || !docs.length) return;

  const targets = getTargets();

  for (const chatId of targets) {
    try {
      const formData = new FormData();
      formData.append("chat_id", chatId);

      const media = docs.map((doc, index) => {
        const attachName = `file${index}`;
        formData.append(
          attachName,
          new Blob([doc.buffer], { type: "image/jpeg" }),
          `document_${index + 1}.jpg`
        );
        return {
          type: "photo",
          media: `attach://${attachName}`,
          caption: doc.caption || "",
        };
      });

      formData.append("media", JSON.stringify(media));

      const res = await fetch(`${TELEGRAM_API}/sendMediaGroup`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error("sendMediaGroup error:", res.status, errText);
      }
    } catch (e) {
      console.error("sendDocsBatchToTelegramTargets exception:", e);
    }
  }
}

/**
 * Отправка текстового сообщения операторам
 */
async function sendTextToTelegramTargets(text) {
  if (!TELEGRAM_API || !text) return;

  const targets = getTargets();

  for (const chatId of targets) {
    try {
      const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error("sendMessage error:", res.status, errText);
      }
    } catch (e) {
      console.error("sendTextToTelegramTargets exception:", e);
    }
  }
}

/**
 * Вызов OpenAI Vision
 * imageDataUrl — строка вида data:image/jpeg;base64,....
 * docType — "vu_front" | "tech_front" | "tech_back"
 */
async function extractDocDataWithOpenAI(imageDataUrl, docType) {
  if (!OPENAI_API_KEY) return null;
  if (!imageDataUrl) return null;

  try {
    const systemPrompt = `
Ты помощник таксопарка ASR TAXI.
Твоя задача — аккуратно СЧИТАТЬ данные с водительских документов Узбекистана.

ВАЖНО:
- НЕ переводить текст между кириллицей и латиницей.
- НЕ менять регистр, написание слов, пробелы, дефисы и формат дат.
- Просто переписывай символы ровно так, как они напечатаны на документе.
- ТИП документа и СТОРОНА будут описаны в инструкции пользователя (например: "vu_front", "tech_front", "tech_back").
- Строго следуй этому описанию и НИКОГДА не придумывай данные, которых нет на изображении.

Отвечай СТРОГО одним JSON-объектом без комментариев и текста вокруг.
Если какое-то поле не видно или не читается, возвращай для него пустую строку.
`;

    let userInstruction = `
На изображении один документ водителя.
Аккуратно прочитай все видимые поля и верни JSON.
Переписывай текст 1-в-1 как на документе, не переводя язык и не меняя формат.
`;

    // ВУ — лицевая
    if (docType === "vu_front") {
      userInstruction = `
На изображении ВОДИТЕЛЬСКОЕ УДОСТОВЕРЕНИЕ УЗБЕКИСТАНА (лицевая сторона).

Ориентиры:
- В левом нижнем углу фото водителя.
- Справа от фото вертикальный список пунктов 1., 2., 3., 4a., 4b., 4c., 4d., 5. и т.д.
- Под номером 5 находится СЕРИЯ И НОМЕР водительского удостоверения (например: "AF1881855").

Нужно считать ТОЛЬКО следующие поля с документа (из основной тёмной/чёрной разметки, НЕ из серых служебных надписей и фоновых номеров):

1. Фамилия — текст справа от "1."
2. Имя — текст справа от "2."
4a. дата выдачи — дата справа от "4a."
4b. дата истечения срока — дата справа от "4b."
4d. ПИНФЛ — длинный цифровой номер справа от "4d."
5. Серия и номер В/У — буквы + цифры в строке справа от "5." (например "AF1881855").
   НЕ путать с серыми блеклыми номерами на фоне или по краям документа.

Игнорируй:
- любые серые/бледные номера в нижней части документа;
- watermark-номера, фоновую сетку, случайные цифры на полях.

Верни JSON строго в формате:

{
  "doc_type": "driver_license_front",
  "last_name": "",
  "first_name": "",
  "issue_date": "",
  "valid_to": "",
  "pinfl": "",
  "licence_series_number": ""
}

Где:
- "issue_date" — дата выдачи (4a) в том же формате, как напечатано (например "21.09.2020").
- "valid_to" — дата истечения срока (4b), без изменения формата.
- "pinfl" — номер из поля 4d.
- "licence_series_number" — ТОЛЬКО строка из поля 5. (например "AF1881855"), без лишних пробелов и не из серых фонов.

Все значения пиши ровно так, как на документе.
Если какое-то поле не видно/обрезано — оставь пустую строку.
НЕ добавляй никаких других полей.
`;
    }
    // Техпаспорт — лицевая
    else if (docType === "tech_front") {
      userInstruction = `
На изображении СВИДЕТЕЛЬСТВО О РЕГИСТРАЦИИ АВТОТРАНСПОРТНОГО СРЕДСТВА УЗБЕКИСТАНА (ЛИЦЕВАЯ СТОРОНА).

Интересуют ТОЛЬКО строки с нумерацией 1, 2, 3 слева от текста:

1. Гос номер (DAVLAT RAAQAM BELGISI / STATE NUMBER PLATE)
2. Марка/модель (RUSUMI / MODELI)
3. Цвет (RANGI / VEHICLE COLOUR)

Нужно считать:

- 1. Гос номер
- 2. Марку / модель
- 3. Цвет

Верни JSON строго в формате:

{
  "doc_type": "tech_passport_front",
  "plate_number": "",
  "brand": "",
  "color": ""
}

Где:
- "plate_number" — значение из строки 1, переписать 1-в-1 (буквы, цифры, пробелы).
- "brand" — текст из строки 2 (марка/модель), если указаны и марка, и модель — переписать всё.
- "color" — текст из строки 3.

Игнорируй:
- все колонки справа с перечислением областей;
- водяные знаки и серые номера;
- любую надпись, не относящуюся к строкам 1, 2, 3.

Если поле не видно — оставь пустую строку.
НЕ добавляй других полей.
`;
    }
    // Техпаспорт — оборотная
    else if (docType === "tech_back") {
      userInstruction = `
На изображении СВИДЕТЕЛЬСТВО О РЕГИСТРАЦИИ АВТОТРАНСПОРТНОГО СРЕДСТВА УЗБЕКИСТАНА (ОБОРОТНАЯ СТОРОНА).

Нужны ТОЛЬКО следующие данные:

9. Год выпуска (ISHLAB CHIQARILGAN YILI / YEAR OF MANUFACTURE)
11. Номер кузова/шасси (KUZOV / SHASSI RAAQAMI / VEHICLE IDENTIFICATION NUMBER)
Серия техпаспорта — буквенно-цифровой код в верхней части документа (например "AAG5304177"), который относится к документу целиком, а не к кузову или двигателю.

Ориентиры:
- Поле 9 — обычно четырёхзначный год (например "2023") в строке с номером "9." слева.
- Поле 11 — длинная строка с буквами/цифрами рядом с номером строки "11.".
- Серия техпаспорта — отдельная строка/надпись с буквами и цифрами без "KG" и без пробелов, часто в правом верхнем углу, не помечена номером строки (НЕ поле 11).

Верни JSON строго в формате:

{
  "doc_type": "tech_passport_back",
  "year": "",
  "body_number": "",
  "sts_series": ""
}

Где:
- "year" — значение из строки 9 (только год выпуска, например "2023").
- "body_number" — значение из строки 11 (VIN/номер кузова).
- "sts_series" — буквенно-цифровая серия самого техпаспорта (например "AAG5304177"), без пробелов и единиц измерения.

Игнорируй:
- массу, мощность, топливо, количество мест и другие поля;
- любые серые/фоновые номера и водяные знаки;
- числовые значения с "KG", "kW" и т.п.

Если поле не видно или не читается — верни для него пустую строку.
НЕ придумывай значения и не добавляй других полей.
`;
    }

    const body = {
      model: "gpt-4o",
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userInstruction },
            {
              type: "image_url",
              image_url: { url: imageDataUrl },
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
      console.log("Recognized doc data:", parsed);
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

/**
 * Сборка финального текста для операторов ТОЛЬКО с нужными полями
 */
function buildOperatorSummary({
  phone,
  tg_id,
  carColor,
  carModel,
  vuData,
  techFrontData,
  techBackData,
}) {
  const vu = vuData || {};
  const tf = techFrontData || {};
  const tb = techBackData || {};

  const lines = [
    "📄 Набор документов от водителя ASR TAXI",
    phone ? `Телефон: ${phone}` : "Телефон:",
    tg_id ? `Chat ID: ${tg_id}` : "Chat ID:",
    `Цвет авто (из формы): ${carColor || ""}`,
    `Модель авто (из формы): ${carModel || ""}`,
    "",
    "Фамилия",
    vu.last_name || "",
    "",
    "Имя",
    vu.first_name || "",
    "",
    "Дата выдачи В/У",
    vu.issue_date || "",
    "",
    "Дата истечения В/У",
    vu.valid_to || "",
    "",
    "ПИНФЛ",
    vu.pinfl || "",
    "",
    "Серия В/У",
    vu.licence_series_number || "",
    "",
    "Авто:",
    "",
    "Гос номер",
    tf.plate_number || "",
    "",
    "Марка",
    tf.brand || "",
    "",
    "Цвет",
    tf.color || "",
    "",
    "Год выпуска авто",
    tb.year || "",
    "",
    "Номер кузова",
    tb.body_number || "",
    "",
    "Серия тех паспорта",
    tb.sts_series || "",
  ];

  return lines.join("\n");
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

    const {
      images,   // батч-формат: [{ image, docType, docTitle }, ...]
      image,    // старый одиночный формат
      tg_id,
      phone,
      docType,
      docTitle,
      carColor,
      carModel,
      previewOnly, // НОВОЕ: если true — не слать операторам, только вернуть JSON
    } = payload || {};

    // ===== БАТЧ: несколько документов =====
    if (Array.isArray(images) && images.length) {
      console.log("upload-doc: batch mode, images.length =", images.length);

      const docsForSend = [];

      let vuData = null;        // В/У лицевая (vu_front)
      let techFrontData = null; // техпаспорт лицевая (tech_front)
      let techBackData = null;  // техпаспорт оборот (tech_back)

      for (let i = 0; i < images.length; i++) {
        const item = images[i] || {};
        if (!item.image) continue;

        let base64 = item.image;
        let imageDataUrlForVision = item.image;

        const m = /^data:image\/\w+;base64,/.exec(base64);
        if (m) {
          base64 = base64.replace(m[0], "");
        } else {
          imageDataUrlForVision = `data:image/jpeg;base64,${base64}`;
        }

        const buffer = Buffer.from(base64, "base64");

        try {
          const docData = await extractDocDataWithOpenAI(
            imageDataUrlForVision,
            item.docType
          );
          if (docData) {
            if (item.docType === "vu_front") {
              vuData = docData;
            } else if (item.docType === "tech_front") {
              techFrontData = docData;
            } else if (item.docType === "tech_back") {
              techBackData = docData;
            }
          }
        } catch (e) {
          console.error("Doc OCR global error (batch item):", e);
        }

        const shortCaption =
          item.docTitle || `Документ ${i + 1}/${images.length}`;

        docsForSend.push({
          buffer,
          caption: shortCaption,
        });
      }

      // Если previewOnly НЕ указан или false — как раньше шлём операторам
      if (!previewOnly) {
        await sendDocsBatchToTelegramTargets(docsForSend);

        const fullText = buildOperatorSummary({
          phone,
          tg_id,
          carColor,
          carModel,
          vuData,
          techFrontData,
          techBackData,
        });

        await sendTextToTelegramTargets(fullText);
      }

      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          mode: "batch",
          vuData,
          techFrontData,
          techBackData,
        }),
      };
    }

    // ===== ОДИНОЧНЫЙ документ (старый режим) =====
    if (!image) {
      return { statusCode: 400, body: "No image" };
    }

    console.log("upload-doc: single mode");

    let base64 = image;
    let imageDataUrlForVision = image;

    const m = /^data:image\/\w+;base64,/.exec(base64);
    if (m) {
      base64 = base64.replace(m[0], "");
    } else {
      imageDataUrlForVision = `data:image/jpeg;base64,${base64}`;
    }

    const buffer = Buffer.from(base64, "base64");

    let vuData = null;
    let techFrontData = null;
    let techBackData = null;

    try {
      const docData = await extractDocDataWithOpenAI(
        imageDataUrlForVision,
        docType
      );
      if (docData) {
        if (docType === "vu_front") {
          vuData = docData;
        } else if (docType === "tech_front") {
          techFrontData = docData;
        } else if (docType === "tech_back") {
          techBackData = docData;
        }
      }
    } catch (e) {
      console.error("Doc OCR global error (single):", e);
    }

    const summaryText = buildOperatorSummary({
      phone,
      tg_id,
      carColor,
      carModel,
      vuData,
      techFrontData,
      techBackData,
    });

    await sendPhotoToTelegramTargets(buffer, summaryText);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        mode: "single",
        vuData,
        techFrontData,
        techBackData,
      }),
    };
  } catch (err) {
    console.error("upload-doc handler error:", err);
    return { statusCode: 500, body: "Internal error" };
  }
};
