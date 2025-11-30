// netlify/functions/telegram-hunter-bot.js

// ================== ENV & TELEGRAM ==================
const TELEGRAM_TOKEN =
  process.env.TG_HUNTER_BOT_TOKEN || process.env.TG_BOT_TOKEN || null;

const TELEGRAM_API = TELEGRAM_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_TOKEN}`
  : null;

// ⚠️ ОТДЕЛЬНЫЕ переменные для hunter-бота
const ADMIN_CHAT_IDS = (
  process.env.ADMIN_CHAT_IDS_HUNTER || // только для hunter-бота
  process.env.ADMIN_CHAT_IDS || // запасной вариант (как раньше)
  process.env.ADMIN_CHAT_ID || ""
)
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const LOG_CHAT_ID =

  process.env.LOG_CHAT_ID_HUNTER || // отдельный лог-чат для hunter-бота
  process.env.LOG_CHAT_ID || // старый общий лог
  null;
const ASRPUL_STATUS_CHAT_ID = process.env.ASRPUL_STATUS_CHAT_ID || null;

// upload-doc endpoint (как в основном боте водителей)
const UPLOAD_DOC_URL =
  process.env.UPLOAD_DOC_URL ||
  (process.env.URL &&
    `${process.env.URL.replace(/\/$/, "")}/.netlify/functions/upload-doc`) ||
  null;

// ===== Yandex Fleet API (Park) =====
const FLEET_API_URL = process.env.FLEET_API_URL || null;
const FLEET_API_KEY = process.env.FLEET_API_KEY || null;
const FLEET_CLIENT_ID = process.env.FLEET_CLIENT_ID || null;
const FLEET_PARK_ID = process.env.FLEET_PARK_ID || null;

// Work rule — ТОЛЬКО hunter
const FLEET_WORK_RULE_ID_HUNTER =
  process.env.FLEET_WORK_RULE_ID_HUNTER || null;

// платёжный сервис (НЕ обязателен для регистрации)
const FLEET_PAYMENT_SERVICE_ID =
  process.env.FLEET_PAYMENT_SERVICE_ID || null;

// дефолты
const FLEET_DEFAULT_LICENSE_COUNTRY =
  process.env.FLEET_DEFAULT_LICENSE_COUNTRY || "UZB";
const FLEET_DEFAULT_EMPLOYMENT_TYPE =
  process.env.FLEET_DEFAULT_EMPLOYMENT_TYPE || "selfemployed";
const FLEET_DEFAULT_TRANSMISSION =
  process.env.FLEET_DEFAULT_TRANSMISSION || "automatic";
const FLEET_DEFAULT_FUEL_TYPE =
  process.env.FLEET_DEFAULT_FUEL_TYPE || "petrol";

const FLEET_API_BASE_URL =
  (FLEET_API_URL && FLEET_API_URL.replace(/\/$/, "")) ||
  "https://fleet-api.taxi.yandex.net";

if (!TELEGRAM_TOKEN) {
  console.error(
    "TG_HUNTER_BOT_TOKEN / TG_BOT_TOKEN is not set (telegram-hunter-bot.js)"
  );
}
if (!UPLOAD_DOC_URL) {
  console.error(
    "UPLOAD_DOC_URL is not set and URL is not available (hunter-bot)"
  );
}

// ================== PERSISTENT HUNTER STORAGE (Netlify Blobs) ==================
const { initBlobStore, getStore } = require("./bot/store");

const HUNTER_STORE_NAME = "hunter-bot-hunters";
const DRIVER_INDEX_STORE_NAME = "hunter-bot-driver-index";

function getHunterStore() {
  try {
    return getStore(HUNTER_STORE_NAME);
  } catch (e) {
    console.error("getHunterStore error:", e);
    return null;
  }
}

function getDriverIndexStore() {
  try {
    return getStore(DRIVER_INDEX_STORE_NAME);
  } catch (e) {
    console.error("getDriverIndexStore error:", e);
    return null;
  }
}


async function loadHunterFromStorage(chatId) {
  try {
    const store = getHunterStore();
    if (!store) return null;
    const hunter = await store.get(`hunter:${chatId}`, { type: "json" });
    return hunter || null;
  } catch (e) {
    console.error("loadHunterFromStorage error:", e);
    return null;
  }
}

async function saveHunterToStorage(hunter) {
  try {
    const store = getHunterStore();
    if (!store) return;
    await store.setJSON(`hunter:${hunter.chatId}`, hunter);
  } catch (e) {
    console.error("saveHunterToStorage error:", e);
  }
}

// ================== SIMPLE IN-MEMORY SESSIONS ==================
const sessions = new Map(); // chatId -> { step, hunter, driverDraft, editField }

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      step: "idle",
      hunter: null,
      driverDraft: null,
      editField: null,
    });
  }
  return sessions.get(chatId);
}

function resetSession(chatId) {
  sessions.delete(chatId);
}

// ================== TELEGRAM HELPERS ==================
async function sendTelegramMessage(chatId, text, extra = {}) {
  if (!TELEGRAM_API) {
    console.error("sendTelegramMessage: no TELEGRAM_API");
    return;
  }
  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, ...extra }),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error("sendMessage error:", res.status, txt);
    }
  } catch (e) {
    console.error("sendTelegramMessage exception:", e);
  }
}

async function sendTelegramMediaGroup(chatId, media) {
  if (!TELEGRAM_API) {
    console.error("sendTelegramMediaGroup: no TELEGRAM_API");
    return;
  }
  if (!media || !media.length) return;

  try {
    const res = await fetch(`${TELEGRAM_API}/sendMediaGroup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, media }),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error("sendMediaGroup error:", res.status, txt);
    }
  } catch (e) {
    console.error("sendTelegramMediaGroup exception:", e);
  }
}

async function editMessageReplyMarkup(chatId, messageId, replyMarkup) {
  if (!TELEGRAM_API) {
    console.error("editMessageReplyMarkup: no TELEGRAM_API");
    return;
  }
  if (!chatId || !messageId) return;

  try {
    const res = await fetch(`${TELEGRAM_API}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: replyMarkup || undefined,
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error("editMessageReplyMarkup error:", res.status, txt);
    }
  } catch (e) {
    console.error("editMessageReplyMarkup exception:", e);
  }
}


async function answerCallbackQuery(callbackQueryId) {
  if (!TELEGRAM_API || !callbackQueryId) return;
  try {
    const res = await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error("answerCallbackQuery error:", res.status, txt);
    }
  } catch (e) {
    console.error("answerCallbackQuery exception:", e);
  }
}

// ⚠️ Оповещения операторам — БЕЗ Markdown
async function sendOperatorAlert(text) {
  const targets = new Set();
  for (const id of ADMIN_CHAT_IDS) {
    if (id) targets.add(id);
  }
  if (LOG_CHAT_ID) targets.add(LOG_CHAT_ID);
  if (!targets.size) return;

  for (const chatId of targets) {
    await sendTelegramMessage(chatId, text);
  }
}

function mainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: "➕ Haydovchini ro‘yxatdan o‘tkazish" }],
      [{ text: "👥 Mening haydovchilarim" }, { text: "ℹ️ Yordam" }],
    ],
    resize_keyboard: true,
  };
}

const CANCEL_REG_TEXT = "❌ Ro‘yxatdan o‘tishni bekor qilish";

function registrationKeyboard() {
  return {
    keyboard: [[{ text: CANCEL_REG_TEXT }]],
    resize_keyboard: true,
  };
}

function isInDriverRegistration(session) {
  if (!session) return false;
  if (!session.driverDraft) return false;
  const step = session.step || "";
  return step.startsWith("driver_") || step === "edit_field";
}

async function cancelDriverRegistration(chatId, session) {
  session.driverDraft = null;
  session.editField = null;
  session.step = "main_menu";

  await sendTelegramMessage(
    chatId,
    "Ro‘yxatdan o‘tkazish jarayoni bekor qilindi. Asosiy menyuga qaytdingiz.",
    { reply_markup: mainMenuKeyboard() }
  );
}

// отправка фото документов в лог-чат
async function sendDocsToLogChat(draft) {
  if (!LOG_CHAT_ID) return;

  const media = [];

  if (draft.vuFrontFileId) {
    media.push({
      type: "photo",
      media: draft.vuFrontFileId,
    });
  }
  if (draft.techFrontFileId) {
    media.push({
      type: "photo",
      media: draft.techFrontFileId,
    });
  }
  if (draft.techBackFileId) {
    media.push({
      type: "photo",
      media: draft.techBackFileId,
    });
  }

  if (!media.length) return;

  const captionLines = [];
  captionLines.push("📄 *Hunter-bot orqali kelgan hujjatlar to‘plami*");
  captionLines.push("");
  captionLines.push(`👤 Haydovchi: ${draft.driverFullName || "—"}`);
  captionLines.push(`📞 Telefon: ${draft.driverPhone || "—"}`);
  captionLines.push(
    `🚗 Avto: ${draft.carBrand || ""} ${draft.carModel || ""}${
      draft.carYear ? " (" + draft.carYear + ")" : ""
    }`
  );
  captionLines.push(`Davlat raqami: ${draft.carPlate || "—"}`);
  captionLines.push("");
  captionLines.push(
  `Hunter: ${draft.hunterName || "—"} (chat id ${draft.hunterChatId || "—"})`
  );

  media[0].caption = captionLines.join("\n");
  media[0].parse_mode = "Markdown";

  await sendTelegramMediaGroup(LOG_CHAT_ID, media);
}

// ================== YANDEX FLEET HELPERS ==================
function ensureFleetConfigured() {
  if (!FLEET_CLIENT_ID || !FLEET_API_KEY || !FLEET_PARK_ID) {
    const msg =
      "Yandex Fleet integratsiyasi sozlanmagan (FLEET_CLIENT_ID / FLEET_API_KEY / FLEET_PARK_ID).";
    console.error(msg);
    return { ok: false, message: msg };
  }
  return { ok: true };
}

function makeIdempotencyKey(prefix = "idemp") {
  const ts = Date.now().toString(16);
  const rand = Math.random().toString(16).slice(2, 10);
  let key = `${prefix}-${ts}-${rand}`;

  if (key.length < 16) {
    key = key.padEnd(16, "x");
  }
  if (key.length > 64) {
    key = key.slice(0, 64);
  }
  return key;
}

async function callFleetPostIdempotent(path, payload, idempotencyKey) {
  const cfg = ensureFleetConfigured();
  if (!cfg.ok) return { ok: false, message: cfg.message };

  const url = `${FLEET_API_BASE_URL}${path}`;

  let key = idempotencyKey || makeIdempotencyKey();
  if (key.length < 16) key = key.padEnd(16, "x");
  if (key.length > 64) key = key.slice(0, 64);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-ID": FLEET_CLIENT_ID,
        "X-API-Key": FLEET_API_KEY,
        "X-Park-ID": FLEET_PARK_ID,
        "X-Idempotency-Token": key,
      },
      body: JSON.stringify(payload || {}),
    });

    let json = null;
    try {
      json = await res.json();
    } catch (e) {}

    if (!res.ok) {
      console.error("callFleetPostIdempotent error:", res.status, json);
      return {
        ok: false,
        status: res.status,
        message:
          (json && (json.message || json.code)) ||
          `Yandex Fleet API xatosi: ${res.status}`,
        raw: json,
      };
    }

    return { ok: true, data: json };
  } catch (e) {
    console.error("callFleetPostIdempotent exception:", e);
    return { ok: false, message: String(e) };
  }
}

async function callFleetPost(path, payload) {
  const cfg = ensureFleetConfigured();
  if (!cfg.ok) {
    console.error("callFleetPost: fleet not configured:", cfg.message);
    return { ok: false, message: cfg.message };
  }

  const url = `${FLEET_API_BASE_URL}${path}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-ID": FLEET_CLIENT_ID,
        "X-API-Key": FLEET_API_KEY,
        "X-Park-ID": FLEET_PARK_ID,
      },
      body: JSON.stringify(payload || {}),
    });

    let json = null;
    try {
      json = await res.json();
    } catch (e) {}

    if (!res.ok) {
      console.error("callFleetPost error:", res.status, json);
      return {
        ok: false,
        status: res.status,
        message:
          (json && (json.message || json.code)) ||
          `Yandex Fleet API xatosi: ${res.status}`,
        raw: json,
      };
    }

    return { ok: true, data: json };
  } catch (e) {
    console.error("callFleetPost exception:", e);
    return { ok: false, message: String(e) };
  }
}

async function bindCarToDriver(driverId, vehicleId) {
  const cfg = ensureFleetConfigured();
  if (!cfg.ok) return { ok: false, error: cfg.message };

  if (!driverId || !vehicleId) {
    return {
      ok: false,
      error:
        "Для привязки автомобиля к водителю не передан driverId yoki vehicleId.",
      code: "bind_missing_ids",
    };
  }

  // ✅ car_id и driver_profile_id переносим в query
  const url =
    `${FLEET_API_BASE_URL}` +
    `/v1/parks/driver-profiles/car-bindings` +
    `?park_id=${encodeURIComponent(FLEET_PARK_ID)}` +
    `&driver_profile_id=${encodeURIComponent(driverId)}` +
    `&car_id=${encodeURIComponent(vehicleId)}`;

  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Client-ID": FLEET_CLIENT_ID,
        "X-API-Key": FLEET_API_KEY,
        "X-Park-ID": FLEET_PARK_ID,
      },
      body: JSON.stringify({}), // тело может быть пустым
    });

    let json = null;
    try {
      json = await res.json();
    } catch (e) {}

    if (!res.ok) {
      console.error("bindCarToDriver error:", res.status, json);
      return {
        ok: false,
        status: res.status,
        error:
          (json && (json.message || json.code)) ||
          `Yandex Fleet API xatosi: ${res.status}`,
        raw: json,
        errorCode: (json && json.code) || null,
      };
    }

    return { ok: true, data: json };
  } catch (e) {
    console.error("bindCarToDriver exception:", e);
    return { ok: false, error: String(e) };
  }
}


// ===== Normalization helpers =====

