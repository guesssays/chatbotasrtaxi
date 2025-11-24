// netlify/functions/telegram-asr-bot.js

const TELEGRAM_TOKEN = process.env.TG_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || null;

const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || process.env.ADMIN_CHAT_ID || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const LOG_CHAT_ID = process.env.LOG_CHAT_ID || null;

// ====== НАСТРОЙКИ ЯНДЕКС ФЛИТ API (СТАВИМ СВОИ ДАННЫЕ В .env) ======
// Пример .env:
// FLEET_API_URL=https://fleet-api.taxi.yandex.net
// FLEET_CLIENT_ID=taxi/park/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
// FLEET_PARK_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
// FLEET_API_KEY=QBzdZ... (секретный ключ)
const FLEET_API_URL = process.env.FLEET_API_URL || "https://fleet-api.taxi.yandex.net";
const FLEET_CLIENT_ID = process.env.FLEET_CLIENT_ID || ""; // X-Client-ID (taxi/park/...)
const FLEET_API_KEY = process.env.FLEET_API_KEY || "";     // X-API-Key
const FLEET_PARK_ID = process.env.FLEET_PARK_ID || "";     // id парка (без taxi/park/)

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

if (!TELEGRAM_TOKEN) console.error("TG_BOT_TOKEN is not set");

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ TELEGRAM =====

async function sendTelegramMessage(chatId, text, replyMarkup) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Telegram sendMessage error:", res.status, errText);
  }
}

// ===== ПРОВЕРКА ВОДИТЕЛЯ В ЯНДЕКС ФЛИТ =====

function normalizePhone(raw) {
  if (!raw) return "";
  // убираем все, кроме цифр
  let digits = raw.replace(/[^\d]/g, "");
  // если начинается на 8 и длина 11 → превращаем в +7 ...
  if (digits.length === 11 && digits[0] === "8") {
    digits = "7" + digits.slice(1);
  }
  if (digits.length === 11 && digits[0] === "7") {
    return `+${digits}`;
  }
  // если уже с плюсом +998... и т.п., обычно Telegram так и даёт
  if (raw.startsWith("+")) return raw;
  return `+${digits}`;
}

