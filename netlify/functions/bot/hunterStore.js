// bot/hunterStore.js
// Отдельный клиент Netlify Blobs специально для telegram-hunter-bot

const { createClient } = require("@netlify/blobs");

let hunterBlobsClient = null;

/**
 * Инициализация отдельного Blobs-клиента для hunter-бота.
 * Используем отдельный токен HUNTER_BLOBS_TOKEN,
 * но siteID берём из BLOBS_SITE_ID (как в остальных функциях).
 */
function initHunterBlobStore() {
  if (hunterBlobsClient) return;

  const token =
    process.env.HUNTER_BLOBS_TOKEN || // 🔹 отдельный токен только для hunter-бота
    process.env.BLOBS_PERSONAL_TOKEN || // запасной вариант, если вдруг не задали
    process.env.BLOBS_RW_TOKEN || // ещё один запасной
    process.env.BLOBS_TOKEN; // самый старый вариант

  const siteID = process.env.BLOBS_SITE_ID;

  if (!token || !siteID) {
    console.error("initHunterBlobStore: no token or siteID", {
      hasToken: !!token,
      hasSiteId: !!siteID,
    });
    throw new Error("Hunter Blobs not configured (HUNTER_BLOBS_TOKEN/BLOBS_SITE_ID)");
  }

  hunterBlobsClient = createClient({
    token,
    siteID,
  });
}

/**
 * Получение стора по имени (hunter-bot-hunters, hunter-bot-driver-index и т.д.)
 */
function getHunterStoreRaw(name) {
  if (!hunterBlobsClient) {
    throw new Error("Hunter blob store is not initialized");
  }
  return hunterBlobsClient.store(name);
}

module.exports = {
  initHunterBlobStore,
  getHunterStoreRaw,
};