function normalizePhoneForYandex(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^\d]/g, "");
  if (!digits) return null;

  if (digits.length === 9) {
    return `+998${digits}`;
  }

  if (digits.startsWith("998") && (digits.length === 12 || digits.length === 13)) {
    return `+${digits}`;
  }

  if (digits.length === 11 && digits[0] === "8") {
    return `+7${digits.slice(1)}`;
  }

  if (digits.length >= 11) {
    return `+${digits}`;
  }

  return phone;
}

function normalizeDateToISO(dateStr) {
  if (!dateStr) return undefined;
  const s = String(dateStr).trim();
  if (!s) return undefined;

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return s;
  }

  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) {
    const d = m[1].padStart(2, "0");
    const mo = m[2].padStart(2, "0");
    const y = m[3];
    return `${y}-${mo}-${d}`;
  }

  return undefined;
}

function normalizeDriverLicenseNumber(
  countryCode,
  licenseSeries,
  licenseNumber,
  licenseFull
) {
  let raw = (licenseFull && String(licenseFull).trim()) || "";
  if (!raw) {
    raw = `${licenseSeries || ""}${licenseNumber || ""}`.trim();
  }
  if (!raw) return null;

  let v = raw.toUpperCase();
  v = v.replace(/[^0-9A-Z]/g, "");

  const country = (countryCode || "").toUpperCase();

  if (country === "UZB") {
    if (v.startsWith("UZB")) {
      v = v.slice(3);
    } else if (v.startsWith("UZ")) {
      v = v.slice(2);
    }
  }

  if (!v) return null;
  return v;
}

function mapColorToYandexFromText(txt) {
  const s = (txt || "").toLowerCase();

  if (!s) return "Белый";

  if (s.includes("oq") || s.includes("white")) return "Белый";
  if (s.includes("qora") || s.includes("black")) return "Черный";
  if (s.includes("kul") || s.includes("gray") || s.includes("grey"))
    return "Серый";
  if (s.includes("kumush") || s.includes("silver")) return "Серый";
  if (s.includes("ko‘k") || s.includes("kök") || s.includes("blue"))
    return "Синий";
  if (s.includes("qizil") || s.includes("red") || s.includes("bordo"))
    return "Красный";
  if (s.includes("sariq") || s.includes("yellow")) return "Желтый";
  if (s.includes("yashil") || s.includes("green")) return "Зеленый";
  if (s.includes("jigar") || s.includes("brown")) return "Коричневый";
  if (s.includes("bej") || s.includes("beige")) return "Бежевый";
  if (s.includes("to‘q sariq") || s.includes("orange")) return "Оранжевый";
  if (s.includes("binafsha") || s.includes("purple")) return "Фиолетовый";

  return "Белый";
}

// ===== СПИСКИ МАРОК / МОДЕЛЕЙ / ЦВЕТОВ =====

function makeCarCode(label) {
  return label
    .normalize("NFKD")
    .replace(/[^\w\s]/g, " ")
    .replace(/[\u0400-\u04FF]+/g, "")
    .toUpperCase()
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60);
}

const CAR_BRANDS = [
  { code: "CHEVROLET", label: "Chevrolet" },
  { code: "RAVON", label: "Ravon" },
  { code: "DAEWOO", label: "Daewoo" },
  { code: "BYD", label: "BYD" },
  { code: "CHERY", label: "Chery" },
  { code: "CHANGAN", label: "Changan" },
  { code: "JAC", label: "JAC" },
  { code: "GEELY", label: "Geely" },
  { code: "HYUNDAI", label: "Hyundai" },
  { code: "KIA", label: "Kia" },
  { code: "LEAPMOTOR", label: "Leapmotor" },
];

const CAR_MODELS_BY_BRAND = {
  CHEVROLET: [
    "Cobalt",
    "Nexia",
    "Gentra",
    "Lacetti",
    "Malibu",
    "Malibu Turbo",
    "Onix",
    "Spark",
    "Tracker",
    "Equinox",
    "Epica",
    "Cruze",
    "Orlando",
    "Bolt EV",
    "Menlo",
    "Monza",
    "Traverse",
    "Trailblazer",
    "Tahoe",
    "Captiva",
    "Colorado",
    "Evanda",
  ],
  RAVON: ["Nexia R3", "R4", "Gentra"],
  DAEWOO: [
    "Tico",
    "Matiz",
    "Damas",
    "Labo",
    "Gentra (доузб.)",
    "Kalos",
    "Lacetti (старый)",
    "Lanos",
    "Leganza",
    "Magnus",
    "Nubira",
    "Tacuma",
    "Winstorm",
    "Sens",
  ],
  BYD: [
    "E2",
    "Chazor",
    "Qin Plus",
    "Qin Pro",
    "Han",
    "Seagull",
    "Song Plus",
    "Tang",
    "Yuan",
    "Geometry C",
  ],
  CHERY: [
    "Arrizo 6 Pro",
    "Arrizo 7",
    "Tiggo 2",
    "Tiggo 3",
    "Tiggo 4",
    "Tiggo 4 Pro",
    "Tiggo 7",
    "Tiggo 7 Pro",
    "Tiggo 7 Pro Max",
    "Tiggo 8",
    "Tiggo 8 Pro",
    "Tiggo 8 Pro Max",
    "EQ5",
    "eQ7",
  ],
  CHANGAN: [
    "Alsvin",
    "CS35",
    "CS35 Plus",
    "CS55",
    "CS75",
    "Eado",
    "UNI-T",
    "New Van",
    "A600 EV",
  ],
  JAC: ["J5", "J7", "JS4", "S3", "S5", "iEV7S"],
  GEELY: [
    "Atlas",
    "Atlas Pro",
    "Coolray",
    "Emgrand 7",
    "Emgrand EC7",
    "Emgrand GT",
    "Geometry C",
    "Tugella",
    "TX4",
  ],
  HYUNDAI: [
    "Accent",
    "Accent Blue",
    "Avante",
    "Elantra",
    "Sonata",
    "Sonata Turbo",
    "i30",
    "i40",
    "Tucson",
    "Santa Fe",
    "Creta",
    "Venue",
    "Getz",
    "Grandeur",
    "Equus",
    "Ioniq",
    "Ioniq 5",
    "Staria",
  ],
  KIA: [
    "Rio",
    "Optima",
    "K5",
    "K3",
    "Cerato",
    "Forte",
    "Cadenza",
    "K7",
    "K8",
    "Sorento",
    "Sportage",
    "Soul",
    "Soul EV",
    "Seltos",
    "Stinger",
    "Carnival",
    "Carens",
    "Bongo",
  ],
  LEAPMOTOR: ["C01", "C10", "C11", "T03"],
};

const CAR_MODELS_INDEX = {};
for (const brand of CAR_BRANDS) {
  const list = CAR_MODELS_BY_BRAND[brand.code] || [];
  CAR_MODELS_INDEX[brand.code] = list.map((label) => ({
    code: makeCarCode(brand.code + "_" + label),
    label,
    fullLabel: `${brand.label} ${label}`,
  }));
}

const CAR_COLORS = [
  { code: "WHITE", label: "Oq" },
  { code: "BLACK", label: "Qora" },
  { code: "GRAY", label: "Kulrang" },
  { code: "SILVER", label: "Kumushrang" },
  { code: "BLUE", label: "Ko‘k" },
  { code: "DARK_BLUE", label: "To‘q ko‘k" },
  { code: "RED", label: "Qizil" },
  { code: "BURGUNDY", label: "To‘q qizil (bordo)" },
  { code: "YELLOW", label: "Sariq" },
  { code: "GREEN", label: "Yashil" },
  { code: "BROWN", label: "Jigarrang" },
  { code: "BEIGE", label: "Bej" },
  { code: "ORANGE", label: "To‘q sariq" },
  { code: "PURPLE", label: "Binafsha" },
];

// ===== Поиск водителя по телефону =====
async function findDriverByPhone(phoneRaw) {
  const normalizedPhone = normalizePhoneForYandex(phoneRaw);
  const cfg = ensureFleetConfigured();
  if (!cfg.ok) {
    return { ok: false, found: false, error: cfg.message };
  }

  const phoneDigits = (normalizedPhone || "").replace(/[^\d]/g, "");
  if (!phoneDigits) {
    return { ok: true, found: false };
  }

  const body = {
    limit: 1000,
    offset: 0,
    query: {
      park: { id: FLEET_PARK_ID },
    },
    fields: {
      driver_profile: ["id", "first_name", "last_name", "middle_name", "phones"],
    },
  };

  const res = await callFleetPost("/v1/parks/driver-profiles/list", body);
  if (!res.ok) {
    console.error("findDriverByPhone: fleet error:", res);
    return { ok: false, found: false, error: res.message };
  }

  const profiles = (res.data && res.data.driver_profiles) || [];
  if (!profiles.length) {
    return { ok: true, found: false };
  }

  for (const item of profiles) {
    const dp = (item && item.driver_profile) || {};
    const phonesRaw = [];

    if (Array.isArray(dp.phones)) {
      for (const p of dp.phones) {
        if (!p) continue;
        if (typeof p === "string") {
          phonesRaw.push(p);
        } else if (p.number || p.phone) {
          phonesRaw.push(p.number || p.phone);
        }
      }
    }

    for (const num of phonesRaw) {
      const numDigits = String(num).replace(/[^\d]/g, "");
      if (!numDigits) continue;

      if (
        numDigits === phoneDigits ||
        numDigits.endsWith(phoneDigits) ||
        phoneDigits.endsWith(numDigits)
      ) {
        const fullName =
          [dp.last_name, dp.first_name, dp.middle_name]
            .filter(Boolean)
            .join(" ") || null;
        const status =
          (item.current_status && item.current_status.status) || null;

        return {
          ok: true,
          found: true,
          driver: {
            id: dp.id || null,
            name: fullName,
            phone: num || normalizedPhone || phoneRaw,
            status,
          },
        };
      }
    }
  }

  return { ok: true, found: false };
}

// ====== Список "моих" водителей для хантера ======
async function listMyDriversForHunter(hunterChatId) {
  const cfg = ensureFleetConfigured();
  if (!cfg.ok) {
    return { ok: false, error: cfg.message };
  }

  const body = {
    limit: 500,
    offset: 0,
    query: {
      park: {
        id: FLEET_PARK_ID,
      },
    },
  };

  const res = await callFleetPost("/v1/parks/driver-profiles/list", body);
  if (!res.ok) {
    return { ok: false, error: res.message || "fleet error" };
  }

  const profiles = (res.data && res.data.driver_profiles) || [];
  const result = [];
  const marker = `chat_id=${hunterChatId}`;

  for (const item of profiles) {
    const dp = (item && item.driver_profile) || {};
    const profile = (item && item.profile) || {};
    const currentStatus = (item && item.current_status) || {};

    // 🔧 ИСПРАВЛЕНО: берём комментарий из driver_profile ИЛИ из profile
    const comment = (dp.comment || profile.comment || "").toString();

    if (comment.includes(marker)) {
      const phones = Array.isArray(dp.phones) ? dp.phones : [];
      let phone = null;
      if (phones.length) {
        phone = phones[0].number || phones[0].phone || null;
      }

      const fullName =
        [dp.last_name, dp.first_name, dp.middle_name]
          .filter(Boolean)
          .join(" ") || "—";

      result.push({
        id: dp.id || null,
        name: fullName,
        phone: phone,
        status: currentStatus.status || profile.work_status || "unknown",
      });
    }
  }

  return { ok: true, drivers: result };
}


// ================== upload-doc интеграция ==================
async function forwardDocToUploadDoc(message, meta) {
  if (!UPLOAD_DOC_URL) {
    console.error("forwardDocToUploadDoc: no UPLOAD_DOC_URL");
    return null;
  }

  const telegramUpdate = {
    message,
  };

  try {
    const res = await fetch(UPLOAD_DOC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "telegram_hunter_bot",
        telegram_update: telegramUpdate,
        meta: meta || {},
        previewOnly: true,
      }),
    });

    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}

    if (!res.ok) {
      console.error("forwardDocToUploadDoc failed:", res.status, text);
      return { ok: false, status: res.status, raw: text };
    }

    return json || { ok: true, raw: text };
  } catch (e) {
    console.error("forwardDocToUploadDoc exception:", e);
    return { ok: false, error: String(e) };
  }
}

// ================== GOOGLE SHEETS INTEGRATION ==================
// Бот шлёт JSON на твой Google Apps Script / backend,
// который сам пишет в защищённую Google Sheets.
//
// В Netlify нужно задать переменную:
//   GOOGLE_SHEETS_WEBHOOK_URL = "https://script.google.com/macros/s/.../exec"
const GOOGLE_SHEETS_WEBHOOK_URL =
  process.env.GOOGLE_SHEETS_WEBHOOK_URL || null;

/**
 * driverState:
 *   {
 *     driverId, carId, registeredAt,
 *     driverFullName, driverPhone,
 *     licenseSeries, licenseNumber,
 *     carPlate, carBrand, carModel,
 *     hunterChatId, hunterName,
 *     photoControlOk, selfEmploymentOk, committentOk,
 *     bonusGiven, bonusGivenAt
 *   }
 *
 * eventType: "registration" | "bonus"
 */
