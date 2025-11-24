// netlify/functions/upload-doc.js

const TELEGRAM_TOKEN = process.env.TG_BOT_TOKEN;
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || process.env.ADMIN_CHAT_ID || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const LOG_CHAT_ID = process.env.LOG_CHAT_ID || null;

const TELEGRAM_API = TELEGRAM_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_TOKEN}`
  : null;

if (!TELEGRAM_TOKEN) {
  console.error("TG_BOT_TOKEN is not set (upload-doc.js)");
}

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
      formData.append("photo", new Blob([buffer], { type: "image/jpeg" }), "document.jpg");
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

    const { image, tg_id, phone, docType } = payload || {};

    if (!image) {
      return { statusCode: 400, body: "No image" };
    }

    // image = dataURL ("data:image/jpeg;base64,...") или просто base64
    let base64 = image;
    const m = /^data:image\/\w+;base64,/.exec(base64);
    if (m) {
      base64 = base64.replace(m[0], "");
    }

    const buffer = Buffer.from(base64, "base64");

    const captionLines = [
      "📄 Новый документ от водителя ASR TAXI",
      phone ? `Телефон: ${phone}` : null,
      tg_id ? `Chat ID: ${tg_id}` : null,
      docType ? `Тип документа: ${docType}` : "Тип документа: document",
      "",
      "Фото прикреплено выше.",
    ].filter(Boolean);

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
