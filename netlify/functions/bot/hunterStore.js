// bot/hunterStore.js

const { getStore: getNetlifyStore } = require("@netlify/blobs");

// Отдельные env-переменные для hunter-бота
const HUNTER_BLOBS_SITE_ID =
  process.env.HUNTER_BLOBS_SITE_ID || // можешь завести такую
  process.env.BLOBS_SITE_ID ||
  process.env.NETLIFY_SITE_ID ||
  process.env.SITE_ID ||
  null;

const HUNTER_BLOBS_TOKEN =
  process.env.HUNTER_BLOBS_TOKEN ||   // персональный токен для hunter
  process.env.BLOBS_TOKEN ||
  process.env.NETLIFY_BLOBS_TOKEN ||
  process.env.NETLIFY_AUTH_TOKEN ||
  null;

// Чтобы код, который вызывает initHunterBlobStore(), не падал
function initHunterBlobStore() {
  if (!HUNTER_BLOBS_SITE_ID || !HUNTER_BLOBS_TOKEN) {
    console.error(
      "Hunter blobs: HUNTER_BLOBS_TOKEN или HUNTER_BLOBS_SITE_ID/BLOBS_SITE_ID не заданы"
    );
    // можно бросить ошибку, чтобы сразу увидеть проблему
    // throw new Error("Hunter blob store config missing");
  }
}

/**
 * Возвращает store для hunter-бота.
 * Перед этим в логах можно посмотреть, хватает ли конфигурации.
 */
function getHunterStoreRaw(name) {
  if (!name) {
    throw new Error("getHunterStoreRaw: store name is required");
  }

  if (HUNTER_BLOBS_SITE_ID && HUNTER_BLOBS_TOKEN) {
    return getNetlifyStore({
      name,
      siteID: HUNTER_BLOBS_SITE_ID,
      token: HUNTER_BLOBS_TOKEN,
    });
  }

  // fallback — автоопределение (локально / в v2-функциях)
  return getNetlifyStore({ name });
}

module.exports = {
  initHunterBlobStore,
  getHunterStoreRaw,
};
