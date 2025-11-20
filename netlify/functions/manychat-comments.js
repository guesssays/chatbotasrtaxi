// netlify/functions/manychat-comments.js

const JSON_HEADERS = {
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  console.log("=== manychat-comments invoked ===");
  console.log("Method:", event.httpMethod);
  console.log("Headers:", event.headers);
  console.log("Raw body:", event.body);

  try {
    // CORS / preflight
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({ ok: true }),
      };
    }

    if (event.httpMethod !== "POST") {
      console.log("Wrong method, expected POST");
      return {
        statusCode: 405,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: "Method not allowed" }),
      };
    }

    // Парсим тело запроса от ManyChat
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      console.error("Bad JSON from ManyChat:", e);
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: "Bad JSON" }),
      };
    }

    console.log("Parsed body:", body);

    const commentText =
      body.message ||
      body.text ||
      body.comment ||
      body.user_input ||
      ""; // подстраховка

    const userName = body.user_name || "";
    const userId = body.user_id || body.contact_id || null;

    console.log("commentText:", commentText);
    console.log("userName:", userName);
    console.log("userId:", userId);

    if (!commentText) {
      console.log("No comment text in body");
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: "No message provided" }),
      };
    }

    const result = await generateCommentReply(commentText, userName, userId);

    console.log("AI comment result:", result);

    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify(result),
    };
  } catch (err) {
    console.error("manychat-comments error:", err);

    // Фоллбек, если вообще всё упало: двуязычный ответ + двуязычный DM
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        reply:
          "Спасибо за комментарий! Подробно ответим вам в Direct 🙂 / Рахмат изоҳингиз учун! Батафсил жавобни Direct’да ёзамиз 🙂",
        send_dm: 1,
        dm_text:
          "Ассалому алайкум! Это ASR TAXI. / Ассалому алайкум! Бу ASR TAXI.\n\n" +
          "Видим ваш комментарий под нашим постом. Напишите, пожалуйста, какая у вас машина и год выпуска — я подскажу по подключению и бонусам. / " +
          "Пост остидаги изоҳингизни кўрдик. Мошина моделини ва йилини ёзиб юборинг, уланиш ва бонуслар бўйича тушунтириб берамиз.",
      }),
    };
  }
};

//
// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====
//

// Есть ли в тексте вообще буквы (латиница или кириллица)
function hasAnyLetters(text) {
  return /[A-Za-z\u0400-\u04FF]/.test(text);
}

// Грубое определение языка:
//  - ru_cyr  — преимущественно русская кириллица
//  - uz_cyr  — кириллица с узбекскими буквами
//  - uz_lat  — узбек латиницей (salom, rahmat, ishlamoqchi, ulanmoqchiman и т.п.)
//  - unknown — эмодзи, "+", цифры и т.д. или что-то странное
function detectLang(text) {
  if (!text || !hasAnyLetters(text)) return "unknown";

  const hasCyr = /[\u0400-\u04FF]/.test(text);
  const hasLat = /[A-Za-z]/.test(text);

  if (hasCyr) {
    // узбекские специфические буквы в кириллице
    if (/[ўқғҳ]/i.test(text)) return "uz_cyr";
    return "ru_cyr";
  }

  if (hasLat) {
    // простые маркеры узбекской латиницы
    if (
      /(assalomu|assalomu alaykum|salom|rahmat|xon|shahar|toshkent|ulanish|ishlamoqchi|taxi|siz|sizga|sizni|man$|miz$)/i.test(
        text
      )
    ) {
      return "uz_lat";
    }

    // латиница, но не похоже на узбек → считаем неизвестным (англ, рандом и т.п.)
    return "unknown";
  }

  return "unknown";
}

// ====== ЛОГИКА ОТВЕТА ДЛЯ КОММЕНТАРИЕВ ======