async function appendDriverToGoogleSheets(driverState, eventType = "registration") {
  if (!GOOGLE_SHEETS_WEBHOOK_URL) {
    console.log(
      "Google Sheets webhook URL is not set (GOOGLE_SHEETS_WEBHOOK_URL). Skipping append."
    );
    return;
  }
  if (!driverState) {
    console.warn("appendDriverToGoogleSheets called without driverState");
    return;
  }

  const payload = {
    eventType, // для удобства на стороне таблицы
    driverId: driverState.driverId || "",
    carId: driverState.carId || "",
    timestamp: driverState.registeredAt || new Date().toISOString(),

    driverFullName: driverState.driverFullName || "",
    driverPhone: driverState.driverPhone || "",
    licenseSeries: driverState.licenseSeries || "",
    licenseNumber: driverState.licenseNumber || "",

    carPlate: driverState.carPlate || "",
    carBrand: driverState.carBrand || "",
    carModel: driverState.carModel || "",

    hunterChatId: driverState.hunterChatId || "",
    hunterName: driverState.hunterName || "",

    // то, что ты просил в ТЗ
    photoControl: driverState.photoControlOk ? "Да" : "Нет",
    selfEmployment: driverState.selfEmploymentOk ? "Да" : "Нет",
    committent: driverState.committentOk ? "Да" : "Нет",
    bonusGiven: driverState.bonusGiven ? "Да" : "Нет",
    bonusGivenAt: driverState.bonusGivenAt || "",
  };

  try {
    const res = await fetch(GOOGLE_SHEETS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error("appendDriverToGoogleSheets error:", res.status, txt);
    }
  } catch (e) {
    console.error("appendDriverToGoogleSheets exception:", e);
  }
}
// ================== ASR PUL STATUS INTEGRATION ==================
//
// Сообщение от AsrPulBot вида:
// 🟢 КОМИТЕНТ
// ✅Водитель стал комитентом!
// ...
// 🌐 Посмотреть в Яндексе (https://fleet.yandex.uz/drivers/e13...bb/details?park_id=...)
async function handleAsrPulStatusMessage(msg) {
  if (!ASRPUL_STATUS_CHAT_ID) return;
  if (!msg || !msg.text) return;

  const text = msg.text;

  // Нас интересуют сообщения про комитента/самозанятость
  if (!text.includes("КОМИТЕНТ") && !text.includes("Комитент")) {
    return;
  }

  // Достаём driverId из ссылки "drivers/<id>/details"
  const linkMatch = text.match(
    /https?:\/\/\S*\/drivers\/([a-f0-9-]+)\/details\?park_id=/i
  );
  if (!linkMatch) {
    console.warn("AsrPul status message: cannot find driverId in text");
    return;
  }

  const driverId = linkMatch[1];

  try {
    const indexStore = getDriverIndexStore();
    if (!indexStore) return;

    const index = await indexStore.get(`driver:${driverId}`, { type: "json" });
    if (!index || !index.hunterChatId) {
      console.warn(
        "AsrPul status message: no hunterChatId for driverId",
        driverId
      );
      return;
    }

    const hunterChatId = index.hunterChatId;
    const hunter = await loadHunterFromStorage(hunterChatId);
    if (!hunter) {
      console.warn(
        "AsrPul status message: hunter not found for chatId",
        hunterChatId
      );
      return;
    }

    if (!hunter.drivers || typeof hunter.drivers !== "object") {
      hunter.drivers = {};
    }

    const existing = hunter.drivers[driverId] || {};
    const nowIso = new Date().toISOString();

    const driverState = {
      driverId,
      carId: existing.carId || "",
      registeredAt: existing.registeredAt || nowIso,

      driverFullName: existing.driverFullName || "",
      driverPhone: existing.driverPhone || "",

      licenseSeries: existing.licenseSeries || "",
      licenseNumber: existing.licenseNumber || "",

      carPlate: existing.carPlate || "",
      carBrand: existing.carBrand || "",
      carModel: existing.carModel || "",

      hunterChatId,
      hunterName: hunter.name || existing.hunterName || "",

      photoControlOk: existing.photoControlOk || false,

      // 🔹 главное: AsrPulBot подтвердил самозанятость и комитента
      selfEmploymentOk: true,
      committentOk: true,

      bonusGiven: existing.bonusGiven || false,
      bonusGivenAt: existing.bonusGivenAt || null,
      lastStatusCheckAt: nowIso,
    };

    hunter.drivers[driverId] = driverState;
    await saveHunterToStorage(hunter);

    // Отдельное событие в таблицу
    await appendDriverToGoogleSheets(driverState, "selfemployment_committent");

    console.log(
      "AsrPul status: selfEmploymentOk+committentOk set for driver",
      driverId,
      "hunter",
      hunterChatId
    );
  } catch (e) {
    console.error("handleAsrPulStatusMessage error:", e);
  }
}


// ================== FLOW: HUNTER START & MENU ==================
async function handleStart(chatId, session, from) {
  session.step = "waiting_hunter_contact";
  session.hunter = null;
  session.driverDraft = null;
  session.editField = null;

  const name = from?.first_name || "foydalanuvchi";

  const text =
    `👋 Assalomu alaykum, *${name}*!\n\n` +
    "Bu bot *ASR TAXI hunterlari* uchun mo‘ljallangan.\n\n" +
    "Ushbu bot orqali Siz haydovchilarni ro‘yxatdan o‘tkazishingiz va har bir haydovchi uchun " +
    "*Yandex Fleet* tizimida profil yaratishingiz mumkin.\n\n" +
    "Avval Sizning akkauntingizni bog‘laymiz:\n" +
    "iltimos, quyidagi tugma orqali *o‘zingizning telefon raqamingizni* yuboring.";

  await sendTelegramMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      keyboard: [
        [
          {
            text: "📲 Telefon raqamni yuborish",
            request_contact: true,
          },
        ],
      ],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

async function handleHunterContact(chatId, session, contact) {
  const phone = contact.phone_number;
  const tgName = `${contact.first_name || ""} ${
    contact.last_name || ""
  }`.trim();

  session.hunter = {
    chatId,
    phone,
    name: tgName || contact.first_name || "Ism ko‘rsatilmagan",
    username: contact.user_id ? contact.user_id : undefined,
    createdAt: new Date().toISOString(),
  };

  await saveHunterToStorage(session.hunter);

  session.step = "waiting_hunter_name";

  await sendTelegramMessage(
    chatId,
    "✅ Kontakt muvaffaqiyatli bog‘landi.\n\n" +
      "Endi iltimos, o‘zingizni *to‘liq ismingizni* kiriting (masalan, Ali Aliyev).\n" +
      "Bu ism siz ro‘yxatdan o‘tkazgan haydовchilar kartasida hunter sifatida ko‘rinadi.",
    { parse_mode: "Markdown" }
  );
}

// ================== ВОПРОСЫ ПРО АВТО (ЭТАП 2) ==================
async function askCarBrand(chatId, session) {
  session.step = "driver_car_brand";

  const rows = [];
  for (let i = 0; i < CAR_BRANDS.length; i += 2) {
    const row = [];
    const b1 = CAR_BRANDS[i];
    row.push({
      text: b1.label,
      callback_data: `car_brand:${b1.code}`,
    });
    if (CAR_BRANDS[i + 1]) {
      const b2 = CAR_BRANDS[i + 1];
      row.push({
        text: b2.label,
        callback_data: `car_brand:${b2.code}`,
      });
    }
    rows.push(row);
  }

  const text =
    "🚗 Avtomobil *brendini* quyidagi ro‘yxatdan tanlang.\n\n" +
    "Agar kerakli brend bo‘lmasa — eng yaqinini tanlang, operator keyin uni to‘g‘rilashi mumkin.";

  await sendTelegramMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: rows,
    },
  });
}

async function askCarModelForBrand(chatId, session) {
  const draft = session.driverDraft || (session.driverDraft = {});
  const brandCode = draft.carBrandCode;
  const brandLabel = draft.carBrandLabel || draft.carBrand;
  const models = CAR_MODELS_INDEX[brandCode] || [];

  session.step = "driver_car_model";

  if (!models.length) {
    await sendTelegramMessage(
      chatId,
      "Ushbu brend uchun ichki model ro‘yxati mavjud emas. " +
        "Model nomini keyinchalik park operatoriga aytishingiz mumkin."
    );
    await askCarColor(chatId, session);
    return;
  }

  const rows = [];
  for (let i = 0; i < models.length; i += 2) {
    const row = [];
    const m1 = models[i];
    row.push({
      text: m1.label,
      callback_data: `car_model:${brandCode}:${m1.code}`,
    });
    if (models[i + 1]) {
      const m2 = models[i + 1];
      row.push({
        text: m2.label,
        callback_data: `car_model:${brandCode}:${m2.code}`,
      });
    }
    rows.push(row);
  }

  const text =
    `🚗 Brend: *${brandLabel}*\n\n` +
    "Endi avtomobil *modelini* tanlang:";

  await sendTelegramMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: rows,
    },
  });
}

async function askCarColor(chatId, session) {
  session.step = "driver_car_color";

  const rows = [];
  for (let i = 0; i < CAR_COLORS.length; i += 2) {
    const row = [];
    const c1 = CAR_COLORS[i];
    row.push({ text: c1.label, callback_data: `car_color:${c1.code}` });
    if (CAR_COLORS[i + 1]) {
      const c2 = CAR_COLORS[i + 1];
      row.push({ text: c2.label, callback_data: `car_color:${c2.code}` });
    }
    rows.push(row);
  }

  const text =
    "🎨 Avtomobilning *rangini* tanlang.\n\n" +
    "Agar aniq rang bo‘lmasa — eng yaqinini tanlang, kerak bo‘lsa operator uni o‘zgartiradi.";

  await sendTelegramMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: rows,
    },
  });
}

async function askVuPhoto(chatId, session) {
  session.step = "driver_vu_front";
  const text =
    "2/3. 📄 Haydovchining *haydovchilik guvohnomasi (old tomoni)* fotosuratini yuboring.\n\n" +
    "Foto aniq bo‘lishi, ism-familiya va guvohnoma seriya/raqami hamda muddati yaxshi ko‘rinishi kerak.";
  await sendTelegramMessage(chatId, text, {
    parse_mode: "Markdown",
  });
}

async function askTechFrontPhoto(chatId, session) {
  session.step = "driver_tech_front";
  const text =
    "📄 Endi *texnik pasport (old tomoni)* fotosuratini yuboring.\n\n" +
    "Fotoda davlat raqami va avtomobil ma’lumotlari aniq ko‘rinishi lozim.";
  await sendTelegramMessage(chatId, text, { parse_mode: "Markdown" });
}

async function askTechBackPhoto(chatId, session) {
  session.step = "driver_tech_back";
  const text =
    "📄 Yana bir qadam – iltimos, *texnik pasportning orqa tomoni* fotosuratini yuboring.\n\n" +
    "Bu yerdan avtomobil ishlab chiqarilgan yili olinadi.";
  await sendTelegramMessage(chatId, text, { parse_mode: "Markdown" });
}

// ================== FLOW: DRIVER REGISTRATION (этап 1 — только водитель) ==================
async function beginDriverRegistration(chatId, session) {
  if (!session.hunter) {
    await sendTelegramMessage(
      chatId,
      "Birinchi navbatda o‘zingizning kontaktingizni bog‘lash kerak. /start buyrug‘ini yuboring va telefon raqamingizni ulashing."
    );
    session.step = "idle";
    return;
  }

  session.driverDraft = {
    flowType: "driver",
    hunterChatId: session.hunter.chatId,
    hunterPhone: session.hunter.phone,
    hunterName: session.hunter.name,
    createdAt: new Date().toISOString(),
  };
  session.editField = null;

  session.step = "driver_phone";

  await sendTelegramMessage(
    chatId,
    "➕ *Yangi haydovchini ro‘yxatdan o‘tkazish*\n\n" +
      "1/3. Haydovchining *telefon raqamini* istalgan qulay formatda yuboring.\n\n" +
      "Avval Yandex Fleet bazasida ushbu raqam bo‘yicha mavjud haydovchi bor-yo‘qligi tekshiriladi.",
    { parse_mode: "Markdown", reply_markup: registrationKeyboard() }
  );
}

async function handleDriverPhone(chatId, session, value) {
  const draft = session.driverDraft || (session.driverDraft = {});
  draft.driverPhone = value;

  await sendTelegramMessage(
    chatId,
    `📞 Haydovchi raqami: *${value}*\n\nYandex Fleet bazasida tekshirilyapti...`,
    { parse_mode: "Markdown" }
  );

  const found = await findDriverByPhone(value);

  if (!found.ok) {
    await sendTelegramMessage(
      chatId,
      "⚠️ Yandex Fleet bilan bog‘lanishda xato yuz berdi, raqamni tekshirish imkoni bo‘lmadi.\n" +
        "Ro‘yxatdan o‘tkazish *yangi haydovchi* sifatida davom ettiriladi."
    );
  } else if (found.found && found.driver) {
    await sendTelegramMessage(
      chatId,
      "✅ Ushbu telefon raqami bo‘yicha haydovchi allaqachon Yandex Fleet bazasida mavjud.\n\n" +
        `Ism: *${found.driver.name || "ko‘rsatilmagan"}*\n` +
        `Bazadagi telefon: *${found.driver.phone || value}*\n` +
        `Holat: ${found.driver.status || "unknown"}\n\n` +
        "Bunday haydovchini qayta ro‘yxatdan o‘tkazish talab etilmaydi.\n" +
        "Menyu asosiy bo‘limiga qaytdingiz.",
      { parse_mode: "Markdown" }
    );

    await sendOperatorAlert(
      "🟡 Попытка повторно зарегистрировать водителя через hunter-бот\n\n" +
        `👤 Хантер: ${session.hunter.name} (chat_id: ${session.hunter.chatId})\n` +
        `📞 Телефон водителя: ${value}\n` +
        `Имя в Fleet: ${found.driver.name || "—"}\n` +
        `Driver ID в Fleet: ${found.driver.id || "—"}\n` +
        `Текущий статус в Fleet: ${found.driver.status || "unknown"}`
    );

    session.driverDraft = null;
    session.step = "main_menu";
    await sendTelegramMessage(
      chatId,
      "Iltimos, menyudan kerakli bo‘limni tanlang.",
      {
        reply_markup: mainMenuKeyboard(),
      }
    );
    return;
  }

  await askVuPhoto(chatId, session);
}

