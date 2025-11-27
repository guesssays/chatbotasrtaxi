// netlify/functions/bot/store.js

// Используем Netlify Blobs
const { getStore: getNetlifyStore } = require("@netlify/blobs");

/**
 * Для Functions v1 initBlobStore можно оставить no-op.
 * Мы просто держим эту функцию, чтобы код, который её вызывает,
 * не падал.
 */
function initBlobStore(_event) {
  // Для обычных функций ничего делать не нужно.
}

/**
 * Возвращает store c указанным именем.
 * В остальных файлах ты можешь вызывать:
 *   const store = getStore("hunter-bot-hunters");
 *   await store.setJSON("key", data);
 */
function getStore(name) {
  if (!name) {
    throw new Error("getStore: store name is required");
  }
  return getNetlifyStore({ name });
}

module.exports = {
  initBlobStore,
  getStore,
};
