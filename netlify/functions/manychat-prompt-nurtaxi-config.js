// netlify/functions/manychat-prompt-nurtaxi-config.js

const { getStore } = require("@netlify/blobs");

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// 🔑 Отдельный токен для админ-доступа
const ADMIN_TOKEN = process.env.NURTAXI_PROMPT_ADMIN_TOKEN || "";

// 🔑 Отдельные env переменные для Blobs хранилища NurTaxi
const SITE_ID = process.env.NURTAXI_PROMPT_BLOBS_SITE_ID;
const TOKEN = process.env.NURTAXI_PROMPT_BLOBS_TOKEN;

// Дефолтный промпт (оставь пустым — заказчик заполнит сам)
const DEFAULT_SYSTEM_PROMPT = `Напиши здесь базовый промпт NurTaxi…`;

function getPromptStore() {
  if (!SITE_ID || !TOKEN) {
    throw new Error("Missing NURTAXI_PROMPT_BLOBS_SITE_ID or NURTAXI_PROMPT_BLOBS_TOKEN");
  }

  return getStore({
    name: "manychat-nurtaxi-prompts",
    siteID: SITE_ID,
    token: TOKEN,
  });
}

function checkAuth(event) {
  const qs = event.queryStringParameters || {};
  return ADMIN_TOKEN && qs.token === ADMIN_TOKEN;
}

exports.handler = async (event) => {
  console.log("=== manychat-prompt-nurtaxi-config ===", event.httpMethod);

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
    store = getPromptStore();
  } catch (e) {
    console.error(e);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: "Blobs not configured" }),
    };
  }

  // --- GET (получение промпта)
  if (event.httpMethod === "GET") {
    let systemPrompt = await store.get("systemPrompt");
    if (!systemPrompt) systemPrompt = DEFAULT_SYSTEM_PROMPT;

    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ systemPrompt }),
    };
  }

  // --- POST (сохранение промпта)
  if (event.httpMethod === "POST") {
    const body = JSON.parse(event.body || "{}");
    const text = body.systemPrompt || DEFAULT_SYSTEM_PROMPT;

    await store.set("systemPrompt", text);

    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ ok: true }),
    };
  }

  return { statusCode: 405, headers: JSON_HEADERS, body: "Method Not Allowed" };
};