// ================== ПРЕДПРОСМОТР И РЕДАКТИРОВАНИЕ ПОЛЕЙ ==================
function buildDriverDraftSummaryText(draft) {
  const flowType = draft.flowType || "driver";
  const lines = [];

  if (flowType === "car") {
    lines.push(
      "📋 *Avtomobil ma’lumotlarini parkka yuborishdan oldin tekshiring:*"
    );
    lines.push("");
    lines.push(`👤 Haydovchi: ${draft.driverFullName || "—"}`);
    lines.push(`📞 Telefon: ${draft.driverPhone || "—"}`);
    lines.push("");
    lines.push(
      `🚗 Avto: ${draft.carBrand || ""} ${draft.carModel || ""} (${
        draft.carYear || "yili ko‘rsatilmagan"
      })`
    );
    lines.push(`Davlat raqami: ${draft.carPlate || "—"}`);
    lines.push(`Rang: ${draft.carColor || "—"}`);
    lines.push("");
    lines.push(
      "Agar biror ma’lumot noto‘g‘ri aniqlangan bo‘lsa, quyidagi tugmalar orqali kerakli maydonni tanlab, to‘g‘rilashingiz mumkin."
    );
    return lines.join("\n");
  }

  lines.push(
    "📋 *Parkka yuborishdan oldin haydovchi ma’lumotlarini tekshiring:*"
  );
  lines.push("");
  lines.push(`👤 F.I.Sh.: ${draft.driverFullName || "—"}`);
  lines.push(`📞 Telefon: ${draft.driverPhone || "—"}`);
    lines.push(`PINFL: ${draft.driverPinfl || "—"}`);
  const licLine =
    `${draft.licenseSeries || ""} ${draft.licenseNumber || ""}`.trim() || "—";
  lines.push(`Haydovchilik guvohnomasi: ${licLine}`);
  lines.push(
    `Guvohnoma muddati: ${draft.licenseIssuedDate || "—"} → ${
      draft.licenseExpiryDate || "—"
    }`
  );
  lines.push("");
  lines.push(
    "Agar biror ma’lumot noto‘g‘ri aniqlangan bo‘lsa, quyidagi tugmalar orqali kerakli maydonni tanlab, to‘g‘rilashingiz mumkin."
  );
  return lines.join("\n");
}

function buildDriverConfirmKeyboard(flowType) {
  if (flowType === "car") {
    return {
      inline_keyboard: [
        [
          {
            text: "✏️ Marka / model / rang",
            callback_data: "edit_car_brand_model",
          },
        ],
        [
          { text: "✏️ Avto yili", callback_data: "edit:carYear" },
          { text: "✏️ Davlat raqami", callback_data: "edit:carPlate" },
        ],
        [
          {
            text: "✅ Hammasi to‘g‘ri, parkka yuborish",
            callback_data: "confirm_driver",
          },
        ],
      ],
    };
  }

  return {
    inline_keyboard: [
      [
        { text: "✏️ F.I.Sh.", callback_data: "edit:driverFullName" },
        { text: "✏️ Telefon", callback_data: "edit:driverPhone" },
      ],
      [
        {
          text: "✏️ VU seriya/raqam",
          callback_data: "edit:licenseSeriesNumber",
        },
      ],
      [
        {
          text: "✏️ PINFL",
          callback_data: "edit:driverPinfl",
        },
      ],
      [
        {
          text: "✅ Hammasi to‘g‘ri, parkka yuborish",
          callback_data: "confirm_driver",
        },
      ],
    ],
  };
}

async function showDriverSummaryForConfirm(chatId, session) {
  const draft = session.driverDraft;
  if (!draft) {
    await sendTelegramMessage(
      chatId,
      "Haydovchi bo‘yicha ma’lumotlar topilmadi. Iltimos, menyudan qaytadan ro‘yxatdan o‘tkazishni boshlang."
    );
    session.step = "main_menu";
    return;
  }

  session.step = "driver_confirm";
  session.editField = null;

  const text = buildDriverDraftSummaryText(draft);
  await sendTelegramMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: buildDriverConfirmKeyboard(draft.flowType || "driver"),
  });
}

async function handleEditFieldText(chatId, session, value) {
  const draft = session.driverDraft || (session.driverDraft = {});
  const field = session.editField;
  const v = (value || "").trim();

  if (!field) {
    session.step = "driver_confirm";
    await showDriverSummaryForConfirm(chatId, session);
    return;
  }

  switch (field) {
    case "driverFullName": {
      draft.driverFullName = v;
      const parts = v.split(/\s+/);
      draft.driverLastName = parts[0] || "";
      draft.driverFirstName = parts[1] || "";
      draft.driverMiddleName = parts.slice(2).join(" ") || "";
      break;
    }
    case "driverPhone": {
      draft.driverPhone = v;
      break;
    }
    case "carYear": {
      draft.carYear = v.replace(/[^\d]/g, "");
      break;
    }
    case "carPlate": {
      draft.carPlate = v;
      break;
    }
    case "licenseSeriesNumber": {
      const raw = v.toUpperCase().replace(/[^A-ZА-ЯЁ0-9]/g, "");
      const matchLetters = raw.match(/^[A-ZА-ЯЁ]{1,3}/);
      const letters = matchLetters ? matchLetters[0] : "";
      const digits = raw.slice(letters.length).replace(/\D/g, "");

      if (letters) draft.licenseSeries = letters;
      if (digits) draft.licenseNumber = digits;

      const full = `${draft.licenseSeries || ""}${draft.licenseNumber || ""}`.trim();
      if (full) draft.licenseFull = full;
      break;
    }
        // 🔹 NEW: ручное исправление PINFL
    case "driverPinfl": {
      const digits = v.replace(/\D/g, "");
      draft.driverPinfl = digits;

      if (digits.length !== 14) {
        await sendTelegramMessage(
          chatId,
          "⚠️ PINFL odatda *14 ta raqamdan* iborat bo‘ladi. Siz kiritgan qiymat uzunligi boshqacha.\n" +
            "Agar bu haqiqiy PINFL bo‘lsa, davom etishingiz mumkin, aks holda uni qaytadan to‘g‘rilang.",
          { parse_mode: "Markdown" }
        );
      }
      break;
    }
    default:
      break;
  }

  session.step = "driver_confirm";
  session.editField = null;

  await sendTelegramMessage(
    chatId,
    "✅ Maydon yangilandi. Iltimos, ma’lumotlarni yana bir bor tekshiring:"
  );
  await showDriverSummaryForConfirm(chatId, session);
}

// обработка текстовых шагов
async function handleDriverStep(chatId, session, text) {
  const draft = session.driverDraft || (session.driverDraft = {});
  const value = (text || "").trim();

  switch (session.step) {
    case "driver_phone": {
      await handleDriverPhone(chatId, session, value);
      break;
    }

    case "driver_car_brand_model": {
      const parts = value.split(/\s+/);
      draft.carBrand = parts[0] || "";
      draft.carModel = parts.slice(1).join(" ") || "";
      draft.carBrandCode = null;
      draft.carModelCode = null;
      draft.carBrandLabel = draft.carBrand;
      draft.carModelLabel = draft.carModel;
      await askCarColor(chatId, session);
      break;
    }

    case "driver_car_year": {
      draft.carYear = value.replace(/[^\d]/g, "");
      session.step = "driver_car_plate";
      await sendTelegramMessage(
        chatId,
        "Avtomobilning *ishlab chiqarilgan yilini* kiritdingiz.\nEndi *davlat raqamini* yuboring (masalan, 01A123BC).",
        { parse_mode: "Markdown" }
      );
      break;
    }

    case "driver_car_plate": {
      draft.carPlate = value;
      await showDriverSummaryForConfirm(chatId, session);
      break;
    }

    case "driver_car_color": {
      draft.carColor = value;
      await askTechFrontPhoto(chatId, session);
      break;
    }

    default: {
      session.step = "main_menu";
      await sendTelegramMessage(
        chatId,
        "Ro‘yxatdan o‘tkazish bosqichlarida xatolik yuz berdi. Iltimos, menyudan qaytadan boshlang.",
        { reply_markup: mainMenuKeyboard() }
      );
      break;
    }
  }
}

// ================== ОБРАБОТКА ФОТО ВУ (ЭТАП 1) ==================
async function handleDriverVuPhoto(update, session) {
  const msg =
    update.message ||
    update.edited_message ||
    update.channel_post ||
    update.edited_channel_post;

  const chatId = msg.chat.id;
  const draft = session.driverDraft || (session.driverDraft = {});

  let fileId = null;
  if (Array.isArray(msg.photo) && msg.photo.length) {
    fileId = msg.photo[msg.photo.length - 1].file_id;
  } else if (
    msg.document &&
    msg.document.mime_type &&
    msg.document.mime_type.startsWith("image/")
  ) {
    fileId = msg.document.file_id;
  }

  if (!fileId) {
    await sendTelegramMessage(
      chatId,
      "Faylni olish imkoni bo‘lmadi. Iltimos, haydovchilik guvohnomasining fotosuratini qayta yuboring."
    );
    return;
  }

  await sendTelegramMessage(
    chatId,
    "✅ Haydovchilik guvohnomasi fotosurati qabul qilindi. Ma’lumotlar o‘qilmoqda, bu jarayon biroz vaqt olishi mumkin..."
  );

  const meta = {
    tg_id: chatId,
    hunter_chat_id: session.hunter?.chatId,
    hunter_phone: session.hunter?.phone,
    driver_phone: draft.driverPhone,
    docType: "vu_front",
  };

  const resp = await forwardDocToUploadDoc(msg, meta);

  if (!resp || resp.ok === false) {
    await sendTelegramMessage(
      chatId,
      "❗ Fotosuratdan ma’lumotlarni o‘qish imkoni bo‘lmadi. Iltimos, yanada aniqroq, yoritish yaxshi bo‘lgan fotosurat yuboring va qayta urinib ko‘ring."
    );
    return;
  }

  let parsedDoc = null;
  if (resp.mode === "single" && resp.doc) {
    parsedDoc = resp.doc;
  } else if (resp.doc) {
    parsedDoc = resp.doc;
  }

  if (!parsedDoc || !parsedDoc.result || !parsedDoc.result.parsed) {
    await sendTelegramMessage(
      chatId,
      "Fotosuratdagi matnni aniqlashning imkoni bo‘lmadi. Iltimos, guvohnoma rasmini yirikroq va ravshan ko‘rinishda qayta yuboring."
    );
    return;
  }

  const fields = parsedDoc.result.parsed.fields || {};

  draft.vuFrontFileId = fileId;

  // 🔹 NEW: сохраняем ПИНФЛ водителя из ВУ (поле 4d)
  if (fields.driver_pinfl) {
    const pinflDigits = String(fields.driver_pinfl).replace(/\D/g, "");
    if (pinflDigits) {
      // по стандарту 14 цифр, но если что-то не так — всё равно сохраним,
      // а длину можно контролировать логами
      draft.driverPinfl = pinflDigits;
      if (pinflDigits.length !== 14) {
        console.warn(
          "hunter-bot: driver_pinfl length is not 14:",
          fields.driver_pinfl,
          "->",
          pinflDigits
        );
      }
    }
  }

  if (fields.driver_name) {
    draft.driverFullName = fields.driver_name;
    const parts = String(fields.driver_name).trim().split(/\s+/);
    draft.driverLastName = parts[0] || "";
    draft.driverFirstName = parts[1] || "";
    draft.driverMiddleName = parts.slice(2).join(" ") || "";
  }


  if (fields.license_series) draft.licenseSeries = fields.license_series;
  if (fields.license_number) draft.licenseNumber = fields.license_number;
  if (fields.license_full) draft.licenseFull = fields.license_full;

  if (fields.issued_date) draft.licenseIssuedDate = fields.issued_date;
  if (fields.expiry_date) draft.licenseExpiryDate = fields.expiry_date;

  const lines = [];
  lines.push(
    "📄 *Haydovchilik guvohnomasidan quyidagi ma’lumotlar aniqlandi:*"
  );
  lines.push("");
  lines.push(`F.I.Sh.: ${draft.driverFullName || "—"}`);
  const licLine =
    `${draft.licenseSeries || ""} ${draft.licenseNumber || ""}`.trim() || "—";
  lines.push(`Guvohnoma: ${licLine}`);
  lines.push(
    `Guvohnoma muddati: ${draft.licenseIssuedDate || "—"} → ${
      draft.licenseExpiryDate || "—"
    }`
  );
  lines.push("");
  lines.push(
    "Agar seriya yoki raqam xato bo‘lsa, tasdiqlash bosqichida ularni qo‘lda to‘g‘rilashingiz mumkin."
  );

  await sendTelegramMessage(chatId, lines.join("\n"), {
    parse_mode: "Markdown",
  });

  await showDriverSummaryForConfirm(chatId, session);
}