async function checkDriverInFleet(phone) {
  if (!FLEET_API_KEY || !FLEET_PARK_ID || !FLEET_CLIENT_ID) {
    console.warn(
      "FLEET_API_KEY, FLEET_CLIENT_ID или FLEET_PARK_ID не заданы — считаем, что водителя нет в базе"
    );
    return { exists: false, raw: null };
  }

  const normalized = normalizePhone(phone);

  try {
    const res = await fetch(`${FLEET_API_URL}/v1/parks/driver-profiles/list`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-ID": FLEET_CLIENT_ID, // taxi/park/...
        "X-API-Key": FLEET_API_KEY,
      },
      body: JSON.stringify({
        query: {
          park: { id: FLEET_PARK_ID }, // только id парка
          driver_profile: {
            phone: { value: normalized },
          },
        },
        limit: 1,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("Fleet API error:", res.status, errText);
      return { exists: false, error: "fleet_error" };
    }

    const data = await res.json();
    const exists =
      Array.isArray(data.driver_profiles) && data.driver_profiles.length > 0;

    return { exists, raw: data };
  } catch (e) {
    console.error("Fleet API exception:", e);
    return { exists: false, error: "fleet_exception" };
  }
}

// ====== ОСНОВНОЙ ХЭНДЛЕР NETLIFY ======

exports.handler = async (event) => {
  console.log("=== telegram-asr-bot (registration) invoked ===");
  console.log("Method:", event.httpMethod);

  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200 };
    }

    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method not allowed" };
    }

    // проверка секрета вебхука (мягкая)
    if (WEBHOOK_SECRET) {
      const incoming =
        event.headers["x-telegram-bot-api-secret-token"] ||
        event.headers["X-Telegram-Bot-Api-Secret-Token"];
      if (!incoming) {
        console.warn("Telegram request без secret_token header");
      } else if (incoming !== WEBHOOK_SECRET) {
        console.warn("Bad webhook secret:", incoming);
        return { statusCode: 403, body: "Forbidden" };
      }
    }

    let update;
    try {
      update = JSON.parse(event.body || "{}");
    } catch (e) {
      console.error("Bad JSON from Telegram:", e);
      return { statusCode: 400, body: "Bad request" };
    }

    console.log("Update:", JSON.stringify(update));

    // ===== CALLBACK КНОПКИ =====
    if (update.callback_query) {
      const cb = update.callback_query;
      const data = cb.data || "";
      const chatId = cb.message?.chat?.id;

      console.log("Callback data:", data, "from chat", chatId);

      if (data === "start_registration" && chatId) {
        // отправляем клавиатуру с отправкой контакта
        const replyMarkup = {
          keyboard: [
            [{ text: "📱 Отправить номер телефона", request_contact: true }],
          ],
          resize_keyboard: true,
          one_time_keyboard: true,
        };

        await sendTelegramMessage(
          chatId,
          "Чтобы продолжить, нажмите кнопку ниже и отправьте номер, который привязан к вашему аккаунту Telegram.",
          replyMarkup
        );
      }

      // обязательно ответить на callback, чтобы Telegram убрал "часики"
      await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: cb.id }),
      });

      return { statusCode: 200, body: "Callback handled" };
    }

    // ===== СООБЩЕНИЯ =====
    const msg = update.message || update.edited_message;
    if (!msg) {
      return { statusCode: 200, body: "No message" };
    }

    const chatId = msg.chat?.id;
    const chatType = msg.chat?.type;
    if (!chatId || chatType !== "private") {
      return { statusCode: 200, body: "Ignored" };
    }

    const text = msg.text || msg.caption || "";
    const hasContact = !!msg.contact;

    // 1) /start — показываем кнопку "Пройти регистрацию"
    if (text === "/start") {
      const inlineKeyboard = {
        inline_keyboard: [
          [{ text: "🚖 Пройти регистрацию", callback_data: "start_registration" }],
        ],
      };

      await sendTelegramMessage(
        chatId,
        "Здравствуйте! 👋\nЭтот бот помогает водителям пройти регистрацию в парке ASR TAXI.\n\nНажмите кнопку ниже, чтобы начать.",
        inlineKeyboard
      );

      return { statusCode: 200, body: "OK" };
    }

    // 2) Водитель отправил контакт (номер телефона)
    if (hasContact) {
      const contact = msg.contact;
      const from = msg.from;

      // гарантируем, что водитель не шлёт чужой контакт
      if (contact.user_id && from && contact.user_id !== from.id) {
        await sendTelegramMessage(
          chatId,
          "Пожалуйста, отправьте именно свой номер телефона, на который зарегистрирован ваш аккаунт Telegram."
        );
        return { statusCode: 200, body: "Foreign contact rejected" };
      }

      const phone = contact.phone_number;
      const normalized = normalizePhone(phone);

      await sendTelegramMessage(
        chatId,
        `Спасибо! Номер <b>${normalized}</b> получен.\nПроверяю вас в базе Яндекс.Такси...`
      );

      const check = await checkDriverInFleet(normalized);

      if (check.error === "fleet_error" || check.error === "fleet_exception") {
        await sendTelegramMessage(
          chatId,
          "Сейчас не получается проверить данные в базе Яндекс.Такси. Я передам ваш номер оператору, он свяжется с вами вручную."
        );
        // можно отправить алерт операторам
        if (ADMIN_CHAT_IDS.length) {
          for (const adminId of ADMIN_CHAT_IDS) {
            await sendTelegramMessage(
              adminId,
              `❗️ Ошибка Fleet API.\nChat ID: <code>${chatId}</code>\nТелефон: <b>${normalized}</b>`
            );
          }
        }
        return { statusCode: 200, body: "Fleet error" };
      }

      if (check.exists) {
        // водитель уже есть в базе
        await sendTelegramMessage(
          chatId,
          "Вы уже есть в базе Яндекс.Такси. ✅\nОператор проверит данные и напишет вам по подключению."
        );

        // алерт операторам
        if (ADMIN_CHAT_IDS.length) {
          for (const adminId of ADMIN_CHAT_IDS) {
            await sendTelegramMessage(
              adminId,
              `✅ Водитель найден в базе.\nChat ID: <code>${chatId}</code>\nТелефон: <b>${normalized}</b>`
            );
          }
        }
      } else {
        // водителя нет в базе → предлагаем онлайн-регистрацию
        const docsUrl = `https://asr-taxi-docs.netlify.app/?tg_id=${encodeURIComponent(
          chatId
        )}&phone=${encodeURIComponent(normalized)}`;

        await sendTelegramMessage(
          chatId,
          `Вас ещё нет в базе Яндекс.Такси.\n\nПерейдите по ссылке и загрузите документы для регистрации:\n${docsUrl}\n\nПосле проверки оператор подключит вас к парку.`
        );

        if (ADMIN_CHAT_IDS.length) {
          for (const adminId of ADMIN_CHAT_IDS) {
            await sendTelegramMessage(
              adminId,
              `🆕 Новый водитель на регистрацию.\nChat ID: <code>${chatId}</code>\nТелефон: <b>${normalized}</b>\nСсылка для документов: ${docsUrl}`
            );
          }
        }
      }

      return { statusCode: 200, body: "Contact processed" };
    }

    // 3) Всё остальное — короткий ответ
    await sendTelegramMessage(
      chatId,
      "Сейчас этот бот отвечает только за регистрацию водителей.\nНажмите /start, чтобы начать регистрацию."
    );

    return { statusCode: 200, body: "OK" };
  } catch (err) {
    console.error("telegram-asr-bot handler error:", err);
    return { statusCode: 500, body: "Internal error" };
  }
};
