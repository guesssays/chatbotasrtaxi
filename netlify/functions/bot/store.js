// netlify/functions/bot/store.js

const { getStore: getNetlifyStore } = require("@netlify/blobs");

// Берём конфиг из переменных окружения
const BLOBS_SITE_ID =
  process.env.BLOBS_SITE_ID ||
  process.env.NETLIFY_SITE_ID ||
  process.env.SITE_ID ||
  null;

const BLOBS_TOKEN =
  process.env.BLOBS_TOKEN ||
  process.env.NETLIFY_BLOBS_TOKEN ||
  process.env.NETLIFY_AUTH_TOKEN ||
  null;

/**
 * Для Functions v1 initBlobStore остаётся no-op.
 * Мы просто держим эту функцию для совместимости с кодом,
 * который её вызывает.
 */
function initBlobStore(_event) {
  // Для обычных функций ничего делать не нужно.
}

/**
 * Возвращает store c указанным именем.
 */
function getStore(name) {
  if (!name) {
    throw new Error("getStore: store name is required");
  }

  // Если явно заданы siteID и token — используем их (надёжный вариант для Functions v1)
  if (BLOBS_SITE_ID && BLOBS_TOKEN) {
    return getNetlifyStore({
      name,
      siteID: BLOBS_SITE_ID,
      token: BLOBS_TOKEN,
    });
  }

  // Иначе даём @netlify/blobs попытаться autodetect (локально / в v2-функциях)
  return getNetlifyStore({ name });
}

module.exports = {
  initBlobStore,
  getStore,
};