// ================== ОБРАБОТКА ФОТО ТЕХПАСПОРТА (ЭТАП 2) ==================
async function handleTechFrontPhoto(update, session) {
  const msg =
    update.message ||
    update.edited_message ||
    update.channel_post ||
    update.edited_channel_post;

  const chatId = msg.chat.id;
  const draft = session.driverDraft || (session.driverDraft = {});

  let fileId = null;
  if (Array.isArray(msg.photo) && msg.photo.length) {
    fileId = msg.photo[msg.photo.length - 1].file_id;
  } else if (
    msg.document &&
    msg.document.mime_type &&
    msg.document.mime_type.startsWith("image/")
  ) {
    fileId = msg.document.file_id;
  }

  if (!fileId) {
    await sendTelegramMessage(
      chatId,
      "Faylni olish imkoni bo‘lmadi. Iltimos, texnik pasportning old tomoni fotosuratini qayta yuboring."
    );
    return;
  }

  await sendTelegramMessage(
    chatId,
    "✅ Texnik pasport (old tomoni) fotosurati qabul qilindi. Ma’lumotlar o‘qilmoqda..."
  );

  const meta = {
    tg_id: chatId,
    hunter_chat_id: session.hunter?.chatId,
    hunter_phone: session.hunter?.phone,
    driver_phone: draft.driverPhone,
    docType: "tech_front",
  };

  const resp = await forwardDocToUploadDoc(msg, meta);

  if (!resp || resp.ok === false) {
    await sendTelegramMessage(
      chatId,
      "❗ Texnik pasportdan ma’lumotlarni o‘qish imkoni bo‘lmadi. Keyingi bosqichda kerakli maydonlarni qo‘lda kiritishingiz mumkin."
    );
    session.step = "driver_car_year";
    await sendTelegramMessage(
      chatId,
      "Iltimos, avtomobilning *ishlab chiqarilgan yilini* yuboring (masalan, 2019).",
      { parse_mode: "Markdown" }
    );
    return;
  }

  let parsedDoc = null;
  if (resp.mode === "single" && resp.doc) {
    parsedDoc = resp.doc;
  } else if (resp.doc) {
    parsedDoc = resp.doc;
  }

  if (!parsedDoc || !parsedDoc.result || !parsedDoc.result.parsed) {
    await sendTelegramMessage(
      chatId,
      "Texnik pasport fotosuratidagi matnni aniqlash imkoni bo‘lmadi. Ma’lumotlarni qo‘lda kiritish kerak bo‘ladi."
    );
    session.step = "driver_car_year";
    await sendTelegramMessage(
      chatId,
      "Iltimos, avtomobilning *ishlab chiqarilgan yilini* yuboring (masalan, 2019).",
      { parse_mode: "Markdown" }
    );
    return;
  }

  draft.techFrontFileId = fileId;
  const fields = parsedDoc.result.parsed.fields || {};

  if (fields.plate_number && !draft.carPlate) {
    draft.carPlate = fields.plate_number;
  }

  const lines = [];
  lines.push("📄 *Texnik pasport (old tomoni):*");
  lines.push(`Davlat raqami: ${draft.carPlate || fields.plate_number || "—"}`);
  lines.push(
    `Hujjat bo‘yicha model: ${fields.car_model_text || "—"} (botda: ${
      draft.carBrand || ""
    } ${draft.carModel || ""})`
  );

  await sendTelegramMessage(chatId, lines.join("\n"), {
    parse_mode: "Markdown",
  });

  await askTechBackPhoto(chatId, session);
}

async function handleTechBackPhoto(update, session) {
  const msg =
    update.message ||
    update.edited_message ||
    update.channel_post ||
    update.edited_channel_post;

  const chatId = msg.chat.id;
  const draft = session.driverDraft || (session.driverDraft = {});

  let fileId = null;
  if (Array.isArray(msg.photo) && msg.photo.length) {
    fileId = msg.photo[msg.photo.length - 1].file_id;
  } else if (
    msg.document &&
    msg.document.mime_type &&
    msg.document.mime_type.startsWith("image/")
  ) {
    fileId = msg.document.file_id;
  }

  if (!fileId) {
    await sendTelegramMessage(
      chatId,
      "Faylni olish imkoni bo‘lmadi. Iltimos, texnik pasportning orqa tomoni fotosuratini qayta yuboring."
    );
    return;
  }

  await sendTelegramMessage(
    chatId,
    "✅ Texnik pasport (orqa tomoni) fotosurati qabul qilindi. Ma’lumotlar o‘qilmoqda..."
  );

  const meta = {
    tg_id: chatId,
    hunter_chat_id: session.hunter?.chatId,
    hunter_phone: session.hunter?.phone,
    driver_phone: draft.driverPhone,
    docType: "tech_back",
  };

  const resp = await forwardDocToUploadDoc(msg, meta);

  if (!resp || resp.ok === false) {
    await sendTelegramMessage(
      chatId,
      "❗ Texnik pasportning orqa tomonidan ma’lumotlarni o‘qish imkoni bo‘lmadi. Iltimos, park operatoridan ma’lumotlarni qo‘lda tekshirishni so‘rang."
    );
    await showDriverSummaryForConfirm(chatId, session);
    return;
  }

  let parsedDoc = null;
  if (resp.mode === "single" && resp.doc) {
    parsedDoc = resp.doc;
  } else if (resp.doc) {
    parsedDoc = resp.doc;
  }

  if (!parsedDoc || !parsedDoc.result || !parsedDoc.result.parsed) {
    await sendTelegramMessage(
      chatId,
      "Fotosuratdan matnni aniqlash imkoni bo‘lmadi. Iltimos, park operatoridan ma’lumotlarni qo‘lda tekshirishni so‘rang."
    );
    await showDriverSummaryForConfirm(chatId, session);
    return;
  }

  draft.techBackFileId = fileId;
  const fields = parsedDoc.result.parsed.fields || {};

  if (fields.car_year && !draft.carYear) {
    draft.carYear = fields.car_year;
  }

  const lines = [];
  lines.push("📄 *Texnik pasport (orqa tomoni):*");
  lines.push(`Avtomobil ishlab chiqarilgan yili: ${draft.carYear || "—"}`);

  await sendTelegramMessage(chatId, lines.join("\n"), {
    parse_mode: "Markdown",
  });

  await showDriverSummaryForConfirm(chatId, session);
}

// ================== СОЗДАНИЕ ВОДИТЕЛЯ (этап 1) ==================
async function createDriverInFleetForHunter(draft) {
  const cfg = ensureFleetConfigured();
  if (!cfg.ok) return { ok: false, error: cfg.message };

  const workRuleId = FLEET_WORK_RULE_ID_HUNTER;

  if (!workRuleId) {
    return {
      ok: false,
      error:
        "Hunter uchun ish qoidasi ko‘rsatilmagan (FLEET_WORK_RULE_ID_HUNTER).",
      code: "work_rule_missing",
    };
  }

  const phoneNorm = normalizePhoneForYandex(draft.driverPhone);
  const todayIso = new Date().toISOString().slice(0, 10);

  const fioParts = String(draft.driverFullName || "")
    .trim()
    .split(/\s+/);
  const lastName = draft.driverLastName || fioParts[0] || "";
  const firstName = draft.driverFirstName || fioParts[1] || "";
  const middleName =
    draft.driverMiddleName || fioParts.slice(2).join(" ") || undefined;

  const issuedISO = normalizeDateToISO(draft.licenseIssuedDate);
  const expiryISO = normalizeDateToISO(draft.licenseExpiryDate);

  const countryCode = (FLEET_DEFAULT_LICENSE_COUNTRY || "UZB").toUpperCase();
  const licenseFullCombined = `${draft.licenseSeries || ""}${
    draft.licenseNumber || ""
  }`.trim();

  const driverLicenseNumber = normalizeDriverLicenseNumber(
    countryCode,
    draft.licenseSeries,
    draft.licenseNumber,
    licenseFullCombined || draft.licenseFull
  );

  let license = undefined;
  if (driverLicenseNumber) {
    license = {
      number: driverLicenseNumber,
      country: countryCode,
      issue_date: issuedISO,
      expiry_date: expiryISO,
      birth_date: undefined,
    };
  }

  const totalSince = issuedISO || expiryISO || "2005-01-01";

  let employmentType =
    (FLEET_DEFAULT_EMPLOYMENT_TYPE || "selfemployed").toLowerCase();
  if (employmentType !== "selfemployed" && employmentType !== "individual") {
    employmentType = "selfemployed";
  }

  const account = {
    balance_limit: "5000",
    block_orders_on_balance_below_limit: false,
    work_rule_id: workRuleId,
  };

  if (FLEET_PAYMENT_SERVICE_ID) {
    account.payment_service_id = FLEET_PAYMENT_SERVICE_ID;
  }

  const fullName = {
    first_name: firstName,
    last_name: lastName,
  };
  if (middleName) {
    fullName.middle_name = middleName;
  }

  // 🔹 NEW: берём ПИНФЛ из драфта и готовим к отправке как TIN
  let tinDigits = null;
  if (draft.driverPinfl) {
    tinDigits = String(draft.driverPinfl).replace(/\D/g, "");
  } else if (draft.driver_pinfl) {
    // на всякий случай, если где-то в будущем поле попадёт под таким именем
    tinDigits = String(draft.driver_pinfl).replace(/\D/g, "");
  }
  if (tinDigits && !tinDigits.length) {
    tinDigits = null;
  }
  if (!tinDigits) {
    console.warn(
      "createDriverInFleetForHunter: no PINFL/tax_identification_number in draft for phone",
      draft.driverPhone
    );
  }

  const person = {
    full_name: fullName,
    contact_info: phoneNorm
      ? {
          phone: phoneNorm,
        }
      : undefined,
    driver_license: license,
    driver_license_experience: {
      total_since_date: totalSince,
    },
    employment_type: employmentType,
  };

  // 🔹 NEW: если ПИНФЛ есть — передаём его как tax_identification_number (TIN)
  if (tinDigits) {
    person.tax_identification_number = tinDigits;
  }


  const body = {
    account,
    order_provider: {
      partner: true,
      platform: true,
    },
    person,
    profile: {
      hire_date: todayIso,
      work_status: "working",
      comment: `Hunter: ${draft.hunterName || ""} (chat_id=${
        draft.hunterChatId || ""
      })`,
    },
  };

  const idempotencyKey = makeIdempotencyKey("hunter-driver");

  const res = await callFleetPostIdempotent(
    "/v2/parks/contractors/driver-profile",
    body,
    idempotencyKey
  );

  if (!res.ok) {
    return {
      ok: false,
      error: res.message || "Haydovchini yaratishda xatolik yuz berdi",
      raw: res.raw,
      errorCode: (res.raw && res.raw.code) || null,
      status: res.status || null,
    };
  }

  const data = res.data || {};

  let driverId =
    // 1) стандартные варианты
    data.id ||
    data.driver_profile_id ||
    // 2) тот самый contractor_profile_id, который сейчас приходит
    data.contractor_profile_id ||
    // 3) вложенные структуры на всякий случай
    (data.driver_profile &&
      (data.driver_profile.id ||
        data.driver_profile.driver_profile_id ||
        data.driver_profile.contractor_profile_id)) ||
    (data.profile &&
      (data.profile.id ||
        data.profile.driver_profile_id ||
        data.profile.contractor_profile_id)) ||
    (data.contractor_profile &&
      (data.contractor_profile.id ||
        data.contractor_profile.driver_profile_id ||
        data.contractor_profile.contractor_profile_id)) ||
    null;



  if (!driverId) {
    const lookup = await findDriverByPhone(draft.driverPhone);
    if (lookup.ok && lookup.found && lookup.driver && lookup.driver.id) {
      return {
        ok: true,
        driverId: lookup.driver.id,
        raw: data,
        alreadyExisted: true,
      };
    }

    return {
      ok: false,
      error: "Yandex Fleet haydovchi identifikatorini (id) qaytarmadi",
      raw: data,
      code: "driver_id_missing",
    };
  }

  return { ok: true, driverId, raw: data, alreadyExisted: false };
}

// ===== Создание авто в Fleet (этап 2) =====
async function createCarInFleetForHunter(draft) {
  const cfg = ensureFleetConfigured();
  if (!cfg.ok) return { ok: false, error: cfg.message };

  const yearInt = parseInt(draft.carYear, 10);
  const nowYear = new Date().getFullYear();
  if (!yearInt || yearInt < 1980 || yearInt > nowYear + 1) {
    return {
      ok: false,
      error:
        "Avtomobil ishlab chiqarilgan yili noto‘g‘ri aniqlangan yoki ruxsat etilgan chegaradan tashqarida. Avtomobilni avtomatik yaratib bo‘lmaydi.",
      code: "car_year_invalid",
    };
  }

  if (!draft.carPlate) {
    return {
      ok: false,
      error:
        "Davlat raqami ko‘rsatilmagan. Davlat raqamisiz avtomobilni avtomatik yaratib bo‘lmaydi.",
      code: "plate_missing",
    };
  }

  const brand = draft.carBrand || "";
  const model = draft.carModel || "";
  const yandexColor = mapColorToYandexFromText(draft.carColor);

  const vehicleSpecifications = {
    brand,
    model,
    color: yandexColor,
    year: yearInt,
    transmission: FLEET_DEFAULT_TRANSMISSION || "automatic",
  };

  const phoneDigits = String(draft.driverPhone || "").replace(/[^\d]/g, "");
  const callSign = phoneDigits.slice(-7) || undefined;

const parkProfile = {
  callsign: callSign,
  status: "working",
  categories: ["econom"],
  fuel_type: FLEET_DEFAULT_FUEL_TYPE || "petrol",
  // НЕ отправляем ownership_type и is_park_property,
  // чтобы не триггерить ошибку "not rental car"
};


  const vehicleLicenses = {
    licence_plate_number: draft.carPlate,
  };

  const idempotencyKey = makeIdempotencyKey("hunter-car");

  const body = {
    park_profile: parkProfile,
    vehicle_licenses: vehicleLicenses,
    vehicle_specifications: vehicleSpecifications,
  };

  const res = await callFleetPostIdempotent(
    "/v2/parks/vehicles/car",
    body,
    idempotencyKey
  );

  if (!res.ok) {
    return {
      ok: false,
      error: res.message || "Avtomobilni yaratishda xatolik yuz berdi",
      raw: res.raw,
      status: res.status || null,
      code: (res.raw && res.raw.code) || null,
    };
  }

  const data = res.data || {};
  const carId = data.vehicle_id || data.id || null;

  if (!carId) {
    return {
      ok: false,
      error: "Yandex Fleet avtomobil identifikatorini (id) qaytarmadi",
      raw: data,
      code: "car_id_missing",
    };
  }

  return { ok: true, carId, raw: data };
}