async function generateCommentReply(commentText, userName, userId) {
  const apiKey = process.env.OPENAI_API_KEY;

  const lang = detectLang(commentText);
  console.log("detected lang:", lang);

  const languageUnknown = lang === "unknown";

  // Билингвальные заготовки для случаев, когда язык непонятен
  const fallbackBilingualReply =
    "Спасибо за комментарий! Сейчас подробно напишу вам в Direct 🙂 / " +
    "Рахмат изоҳингиз учун! Ҳозир барчасини Direct’га ёзаман 🙂";

  const fallbackBilingualDm =
    "Ассалому алайкум! Это ASR TAXI. / Ассалому алайкум! Бу ASR TAXI.\n\n" +
    "Пишем вам по поводу вашего комментария под нашим постом. " +
    "Напишите, пожалуйста, модель и год вашей машины — я подскажу по подключению и бонусам. / " +
    "Пост остидаги изоҳингиз бўйича ёзаяпмиз. Мошина моделини ва йилини ёзиб юборинг, уланиш ва бонуслар бўйича тушунтириб берамиз.";

  if (!apiKey) {
    console.error("OPENAI_API_KEY is not set");
    // Без ключа: если язык непонятен → двуязычно, иначе просто двуязычный базовый
    return {
      reply: fallbackBilingualReply,
      send_dm: 1,
      dm_text: fallbackBilingualDm,
    };
  }

  const systemPrompt = `
Ты — живой ассистент таксопарка ASR TAXI в Instagram.
Отвечаешь ИМЕННО на КОММЕНТАРИИ под постами, не на личные сообщения.

У тебя есть подсказка language_hint, она может быть:
- "ru_cyr"  — русский (кириллица)
- "uz_cyr"  — узбекский на кириллице
- "uz_lat"  — узбекский латиницей
- "unknown" — язык неясен (эмодзи, "+", странный текст)

ГЛАВНАЯ ЛОГИКА:
— Мы ВСЕГДА пишем человеку в Direct, вне зависимости от того, что он написал в комментарии.
— Под постом даём короткий публичный ответ (reply).
— В Direct (dm_text) начинаем диалог о подключении к ASR TAXI.

ЯЗЫК ОТВЕТА:
— Если language_hint = "ru_cyr" — отвечай по-русски.
— Если language_hint = "uz_cyr" — отвечай по-узбекски (кириллица).
— Если language_hint = "uz_lat" — отвечай по-узбекски ЛАТИНИЦЕЙ.
— Если language_hint = "unknown" — и reply, и dm_text ОБЯЗАТЕЛЬНО ДВУЯЗЫЧНЫЕ (русский + узбекский в одном сообщении).

ТИПЫ КОММЕНТАРИЕВ:

1) ЧИСТАЯ РЕАКЦИЯ: эмодзи, «+», «🔥», «✅», пара символов без смысла.
   reply:
   — Если language_hint = "unknown" — двуязычный, короткий.
   — Стиль: благодарим за комментарий и говорим, что написали в Direct.
   dm_text:
   — Если language_hint = "unknown" — ОБЯЗАТЕЛЬНО двуязычный (рус+узб).
   — Приветствие, ссылка на комментарий, первый вопрос (про машину и год выпуска).

2) ЕСТЬ ВОПРОС или ЯВНЫЙ ИНТЕРЕС (“как подключиться”, “хочу работать”, “комиссия какая” и т.п.):
   reply:
   — Краткий ответ (1–2 предложения) на языке из language_hint (или двуязычно, если "unknown").
   — В конце: что подробнее ответишь в Direct.
   dm_text:
   — Тот же язык, что и reply (или двуязычный, если "unknown").
   — Приветствие от ASR TAXI.
   — Ссылка на их комментарий.
   — Чуть более развернутый ответ (1–3 предложения).
   — Вопрос, который двигает диалог дальше: чем хочет заниматься (такси/доставка/грузовой), какая машина и год, есть ли стаж.

3) КОММЕНТАРИЙ БЕЗ ВОПРОСА, НО СМЫСЛОВОЙ (“интересно”, “надо подумать”, “хочу попробовать”):
   — Обрабатывай как лёгкий интерес (почти как пункт 2).
   — reply: поддержать интерес + фраза “подробно напишу в Direct”.
   — dm_text: приветствие, ссылка на комментарий и первый вопрос: хочет ли подключиться, есть ли машина, в каком городе и т.п.

ОГРАНИЧЕНИЯ:
— Сообщения должны быть короткими, живыми, как у обычного оператора.
— Можно использовать немного эмодзи.
— Никаких упоминаний, что ты бот, ассистент, ИИ и т.п.
— Наша цель — перевести человека в диалог о подключении, мягко задавая следующий вопрос.
`;

  const formatPrompt = `
ОТВЕТ ДОЛЖЕН БЫТЬ СТРОГО ОДНИМ JSON-ОБЪЕКТОМ БЕЗ ЛИШНЕГО ТЕКСТА.

Формат:
{
  "reply": "короткий текст публичного ответа под комментарием",
  "send_dm": 1,
  "dm_text": "текст первого сообщения в Direct"
}

Требования:
— "send_dm" ВСЕГДА должен быть равен 1.
— "dm_text" не может быть пустой строкой.
— Если language_hint = "unknown" — reply и dm_text ОБЯЗАТЕЛЬНО двуязычные (русский + узбекский).
— Никаких комментариев, пояснений, markdown и т.п. — только валидный JSON.
`;

  const userPrompt = `
Комментарий под постом в Instagram:
"${commentText}"

Имя пользователя (можно использовать в обращении, но не обязательно):
"${userName || ""}"

language_hint: "${lang}"
`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "system", content: formatPrompt },
    { role: "user", content: userPrompt },
  ];

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages,
      temperature: 0.5,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("OpenAI error (comments):", response.status, errText);
    return {
      reply: fallbackBilingualReply,
      send_dm: 1,
      dm_text: fallbackBilingualDm,
    };
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content?.trim() || "";
  console.log("Raw OpenAI answer (comments):", raw);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error("Failed to parse JSON from OpenAI (comments)", e);
    return {
      reply: raw || fallbackBilingualReply,
      send_dm: 1,
      dm_text: fallbackBilingualDm,
    };
  }

  let reply =
    typeof parsed.reply === "string"
      ? parsed.reply.trim()
      : fallbackBilingualReply;

  let dmText =
    typeof parsed.dm_text === "string" && parsed.dm_text.trim().length > 0
      ? parsed.dm_text.trim()
      : fallbackBilingualDm;

  const sendDm = 1;

  // Доп. защита: если язык неизвестен, всё равно принудительно двуязычный текст
  if (languageUnknown) {
    console.log("Language is unknown, enforcing bilingual reply + DM");
    reply = fallbackBilingualReply;
    dmText = fallbackBilingualDm;
  }

  return {
    reply,
    send_dm: sendDm,
    dm_text: dmText,
  };
}
