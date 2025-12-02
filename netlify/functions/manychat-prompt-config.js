// netlify/functions/manychat-prompt-config.js
const { getStore } = require("@netlify/blobs");

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ADMIN_TOKEN = process.env.PROMPT_ADMIN_TOKEN || "";

// 🔹 Хелпер для доступа к Blobs c ручной конфигурацией
function getPromptStore() {
  const siteID = process.env.BLOBS_SITE_ID;
  const token = process.env.BLOBS_TOKEN;

  if (!siteID || !token) {
    throw new Error("Missing BLOBS_SITE_ID or BLOBS_TOKEN env vars");
  }

  return getStore("manychat-prompts", { siteID, token });
}

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

  let store;
  try {
    // ✅ создаём store с siteID + token
    store = getPromptStore();
  } catch (e) {
    console.error("Blobs not configured:", e);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        error:
          "Netlify Blobs не настроены (нет BLOBS_SITE_ID или BLOBS_TOKEN).",
      }),
    };
  }

  try {
    if (event.httpMethod === "GET") {
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