// ================== ФИНАЛИЗАЦИЯ РЕГИСТРАЦИИ ВОДИТЕЛЯ (этап 1) ==================
async function finalizeDriverRegistration(chatId, session) {
  const draft = session.driverDraft;
  if (!draft) {
    await sendTelegramMessage(
      chatId,
      "Haydovchi bo‘yicha ma’lumotlar topilmadi. Iltimos, menyudan qaytadan ro‘yxatdan o‘tkazishni boshlang."
    );
    session.step = "main_menu";
    return;
  }

  await sendTelegramMessage(
    chatId,
    "⏳ Haydovchini Yandex Fleet tizimida ro‘yxatdan o‘tkazish jarayoni (avtomobilsiz) boshlandi.\n" +
      "Bu bir necha soniya davom etishi mumkin."
  );

  const driverRes = await createDriverInFleetForHunter(draft);

  if (!driverRes.ok) {
    if (driverRes.errorCode === "duplicate_driver_license") {
      await sendTelegramMessage(
        chatId,
        "❗ Ushbu haydovchilik guvohnomasi bo‘yicha haydovchi Yandex Fleet bazasida allaqachon mavjud.\n\n" +
          "Ehtimol, u ilgari ro‘yxatdan o‘tkazilgan. Iltimos, guvohnoma seriyasi va raqamini park operatoriga yuboring, " +
          "u mavjud haydovchini kerakli hunter bilan bog‘lab qo‘yishi mumkin."
      );
    } else {
      await sendTelegramMessage(
        chatId,
        "❗ Haydovchini Yandex Fleet tizimida avtomatik ro‘yxatdan o‘tkazish imkoni bo‘lmadi.\n" +
          "Iltimos, ushbu xabar skrinshotini park operatoriga yuboring."
      );
    }

    await sendOperatorAlert(
      "❌ Не удалось автоматически создать водителя в Yandex Fleet (этап 1 — без авто)\n\n" +
        `👤 Хантер: ${draft.hunterName} (chat_id: ${draft.hunterChatId})\n` +
        `📞 Телефон водителя: ${draft.driverPhone || "—"}\n\n` +
        `Описание ошибки: ${driverRes.error || "не указано"}\n` +
        `HTTP-статус Fleet: ${driverRes.status ?? "—"}\n` +
        `Код Fleet: ${
          (driverRes.raw && driverRes.raw.code) || driverRes.errorCode || "—"
        }\n` +
        `Сообщение Fleet: ${
          (driverRes.raw && driverRes.raw.message) || "—"
        }`
    );

   // 🔹 НОВОЕ: кнопка "Попробовать снова"
    await sendTelegramMessage(
      chatId,
      "Agar xato texnik bo‘lsa, quyidagi tugma orqali ro‘yxatdan o‘tishni qaytadan boshlashingiz mumkin.",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔁 Qayta urinib ko‘rish",
                callback_data: "restart_registration",
              },
            ],
          ],
        },
      }
    );

    session.step = "main_menu";
    session.driverDraft = null;
    await sendTelegramMessage(
      chatId,
      "Asosiy menyuga qaytdingiz. Kerak bo‘lsa, haydovchini qayta ro‘yxatdan o‘tkazishni boshlashingiz mumkin.",
      {
        reply_markup: mainMenuKeyboard(),
      }
    );
    return;
  }

  const driverId = driverRes.driverId;



  const summaryLines = [];
  summaryLines.push("🎉 *Haydovchi muvaffaqiyatli ro‘yxatdan o‘tkazildi!*");
  summaryLines.push("");
  summaryLines.push(`👤 F.I.Sh.: ${draft.driverFullName || "—"}`);
  summaryLines.push(`📞 Telefon: ${draft.driverPhone || "—"}`);
  const licLineFinal =
    `${draft.licenseSeries || ""} ${draft.licenseNumber || ""}`.trim();
  summaryLines.push(
    `Haydovchilik guvohnomasi: ${
      licLineFinal || "Seriya/raqam ko‘rsatilmagan"
    }`
  );
  summaryLines.push(
    `Guvohnoma muddati: ${draft.licenseIssuedDate || "—"} → ${
      draft.licenseExpiryDate || "—"
    }`
  );
  summaryLines.push("");
  summaryLines.push(`Haydovchi ID (Fleet): ${driverId || "olib bo‘linmadi"}`);
  summaryLines.push("");
  summaryLines.push(
    "Endi ushbu haydovchi uchun *avtomobil ma’lumotlarini* kiritamiz."
  );

  await sendTelegramMessage(chatId, summaryLines.join("\n"), {
    parse_mode: "Markdown",
  });

  const operatorHeader = driverRes.alreadyExisted
    ? "🟢 Водитель найден/актуализирован в Yandex Fleet через hunter-бот (этап 1 — без авто)\n\n"
    : "✅ Новый водитель зарегистрирован через hunter-бот (этап 1 — без авто)\n\n";

  await sendOperatorAlert(
    operatorHeader +
      `👤 Хантер: ${draft.hunterName} (chat_id: ${draft.hunterChatId})\n` +
      `📞 Телефон водителя: ${draft.driverPhone || "—"}\n` +
      `Driver ID в Fleet: ${driverId || "—"}`
  );

  draft.flowType = "car";
  draft.driverIdForCar = driverId;

  await askCarBrand(chatId, session);
}

// ================== ФИНАЛИЗАЦИЯ ДОБАВЛЕНИЯ АВТО (этап 2) ==================
async function finalizeCarRegistration(chatId, session) {
  const draft = session.driverDraft;
  if (!draft) {
    await sendTelegramMessage(
      chatId,
      "Avtomobil bo‘yicha ma’lumotlar topilmadi. Iltimos, menyudan qaytadan avtomobil qo‘shishni boshlang."
    );
    session.step = "main_menu";
    return;
  }

  let driverId = draft.driverIdForCar || null;

  if (!driverId && draft.driverPhone) {
    const lookup = await findDriverByPhone(draft.driverPhone);
    if (lookup.ok && lookup.found && lookup.driver && lookup.driver.id) {
      driverId = lookup.driver.id;
    }
  }

  if (!driverId) {
    await sendTelegramMessage(
      chatId,
      "❗ Yandex Fleet bazasida ushbu haydovchini aniqlab bo‘lmadi. Avtomobilni avtomatik biriktirish imkoni yo‘q.\n" +
        "Iltimos, park operatoridan qo‘lda tekshirish va biriktirishni so‘rang."
    );
    await sendOperatorAlert(
      "❌ Не удалось определить водителя для привязки автомобиля (этап 2)\n\n" +
        `👤 Хантер: ${draft.hunterName} (chat_id: ${draft.hunterChatId})\n` +
        `📞 Телефон водителя (по боту): ${draft.driverPhone || "—"}\n` +
        `🚗 Авто: ${draft.carBrand || ""} ${draft.carModel || ""}, ${
          draft.carYear || ""
        }, ${draft.carPlate || ""}\n`
    );
 // 🔹 НОВОЕ: кнопка "Попробовать снова"
    await sendTelegramMessage(
      chatId,
      "Agar xato texnik bo‘lsa, quyidagi tugma orqali ro‘yxatdan o‘tishni qaytadan boshlashingiz mumkin.",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔁 Qayta urinib ko‘rish",
                callback_data: "restart_registration",
              },
            ],
          ],
        },
      }
    );

    session.driverDraft = null;
    session.step = "main_menu";
    await sendTelegramMessage(chatId, "Asosiy menyuga qaytdingiz.", {
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  await sendTelegramMessage(
    chatId,
    "⏳ Avtomobilni Yandex Fleet tizimiga qo‘shish va haydovchiga biriktirish jarayoni boshlandi.\n" +
      "Bu bir necha soniya davom etishi mumkin."
  );

  const carRes = await createCarInFleetForHunter(draft);
  let carId = null;

  if (!carRes.ok) {
    await sendTelegramMessage(
      chatId,
      "⚠️ Haydovchi ro‘yxatdan o‘tgan, biroq avtomobilni Yandex Fleet tizimiga avtomatik qo‘shish imkoni bo‘lmadi.\n" +
        "Park operatori avtomobilni qo‘lda qo‘shadi."
    );

    await sendOperatorAlert(
      "⚠️ Водитель найден, но автомобиль не удалось добавить в Yandex Fleet автоматически (этап 2)\n\n" +
        `👤 Хантер: ${draft.hunterName} (chat_id: ${draft.hunterChatId})\n` +
        `📞 Телефон водителя: ${draft.driverPhone || "—"}\n` +
        `🚗 Авто: ${draft.carBrand || ""} ${draft.carModel || ""}, ${
          draft.carYear || ""
        }, ${draft.carPlate || ""}\n\n` +
        `Описание ошибки: ${carRes.error || "не указано"}\n` +
        `HTTP-статус Fleet: ${carRes.status ?? "—"}\n` +
        `Код Fleet: ${carRes.code || (carRes.raw && carRes.raw.code) || "—"}\n` +
        `Сообщение Fleet: ${
          (carRes.raw && carRes.raw.message) || "—"
        }`
    );
    // 🔹 НОВОЕ: кнопка "Попробовать снова"
    await sendTelegramMessage(
      chatId,
      "Agar xato texnik bo‘lsa, quyidagi tugma orqali to‘liq ro‘yxatdan o‘tishni qaytadan boshlashingiz mumkin.",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔁 Qayta urinib ko‘rish",
                callback_data: "restart_registration",
              },
            ],
          ],
        },
      }
    );

    session.driverDraft = null;
    session.step = "main_menu";
    await sendTelegramMessage(chatId, "Asosiy menyuga qaytdingiz.", {
      reply_markup: mainMenuKeyboard(),
    });
    return;
  } else {
    carId = carRes.carId;
  }

  let bindOk = false;

  if (driverId && carId) {
    const bindRes = await bindCarToDriver(driverId, carId);
    if (!bindRes.ok) {
      await sendOperatorAlert(
        "⚠️ Не удалось автоматически привязить автомобиль к водителю в Yandex Fleet (этап 2)\n\n" +
          `👤 Хантер: ${draft.hunterName} (chat_id: ${draft.hunterChatId})\n` +
          `📞 Телефон водителя: ${draft.driverPhone || "—"}\n` +
          `🚗 Авто: ${draft.carBrand || ""} ${draft.carModel || ""}, ${
            draft.carYear || ""
          }, ${draft.carPlate || ""}\n\n` +
          `Описание ошибки: ${bindRes.error || "не указано"}\n` +
          `HTTP-статус Fleet: ${bindRes.status ?? "—"}\n` +
          `Код Fleet: ${
            bindRes.errorCode || (bindRes.raw && bindRes.raw.code) || "—"
          }\n` +
          `Сообщение Fleet: ${
            (bindRes.raw && bindRes.raw.message) || "—"
          }`
      );
    } else {
      bindOk = true;
    }
  }

// 🔹 Сохраняем состояние водителя у хантера (для бонусов и статистики)
if (session.hunter) {
  if (!session.hunter.drivers || typeof session.hunter.drivers !== "object") {
    session.hunter.drivers = {};
  }

  const existing = session.hunter.drivers[driverId] || {};
  const nowIso = new Date().toISOString();

  const driverState = {
    driverId,
    carId,
    registeredAt: existing.registeredAt || draft.createdAt || nowIso,

    driverFullName: draft.driverFullName || existing.driverFullName || "",
    driverPhone: draft.driverPhone || existing.driverPhone || "",

    licenseSeries: draft.licenseSeries || existing.licenseSeries || "",
    licenseNumber: draft.licenseNumber || existing.licenseNumber || "",

    carPlate: draft.carPlate || existing.carPlate || "",
    carBrand: draft.carBrand || existing.carBrand || "",
    carModel: draft.carModel || existing.carModel || "",

    hunterChatId: session.hunter.chatId,
    hunterName: session.hunter.name,

    photoControlOk: existing.photoControlOk || false,
    selfEmploymentOk: existing.selfEmploymentOk || false,
    committentOk: existing.committentOk || false,

    bonusGiven: existing.bonusGiven || false,
    bonusGivenAt: existing.bonusGivenAt || null,
    lastStatusCheckAt: existing.lastStatusCheckAt || null,
  };

  session.hunter.drivers[driverId] = driverState;
  await saveHunterToStorage(session.hunter);

  // Запись в Google Sheets — событие "registration"
  await appendDriverToGoogleSheets(driverState, "registration");

  // 🔹 NEW: индекс driverId → hunterChatId для связи с AsrPulBot
  try {
    const indexStore = getDriverIndexStore();
    if (indexStore && driverId && session.hunter?.chatId) {
      await indexStore.setJSON(`driver:${driverId}`, {
        hunterChatId: session.hunter.chatId,
      });
    }
  } catch (e) {
    console.error("save driver index error:", e);
  }

}

const summaryLines = [];
summaryLines.push("🎉 *Avtomobil muvaffaqiyatli qo‘shildi!*");

  summaryLines.push("");
  summaryLines.push(`👤 Haydovchi: ${draft.driverFullName || "—"}`);
  summaryLines.push(`📞 Telefon: ${draft.driverPhone || "—"}`);
  summaryLines.push("");
  summaryLines.push(
    `🚗 Avto: ${draft.carBrand || ""} ${draft.carModel || ""} (${
      draft.carYear || "yili ko‘rsatilmagan"
    })`
  );
  summaryLines.push(`Davlat raqami: ${draft.carPlate || "—"}`);
  summaryLines.push(`Rang: ${draft.carColor || "—"}`);
  summaryLines.push("");
  summaryLines.push(
    `Driver ID (Fleet): ${driverId || "—"}${
      carId ? `\nCar ID (Fleet): ${carId}` : ""
    }`
  );

  await sendTelegramMessage(chatId, summaryLines.join("\n"), {
    parse_mode: "Markdown",
  });

if (bindOk) {
    await sendOperatorAlert(
      "🚗 Новый автомобиль привязан к водителю через hunter-бот (этап 2)\n\n" +
        `👤 Хантер: ${draft.hunterName} (chat_id: ${draft.hunterChatId})\n` +
        `👤 Водитель: ${draft.driverFullName || "—"}\n` +
        `📞 Телефон водителя: ${draft.driverPhone || "—"}\n` +
        `🚗 Авто: ${draft.carBrand || ""} ${draft.carModel || ""}, ${
          draft.carYear || ""
        }, ${draft.carPlate || ""}\n` +
        `Driver ID в Fleet: ${driverId || "—"}\n` +
        `Car ID в Fleet: ${carId || "—"}`
    );
  } else {
    await sendOperatorAlert(
      "🚗 Автомобиль добавлен в Fleet для водителя, НО не удалось автоматически привязать к профилю (этап 2)\n\n" +
        `👤 Хантер: ${draft.hunterName} (chat_id: ${draft.hunterChatId})\n` +
        `👤 Водитель: ${draft.driverFullName || "—"}\n` +
        `📞 Телефон водителя: ${draft.driverPhone || "—"}\n` +
        `🚗 Авто: ${draft.carBrand || ""} ${draft.carModel || ""}, ${
          draft.carYear || ""
        }, ${draft.carPlate || ""}\n` +
        `Driver ID в Fleet: ${driverId || "—"}\n` +
        `Car ID в Fleet: ${carId || "—"}`
    );
  }

  await sendDocsToLogChat(draft);

  session.driverDraft = null;
  session.step = "main_menu";

  // 🔹 Сообщение о завершении регистрации + индивидуальная кнопка проверки самозанятости
  if (driverId) {
    await sendTelegramMessage(
      chatId,
      "Рўйхатдан ўтиш муваффақиятли якунланди.",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "➡️ Самозанятость статусини текшириш",
                callback_data: `check_selfemp:${driverId}`,
              },
            ],
          ],
        },
      }
    );
  } else {
    await sendTelegramMessage(chatId, "Рўйхатдан ўтиш муваффақиятли якунланди.");
  }

  await sendTelegramMessage(
    chatId,
    "Avtomobil qo‘shildi. Siz boshqa haydovchini ro‘yxatdan o‘tkazishingiz mumkin.",
    { reply_markup: mainMenuKeyboard() }
  );
}

