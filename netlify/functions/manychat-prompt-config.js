// netlify/functions/manychat-prompt-config.js

const { getStore } = require("@netlify/blobs");

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const store = getStore("manychat-prompts");

// простой токен для защиты (задай в Netlify env)
const ADMIN_TOKEN = process.env.PROMPT_ADMIN_TOKEN || "";

function checkAuth(event) {
  const qs = event.queryStringParameters || {};
  const token = qs.token || "";
  return ADMIN_TOKEN && token === ADMIN_TOKEN;
}

exports.handler = async (event) => {
  console.log("=== manychat-prompt-config ===", event.httpMethod);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: JSON_HEADERS, body: "" };
  }

  if (!checkAuth(event)) {
    return {
      statusCode: 401,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: "Unauthorized" }),
    };
  }

  try {
    if (event.httpMethod === "GET") {
      // читаем сохранённый промпт
      const systemPrompt = (await store.get("systemPrompt")) || "";
      return {
        statusCode: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({ systemPrompt }),
      };
    }

    if (event.httpMethod === "POST") {
      let body;
      try {
        body = JSON.parse(event.body || "{}");
      } catch (e) {
        return {
          statusCode: 400,
          headers: JSON_HEADERS,
          body: JSON.stringify({ error: "Bad JSON" }),
        };
      }

      const systemPrompt = body.systemPrompt || "";
      // сохраняем промпт
      await store.set("systemPrompt", systemPrompt);

      return {
        statusCode: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({ ok: true }),
      };
    }

    return {
      statusCode: 405,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  } catch (e) {
    console.error("prompt-config error:", e);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: "Internal error" }),
    };
  }
};
