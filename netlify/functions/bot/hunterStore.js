// bot/hunterStore.js

const { createClient } = require("@netlify/blobs");

let hunterBlobsClient = null;
const hunterStores = new Map();

/**
 * Инициализация отдельного Blobs-клиента
 * для hunter-бота.
 *
 * Используем:
 *  - HUNTER_BLOBS_TOKEN  — персональный токен только для hunter-бота
 *  - BLOBS_SITE_ID       — общий site id (как в обычном store.js)
 */
function initHunterBlobStore() {
  if (hunterBlobsClient) {
    return; // уже инициализирован
  }

  const token = process.env.HUNTER_BLOBS_TOKEN;
  const siteId = process.env.BLOBS_SITE_ID;

  if (!token) {
    console.error(
      "initHunterBlobStore: HUNTER_BLOBS_TOKEN is not set in environment"
    );
    throw new Error("HUNTER_BLOBS_TOKEN is not set");
  }

  if (!siteId) {
    console.error(
      "initHunterBlobStore: BLOBS_SITE_ID is not set in environment"
    );
    throw new Error("BLOBS_SITE_ID is not set");
  }

  // ВАЖНО: createClient берём именно как { createClient } из require("@netlify/blobs")
  hunterBlobsClient = createClient({
    token,
    siteId,
  });
}

/**
 * Возвращает raw-store по имени.
 * Перед вызовом ОБЯЗАТЕЛЬНО должна быть вызвана initHunterBlobStore().
 */
function getHunterStoreRaw(storeName) {
  if (!hunterBlobsClient) {
    throw new Error("Hunter blob store is not initialized");
  }

  if (!hunterStores.has(storeName)) {
    hunterStores.set(storeName, hunterBlobsClient.getStore(storeName));
  }

  return hunterStores.get(storeName);
}

module.exports = {
  initHunterBlobStore,
  getHunterStoreRaw,
};