// ================== SELF-EMPLOYMENT & BONUS HELPERS ==================
//
// Статусы самозанятости/комитента теперь храним у хантера и обновляем
// через сообщения из служебного чата AsrPulBot (handleAsrPulStatusMessage).

async function checkSelfEmploymentAndCommittentInFleet(driverId, hunter) {
  if (!driverId) {
    return { ok: false, message: "Driver ID is missing for status check." };
  }

  // hunter может уже быть в сессии, но на всякий случай подтягиваем свежего
  let h = hunter;
  if (!h && driverId) {
    try {
      const indexStore = getDriverIndexStore();
      const index = indexStore
        ? await indexStore.get(`driver:${driverId}`, { type: "json" })
        : null;
      if (index && index.hunterChatId) {
        h = await loadHunterFromStorage(index.hunterChatId);
      }
    } catch (e) {
      console.error("checkSelfEmploymentAndCommittentInFleet index error:", e);
    }
  }

  if (!h || !h.drivers || typeof h.drivers !== "object") {
    return { ok: true, selfEmployed: false, committent: false };
  }

  const state = h.drivers[driverId];
  if (!state) {
    return { ok: true, selfEmployed: false, committent: false };
  }

  return {
    ok: true,
    selfEmployed: !!state.selfEmploymentOk,
    committent: !!state.committentOk,
  };
}


/**
 * Реальная выдача бонуса хантеру через баланс его профиля в Yandex Fleet.
 * Использует метод:
 *   POST /v3/parks/driver-profiles/transactions
 *   https://fleet.yandex.ru/docs/api/ru/openapi/Transactions/v3parksdriver-profilestransactions-post
 *
 * hunter: объект хантера из стора (chatId, phone, name, ...).
 * driverState: объект с информацией о водителе, за которого выдаётся бонус.
 * amount: число в сумах (целое).
 */
async function grantBonusToHunterViaFleet(hunter, driverState, amount) {
  const cfg = ensureFleetConfigured();
  if (!cfg.ok) {
    return { ok: false, message: cfg.message };
  }

  if (!hunter) {
    return { ok: false, message: "No hunter object passed." };
  }

  const phoneRaw =
    hunter.phone ||
    (typeof hunter.contact_phone === "string" && hunter.contact_phone) ||
    driverState?.hunterPhone ||
    null;

  if (!phoneRaw) {
    return {
      ok: false,
      message:
        "Hunter phone is missing — невозможно найти его профиль в Yandex Fleet.",
    };
  }

  // Ищем профиль хантера по телефону (driver_profile_id / contractor_profile_id)
  const found = await findDriverByPhone(phoneRaw);
  if (!found.ok) {
    return {
      ok: false,
      message:
        found.error ||
        "Fleet error while trying to find hunter contractor profile.",
    };
  }

  if (!found.found || !found.driver || !found.driver.id) {
    return {
      ok: false,
      message:
        "В Yandex Fleet не найден профиль хантера по его телефону. " +
        "Создай для него водительский профиль в парке или привяжи существующий телефон.",
    };
  }

  const contractorProfileId = found.driver.id;

  const amountInt = Math.trunc(Number(amount) || 0);
  if (!amountInt || amountInt <= 0) {
    return { ok: false, message: "Bonus amount must be greater than zero." };
  }
  const amountStr = String(amountInt);

  let description =
    `Bonus hunteri uchun: ${driverState?.driverFullName || ""}`.trim();
  if (!description) {
    description = "Bonus hunteri uchun";
  }
  if (description.length > 255) {
    description = description.slice(0, 255);
  }

  // Тело запроса согласно v3 /parks/driver-profiles/transactions
  const body = {
    park_id: FLEET_PARK_ID,
    contractor_profile_id: contractorProfileId,
    amount: amountStr,
    description,
    data: {
      // Используем тип "bonus" (BonusData)
      kind: "bonus",
    },
  };

  const idempotencyKey = makeIdempotencyKey("hunter-bonus");

  const res = await callFleetPostIdempotent(
    "/v3/parks/driver-profiles/transactions",
    body,
    idempotencyKey
  );

  if (!res.ok) {
    console.error(
      "grantBonusToHunterViaFleet error:",
      res.status,
      res.message,
      res.raw
    );
    return {
      ok: false,
      message:
        res.message ||
        "Yandex Fleet bonus transaction error for hunter balance.",
      raw: res.raw,
      status: res.status ?? null,
    };
  }

  return { ok: true, data: res.data };
}

