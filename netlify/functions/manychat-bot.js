// netlify/functions/manychat-bot.js

// Этот хэндлер дергает ManyChat
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Method not allowed" }),
      };
    }

    // Разбираем тело запроса от ManyChat
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      console.error("Bad JSON from ManyChat:", e);
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Bad JSON" }),
      };
    }

    const userMessage =
      body.message ||
      body.text ||
      body.user_input ||
      ""; // подстрахуемся под разные варианты

    const contactId = body.contact_id || body.user_id || null;

    if (!userMessage) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "No message provided" }),
      };
    }

    // === Здесь формируем ответ нейросети ===
    const replyText = await generateReply(userMessage, contactId);

    // Возвращаем максимально простой JSON
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        reply: replyText,
      }),
    };
  } catch (err) {
    console.error("manychat-bot error:", err);

    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply: "Произошла ошибка. Попробуй ещё раз чуть позже 🙏",
      }),
    };
  }
};

// ====== ВОТ ЭТА ФУНКЦИЯ ТЕБЕ И НУЖНА ======
async function generateReply(userMessage, contactId) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY is not set");
    // На всякий случай хоть что-то ответим
    return `Ты написал: "${userMessage}"`;
  }

  try {
    const systemPrompt =
      "Ты помощник онлайн-магазина одежды. Отвечай коротко, дружелюбно и по-деловому на русском. Если вопрос не про одежду, тоже отвечай, но без лишней воды.";

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini", // при желании поменяешь на свой
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: userMessage,
          },
        ],
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("OpenAI error:", response.status, errText);
      return "Сейчас не могу ответить, попробуй ещё раз чуть позже 🙏";
    }

    const data = await response.json();
    const reply =
      data.choices?.[0]?.message?.content?.trim() ||
      "Не удалось сформировать ответ 😔";

    return reply;
  } catch (e) {
    console.error("generateReply error:", e);
    return "Что-то пошло не так, попробуй ещё раз позже 🙏";
  }
}