// ================== CALLBACK QUERY ==================
async function handleCallback(chatId, session, callback) {
  const data = callback.data || "";
  const draft = session.driverDraft || (session.driverDraft = {});
  if (data === "edit_car_brand_model") {
    // запускаем заново выбор бренда/модели/цвета, но в режиме редактирования
    session.editField = "carBrandModel";
    session.step = "driver_car_brand";

    await answerCallbackQuery(callback.id);
    await askCarBrand(chatId, session);
    return;
  }

  // ====== Самозанятость / бонусы ======
  if (data.startsWith("check_selfemp:")) {
    const driverId = data.split(":")[1];
    await answerCallbackQuery(callback.id);

    // подстрахуемся: подгружаем хантера из хранилища
    if (!session.hunter) {
      const storedHunter = await loadHunterFromStorage(chatId);
      if (storedHunter) {
        session.hunter = storedHunter;
      }
    }

    const hunter = session.hunter;
    if (!hunter) {
      await sendTelegramMessage(
        chatId,
        "Avval /start buyrug‘i orqali hunterni ro‘yxatdan o‘tkazing."
      );
      return;
    }

    if (!hunter.drivers || typeof hunter.drivers !== "object") {
      hunter.drivers = {};
    }
    const existing = hunter.drivers[driverId] || {};
    const driverState = {
      ...existing,
      driverId,
      hunterChatId: hunter.chatId,
      hunterName: hunter.name,
    };

const check = await checkSelfEmploymentAndCommittentInFleet(driverId, hunter);


    if (!check.ok) {
      await sendTelegramMessage(
        chatId,
        "Yandex Fleet orqali самозанятость статусини tekshirishda xatolik yuz berdi." +
          (check.message ? `\n\n${check.message}` : "")
      );
      return;
    }

    driverState.selfEmploymentOk = !!check.selfEmployed;
    driverState.committentOk = !!check.committent;
    driverState.lastStatusCheckAt = new Date().toISOString();

    hunter.drivers[driverId] = driverState;
    await saveHunterToStorage(hunter);

    // Если бонус уже был
    if (driverState.bonusGiven) {
      await sendTelegramMessage(
        chatId,
        "Самозанятость муваффақиятли. Бонус аввал берилган."
      );
      return;
    }

    // Оба статуса ок — показываем кнопку бонуса
    if (driverState.selfEmploymentOk && driverState.committentOk) {
      await sendTelegramMessage(
        chatId,
        "Самозанятость ва комитентлик муваффақиятли. Бонус бериш мумкин.",
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "➡️ 50 000 сўм бонус бериш",
                  callback_data: `give_bonus:${driverId}`,
                },
              ],
            ],
          },
        }
      );
    } else {
      await sendTelegramMessage(
        chatId,
        "Самозанятость ҳали расмийлашмаган. Илтимос, аввал @AsrPulBot орқали ўтинг."
      );
    }

    return;
  }

  if (data.startsWith("give_bonus:")) {
    const driverId = data.split(":")[1];
    await answerCallbackQuery(callback.id);

    if (!session.hunter) {
      const storedHunter = await loadHunterFromStorage(chatId);
      if (storedHunter) {
        session.hunter = storedHunter;
      }
    }
    const hunter = session.hunter;

    if (!hunter) {
      await sendTelegramMessage(
        chatId,
        "Avval /start buyrug‘i orqali hunterni ro‘yxatdan o‘tkazing."
      );
      return;
    }

    if (!hunter.drivers || typeof hunter.drivers !== "object") {
      hunter.drivers = {};
    }
    let driverState = hunter.drivers[driverId];
    if (!driverState) {
      driverState = {
        driverId,
        hunterChatId: hunter.chatId,
        hunterName: hunter.name,
        registeredAt: new Date().toISOString(),
        photoControlOk: false,
        selfEmploymentOk: false,
        committentOk: false,
        bonusGiven: false,
        bonusGivenAt: null,
      };
      hunter.drivers[driverId] = driverState;
    }

    // Повторная защита
    if (driverState.bonusGiven) {
      await sendTelegramMessage(
        chatId,
        "⚠️ Ushbu haydovchi uchun bonus аввал берилган."
      );
      await editMessageReplyMarkup(chatId, callback.message.message_id, {
        inline_keyboard: [],
      });
      return;
    }

    // Повторно проверяем статусы через Fleet
const check = await checkSelfEmploymentAndCommittentInFleet(driverId, hunter);

    if (!check.ok) {
      await sendTelegramMessage(
        chatId,
        "Yandex Fleet orqali statuslarni qayta tekshirishda xatolik yuz berdi." +
          (check.message ? `\n\n${check.message}` : "")
      );
      return;
    }

    const selfOk = !!check.selfEmployed;
    const commOk = !!check.committent;

    driverState.selfEmploymentOk = selfOk;
    driverState.committentOk = commOk;
    driverState.lastStatusCheckAt = new Date().toISOString();

    if (!selfOk || !commOk) {
      await sendTelegramMessage(
        chatId,
        "Самозанятость ёки комитент ҳали тасдиқланмаган. Бонус бериш мумкин эмас."
      );
      await saveHunterToStorage(hunter);
      return;
    }

    // Здесь реальная выдача (пока stub)
    // Реальная выдача бонуса через баланс хантера в Fleet
    const bonusRes = await grantBonusToHunterViaFleet(
      hunter,
      driverState,
      50000
    );

    if (!bonusRes.ok) {
      await sendTelegramMessage(
        chatId,
        "❗ Бонусни автоматик беришда xatolik yuz berdi. Iltimos, park operatoriga murojaat qiling."
      );
      return;
    }

    driverState.bonusGiven = true;
    driverState.bonusGivenAt = new Date().toISOString();
    hunter.drivers[driverId] = driverState;
    await saveHunterToStorage(hunter);

    // Лог в Google Sheets как отдельное событие
    await appendDriverToGoogleSheets(driverState, "bonus");

    await sendTelegramMessage(
      chatId,
      "✅ 50 000 сўм бонус муваффақиятли берилди."
    );

    // Убираем кнопку бонуса с того сообщения
    await editMessageReplyMarkup(chatId, callback.message.message_id, {
      inline_keyboard: [],
    });

    await sendOperatorAlert(
      "💸 Hunter-bot orqali bonus berildi\n\n" +
        `👤 Хантер: ${hunter.name} (chat_id: ${hunter.chatId})\n` +
        `👤 Водитель: ${driverState.driverFullName || "—"}\n` +
        `📞 Телефон водителя: ${driverState.driverPhone || "—"}\n` +
        `Driver ID (Fleet): ${driverState.driverId || "—"}\n` +
        `Bonus summasi: 50 000 so'm`
    );

    return;
  }

  if (data === "restart_registration") {
    await answerCallbackQuery(callback.id);

    // сохраняем хантера, чтобы не потерять связь
    let hunter = session.hunter;
    if (!hunter) {
      hunter = await loadHunterFromStorage(chatId);
    }

    resetSession(chatId);
    const newSession = getSession(chatId);
    if (hunter) {
      newSession.hunter = hunter;
    }

    await beginDriverRegistration(chatId, newSession);
    return;
  }

  if (data === "confirm_driver") {
    await answerCallbackQuery(callback.id);

    const flowType = draft.flowType || "driver";
    if (flowType === "car") {
      await finalizeCarRegistration(chatId, session);
    } else {
      await finalizeDriverRegistration(chatId, session);
    }
    return;
  }

  if (data.startsWith("edit:")) {
    const field = data.split(":")[1];
    session.step = "edit_field";
    session.editField = field;

    let label = "";
    switch (field) {
      case "driverFullName":
        label = "haydovchining F.I.Sh.";
        break;
      case "driverPhone":
        label = "haydovchi telefoni";
        break;
      case "carYear":
        label = "avtomobil ishlab chiqarilgan yili";
        break;
      case "carPlate":
        label = "avtomobil davlat raqami";
        break;
      case "licenseSeriesNumber":
        label =
          "haydovchilik guvohnomasi seriyasi va raqami (masalan, AF4908227)";
        break;
           // 🔹 NEW: label для PINFL
      case "driverPinfl":
        label = "haydovchining PINFL (14 ta raqam)";
        break;
      default:
        label = "maydon qiymati";
        break;
    }

    await answerCallbackQuery(callback.id);
    await sendTelegramMessage(
      chatId,
      `✏️ Iltimos, quyidagi maydon uchun to‘g‘ri qiymatni yuboring: *${label}*.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (data.startsWith("car_brand:")) {
    const brandCode = data.split(":")[1];
    const brand = CAR_BRANDS.find((b) => b.code === brandCode);
    if (!brand) {
      await answerCallbackQuery(callback.id);
      return;
    }
    draft.carBrandCode = brand.code;
    draft.carBrandLabel = brand.label;
    draft.carBrand = brand.label;
    await answerCallbackQuery(callback.id);
    await askCarModelForBrand(chatId, session);
    return;
  }

  if (data.startsWith("car_model:")) {
    const [, brandCode, modelCode] = data.split(":");
    const brand = CAR_BRANDS.find((b) => b.code === brandCode);
    const models = CAR_MODELS_INDEX[brandCode] || [];
    const model = models.find((m) => m.code === modelCode);
    if (!brand || !model) {
      await answerCallbackQuery(callback.id);
      return;
    }
    draft.carBrandCode = brandCode;
    draft.carBrandLabel = brand.label;
    draft.carBrand = brand.label;
    draft.carModelCode = model.code;
    draft.carModel = model.label;
    draft.carBrandModelRaw = `${brand.label} ${model.label}`;
    await answerCallbackQuery(callback.id);
    await askCarColor(chatId, session);
    return;
  }

  if (data.startsWith("car_color:")) {
    const colorCode = data.split(":")[1];
    const color = CAR_COLORS.find((c) => c.code === colorCode);
    if (color) {
      draft.carColorCode = color.code;
      draft.carColor = color.label;
    }
    await answerCallbackQuery(callback.id);

    // 🔹 Если мы в режиме редактирования марки/модели/цвета —
    // просто возвращаемся к экрану подтверждения, НЕ просим фото техпаспорта
    if (session.editField === "carBrandModel") {
      session.editField = null;
      session.step = "driver_confirm";
      await showDriverSummaryForConfirm(chatId, session);
    } else {
      // обычный поток: после первичного выбора идём к фото техпаспорта
      await askTechFrontPhoto(chatId, session);
    }
    return;
  }


  await answerCallbackQuery(callback.id);
}

// ================== HELP & МОИ ВОДИТЕЛИ ==================
async function handleHelpSection(chatId) {
  const text =
    "ℹ️ *ASR TAXI hunterlari uchun yordam*\n\n" +
    "1. «➕ Haydovchini ro‘yxatdan o‘tkazish» — 1-bosqich: haydovchini VU bo‘yicha ro‘yxatdan o‘tkazing.\n" +
    "   - Avval haydovchining telefon raqamini yuborasiz.\n" +
    "   - Bot Yandex Fleet bazasida ushbu raqam bo‘yicha mavjud haydovchi bor-yo‘qligini tekshiradi.\n" +
    "   - So‘ng, haydovchilik guvohnomasi (old tomoni) fotosuratini yuborasiz.\n" +
    "   - Bot ism, guvohnoma seriyasi/raqami va amal qilish muddatini avtomatik o‘qib oladi.\n" +
    "   - Oxirgi bosqichda ma’lumotlarni ko‘rib chiqib, zarur bo‘lsa ularni tahrirlaysiz.\n\n" +
    "2. Haydovchi muvaffaqiyatli ro‘yxatdan o‘tgach, bot *o‘zi avtomatik ravishda* 2-bosqichga o‘tadi — avtomobil qo‘shish:\n" +
    "   - Avtomobil brendi va modelini tanlaysiz.\n" +
    "   - Rangi va boshqa ma’lumotlarni ko‘rsatasiz.\n" +
    "   - Texnik pasport fotosuratlarini yuborasiz (old va orqa tomoni) — ulardan davlat raqami va avtomobil yili olinadi.\n" +
    "   - Ma’lumotlarni tasdiqlaganingizdan so‘ng, avtomobil Yandex Fleet tizimiga qo‘shiladi va haydovchiga biriktiriladi.\n\n" +
    "*«👥 Mening haydovchilarim»* bo‘limida Siz ushbu bot orqali Sizga biriktirilgan haydовchilar ro‘yxatini ko‘rishingiz mumkin.\n\n" +
    "Ro‘yxatdan o‘tkazish jarayonida agar nimadir noto‘g‘ri ketsa, klaviaturadagi *«❌ Ro‘yxatdan o‘tishni bekor qilish»* tugmasi orqali jarayonni to‘xtatib, asosiy menyuga qaytishingiz mumkin.";
  await sendTelegramMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: mainMenuKeyboard(),
  });
}

async function handleMyDriversSection(chatId, session) {
  if (!session.hunter) {
    await sendTelegramMessage(
      chatId,
      "Birinchi navbatda o‘zingizning kontaktingizni bog‘lash kerak. /start buyrug‘ini yuboring va telefon raqamingizni ulashing."
    );
    return;
  }

  // Берём самое актуальное состояние хантера из хранилища
  const storedHunter = await loadHunterFromStorage(session.hunter.chatId);
  if (storedHunter) {
    session.hunter = storedHunter;
  }

  const hunter = session.hunter;
  const driversMap = (hunter && hunter.drivers) || {};
  const allDrivers = Object.values(driversMap);

  const now = Date.now();
  const tenDaysMs = 10 * 24 * 60 * 60 * 1000;

  let totalRegistered = 0;
  let totalPhoto = 0;
  let totalSelfAndComm = 0;
  let totalBonus = 0;

  for (const d of allDrivers) {
    const ts = d.registeredAt ? Date.parse(d.registeredAt) : NaN;
    if (!ts || Number.isNaN(ts)) continue;
    if (now - ts > tenDaysMs) continue; // только последние 10 дней

    totalRegistered += 1;
    if (d.photoControlOk) totalPhoto += 1;
    if (d.selfEmploymentOk && d.committentOk) totalSelfAndComm += 1;
    if (d.bonusGiven) totalBonus += 1;
  }

  const text =
    "Сўнгги 10 кунда:\n" +
    `• ${totalRegistered} та рўйхатдан ўтган\n` +
    `• ${totalPhoto} та фотоконтрольдан ўтган\n` +
    `• ${totalSelfAndComm} та самозанятость + комитент\n` +
    `• ${totalBonus} та бонус олган`;

  await sendTelegramMessage(chatId, text, {
    reply_markup: mainMenuKeyboard(),
  });
}


// ================== MAIN HANDLER ==================
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 200, body: "OK" };
  }

  try {
    initBlobStore(event);
  } catch (e) {
    console.error("initBlobStore error in telegram-hunter-bot:", e);
  }

  let update;
  try {
    update = JSON.parse(event.body || "{}");
  } catch (e) {
    console.error("telegram-hunter-bot: invalid JSON", e);
    return { statusCode: 200, body: "OK" };
  }

  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId =
      (cq.message && cq.message.chat && cq.message.chat.id) || cq.from.id;
    let session = getSession(chatId);

    if (!session.hunter) {
      const storedHunter = await loadHunterFromStorage(chatId);
      if (storedHunter) {
        session.hunter = storedHunter;
        if (!session.step || session.step === "idle") {
          session.step = "main_menu";
        }
      }
    }

    await handleCallback(chatId, session, cq);
    return { statusCode: 200, body: "OK" };
  }

  const msg =
    update.message ||
    update.edited_message ||
    update.channel_post ||
    update.edited_channel_post;

  if (!msg || !msg.chat || typeof msg.chat.id === "undefined") {
    return { statusCode: 200, body: "OK" };
  }

  const chatId = msg.chat.id;
  const text = msg.text || "";
  // 🔹 Если это служебный чат, куда пишет AsrPulBot про самозанятость/комитента —
  // просто обрабатываем сообщение и выходим.
if (
  ASRPUL_STATUS_CHAT_ID &&
  String(chatId) === String(ASRPUL_STATUS_CHAT_ID)
) {
  await handleAsrPulStatusMessage(msg);
  return { statusCode: 200, body: "OK" };
}


  let session = getSession(chatId);

  if (!session.hunter) {
    const storedHunter = await loadHunterFromStorage(chatId);
    if (storedHunter) {
      session.hunter = storedHunter;
      if (!session.step || session.step === "idle") {
        session.step = "main_menu";
      }
    }
  }

  if (text && text.startsWith("/start")) {
    const storedHunter = await loadHunterFromStorage(chatId);

    resetSession(chatId);
    session = getSession(chatId);

    if (storedHunter) {
      session.hunter = storedHunter;
      session.step = "main_menu";

      await sendTelegramMessage(
        chatId,
        `👋 Salom, ${storedHunter.name}!\n\nSiz allaqachon *ASR TAXI hunteri* sifatida ro‘yxatdan o‘tgansiz.\n` +
          "Menyudan kerakli bo‘limni tanlang.",
        { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
      );
    } else {
      await handleStart(chatId, session, msg.from);
    }

    return { statusCode: 200, body: "OK" };
  }

  if (text === CANCEL_REG_TEXT && isInDriverRegistration(session)) {
    await cancelDriverRegistration(chatId, session);
    return { statusCode: 200, body: "OK" };
  }

  if (
    session.step === "waiting_hunter_name" &&
    typeof text === "string" &&
    text.trim()
  ) {
    const realName = text.trim();
    if (!session.hunter) {
      session.hunter = {
        chatId,
        phone: null,
        name: realName,
        createdAt: new Date().toISOString(),
      };
    } else {
      session.hunter.name = realName;
    }

    await saveHunterToStorage(session.hunter);

    session.step = "main_menu";

    await sendTelegramMessage(
      chatId,
      `✅ Rahmat, *${realName}*.\n\nSiz *ASR TAXI hunteri* sifatida ro‘yxatdan o‘tdingiz.\n\n` +
        "Endi menyudagi bo‘limlar orqali haydovchilarni ro‘yxatdan o‘tkazishingiz va ular uchun avtomobillar qo‘shishingiz mumkin.",
      { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
    );

    await sendOperatorAlert(
      "🟢 Новый хантер подключен\n\n" +
        `👤 Имя: ${session.hunter.name}\n` +
        `📞 Телефон: ${session.hunter.phone || "—"}\n` +
        `💬 Chat ID: ${chatId}`
    );

    return { statusCode: 200, body: "OK" };
  }

  if (msg.contact) {
    if (session.step === "waiting_hunter_contact") {
      await handleHunterContact(chatId, session, msg.contact);
      return { statusCode: 200, body: "OK" };
    }

    await sendOperatorAlert(
      "ℹ️ Хантер отправил контакт вне сценария\n\n" +
        `💬 Chat ID: ${chatId}\n` +
        `📞 Телефон из контакта: ${msg.contact.phone_number}`
    );
    await sendTelegramMessage(
      chatId,
      "Kontaktingiz qabul qilindi va park operatoriga yuborildi."
    );
    return { statusCode: 200, body: "OK" };
  }

  if (
    session.step === "driver_vu_front" &&
    (Array.isArray(msg.photo) ||
      (msg.document &&
        msg.document.mime_type &&
        msg.document.mime_type.startsWith("image/")))
  ) {
    await handleDriverVuPhoto(update, session);
    return { statusCode: 200, body: "OK" };
  }

  if (
    session.step === "driver_tech_front" &&
    (Array.isArray(msg.photo) ||
      (msg.document &&
        msg.document.mime_type &&
        msg.document.mime_type.startsWith("image/")))
  ) {
    await handleTechFrontPhoto(update, session);
    return { statusCode: 200, body: "OK" };
  }

  if (
    session.step === "driver_tech_back" &&
    (Array.isArray(msg.photo) ||
      (msg.document &&
        msg.document.mime_type &&
        msg.document.mime_type.startsWith("image/")))
  ) {
    await handleTechBackPhoto(update, session);
    return { statusCode: 200, body: "OK" };
  }

  if (session.step === "main_menu") {
    if (text === "➕ Haydovchini ro‘yxatdan o‘tkazish") {
      await beginDriverRegistration(chatId, session);
      return { statusCode: 200, body: "OK" };
    }
    if (text === "ℹ️ Yordam") {
      await handleHelpSection(chatId);
      return { statusCode: 200, body: "OK" };
    }
    if (text === "👥 Mening haydovchilarim") {
      await handleMyDriversSection(chatId, session);
      return { statusCode: 200, body: "OK" };
    }

    await sendTelegramMessage(
      chatId,
      "Haydovchini ro‘yxatdan o‘tkazishni boshlash uchun menyudagi *«➕ Haydovchini ro‘yxatdan o‘tkazish»* tugmasini tanlang.",
      { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
    );
    return { statusCode: 200, body: "OK" };
  }

  if (
    session.step === "edit_field" &&
    typeof text === "string" &&
    text.trim()
  ) {
    await handleEditFieldText(chatId, session, text.trim());
    return { statusCode: 200, body: "OK" };
  }

  if (session.step === "driver_vu_front" && text) {
    await sendTelegramMessage(
      chatId,
      "Ushbu bosqichda *haydovchilik guvohnomasi (old tomoni)* fotosuratini yuborish kerak.",
      { parse_mode: "Markdown" }
    );
    return { statusCode: 200, body: "OK" };
  }
  if (session.step === "driver_tech_front" && text) {
    await sendTelegramMessage(
      chatId,
      "Ushbu bosqichda *texnik pasportning old tomoni* fotosuratini yuborish kerak.",
      { parse_mode: "Markdown" }
    );
    return { statusCode: 200, body: "OK" };
  }
  if (session.step === "driver_tech_back" && text) {
    await sendTelegramMessage(
      chatId,
      "Ushbu bosqichda *texnik pasportning orqa tomoni* fotosuratini yuborish kerak.",
      { parse_mode: "Markdown" }
    );
    return { statusCode: 200, body: "OK" };
  }

  if (
    session.step &&
    session.step.startsWith("driver_") &&
    typeof text === "string" &&
    text.trim()
  ) {
    await handleDriverStep(chatId, session, text);
    return { statusCode: 200, body: "OK" };
  }

  if (session.step === "idle") {
    await handleStart(chatId, session, msg.from);
    return { statusCode: 200, body: "OK" };
  }

  await sendTelegramMessage(
    chatId,
    "Xabar mazmuni tushunarsiz. Agar jarayonni qayta boshlamoqchi bo‘lsangiz, /start buyrug‘ini yuboring."
  );

  return { statusCode: 200, body: "OK" };
};
