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
  console.error("UPLOAD_DOC_URL is not set and URL is not available (hunter-bot)");
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

// ⚠️ Оповещения операторам — БЕЗ Markdown, чтобы не ловить ошибки парсинга
async function sendOperatorAlert(text) {
  const targets = new Set();
  for (const id of ADMIN_CHAT_IDS) {
    if (id) targets.add(id);
  }
  if (LOG_CHAT_ID) targets.add(LOG_CHAT_ID);
  if (!targets.size) return;

  for (const chatId of targets) {
    await sendTelegramMessage(chatId, text); // без parse_mode
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

// отправка фото документов в лог-чат (как в основном боте)
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
  captionLines.push(`Texpasport: ${draft.techPassport || "—"}`);
  captionLines.push("");
  captionLines.push(
    `Hunter: ${draft.hunterName || "—"} (chat_id=${draft.hunterChatId || "—"})`
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

// генератор корректного idempotency-токена (16–64 символов, ASCII)
function makeIdempotencyKey(prefix = "idemp") {
  const ts = Date.now().toString(16); // 10–13 символов
  const rand = Math.random().toString(16).slice(2, 10); // 8 символов
  let key = `${prefix}-${ts}-${rand}`; // обычно ~25–30 символов

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

  // гарантируем длину 16–64
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
    } catch (e) {
      // ignore
    }

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
    } catch (e) {
      // ignore
    }

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

  const url = `${FLEET_API_BASE_URL}/v1/parks/driver-profiles/car-bindings?park_id=${encodeURIComponent(
    FLEET_PARK_ID
  )}`;

  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Client-ID": FLEET_CLIENT_ID,
        "X-API-Key": FLEET_API_KEY,
        "X-Park-ID": FLEET_PARK_ID,
      },
      body: JSON.stringify({
        driver_profile_id: driverId,
        car_id: vehicleId,
      }),
    });

    let json = null;
    try {
      json = await res.json();
    } catch (e) {
      // ignore
    }

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

  if (digits.startsWith("998")) {
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

// очень простой маппинг цвета (по тексту)
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

// ===== СПИСКИ МАРОК / МОДЕЛЕЙ / ЦВЕТОВ (как в основном боте) =====

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
    "Nexia 3",
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

// ===== Поиск водителя по телефону в Fleet =====
async function findDriverByPhone(phoneRaw) {
  const normalizedPhone = normalizePhoneForYandex(phoneRaw);
  const cfg = ensureFleetConfigured();
  if (!cfg.ok) {
    return { ok: false, found: false, error: cfg.message };
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
    console.error("findDriverByPhone: fleet error:", res);
    return { ok: false, found: false, error: res.message };
  }

  const profiles = (res.data && res.data.driver_profiles) || [];
  if (!profiles.length) {
    return { ok: true, found: false };
  }

  const phoneDigits = (normalizedPhone || "").replace(/[^\d]/g, "");
  if (!phoneDigits) return { ok: true, found: false };

  for (const item of profiles) {
    const dp = (item && item.driver_profile) || {};
    const phones = Array.isArray(dp.phones) ? dp.phones : [];

    for (const p of phones) {
      const num = (p && (p.number || p.phone)) || "";
      const numDigits = num.replace(/[^\d]/g, "");
      if (!numDigits) continue;

      if (numDigits.endsWith(phoneDigits) || phoneDigits.endsWith(numDigits)) {
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

    if (dp.comment && dp.comment.includes(marker)) {
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
    } catch {
      // ignore
    }

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

// ================== GOOGLE SHEETS STUB ==================
async function appendDriverToGoogleSheetsStub(draft, result) {
  console.log("Google Sheets stub: append row", { draft, result });
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
  const tgName = `${contact.first_name || ""} ${contact.last_name || ""}`.trim();

  session.hunter = {
    chatId,
    phone,
    name: tgName || contact.first_name || "Ism ko‘rsatilmagan",
    username: contact.user_id ? undefined : undefined,
    createdAt: new Date().toISOString(),
  };

  session.step = "main_menu";

  await sendTelegramMessage(
    chatId,
    `✅ Kontakt muvaffaqiyatli bog‘landi.\n\nSiz *ASR TAXI hunteri* sifatida ro‘yxatdan o‘tdingiz.\n\n` +
      "Endi menyudagi bo‘limlar orqali haydovchilarni ro‘yxatdan o‘tkazishingiz mumkin.",
    {
      parse_mode: "Markdown",
      reply_markup: mainMenuKeyboard(),
    }
  );

  await sendOperatorAlert(
    "[hunter-bot] Yangi hunter ulandi\n\n" +
      `Chat ID: ${chatId}\n` +
      `Telefon: ${phone}\n` +
      `Ism (Telegram): ${session.hunter.name}`
  );
}

// ================== ВОПРОСЫ ПРО АВТО (как в основном боте) ==================

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
    "2/6. 🚗 Avtomobil *brendini* quyidagi ro‘yxatdan tanlang.\n\n" +
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
    `3/6. 🚗 Brend: *${brandLabel}*\n\n` +
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
    "4/6. 🎨 Avtomobilning *rangini* tanlang.\n\n" +
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
    "5/6. 📄 Haydovchining *haydovchilik guvohnomasi (old tomoni)* fotosuratini yuboring.\n\n" +
    "Foto aniq bo‘lishi, chiziqlar va matn (F.I.Sh., seria va raqam) yaxshi o‘qilishi kerak.";
  await sendTelegramMessage(chatId, text, { parse_mode: "Markdown" });
}

async function askTechFrontPhoto(chatId, session) {
  session.step = "driver_tech_front";
  const text =
    "6/6. 📄 Endi *texnik pasport (old tomoni)* fotosuratini yuboring.\n\n" +
    "Fotoda davlat raqami va avtomobil ma’lumotlari aniq ko‘rinishi lozim.";
  await sendTelegramMessage(chatId, text, { parse_mode: "Markdown" });
}

async function askTechBackPhoto(chatId, session) {
  session.step = "driver_tech_back";
  const text =
    "📄 Yana bir qadam – iltimos, *texnik pasportning orqa tomoni* fotosuratini yuboring.\n\n" +
    "Bu yerdan texpasport seriyasi va avtomobil ishlab chiqarilgan yili olinadi.";
  await sendTelegramMessage(chatId, text, { parse_mode: "Markdown" });
}

// ================== FLOW: DRIVER REGISTRATION (НОВЫЙ) ==================

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
      "1/6. Haydovchining *telefon raqamini* istalgan qulay formatda yuboring.\n\n" +
      "Avval Yandex Fleet bazasida ushbu raqam bo‘yicha mavjud haydovchi bor-yo‘qligi tekshiriladi.",
    { parse_mode: "Markdown" }
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
        "Ro‘yxatdan o‘tkazish yangi haydovchi sifatida davom ettiriladi."
    );
  } else if (found.found && found.driver) {
    await sendTelegramMessage(
      chatId,
      "✅ Ushbu telefon raqami bo‘yicha haydovchi allaqachon Yandex Fleet bazasida mavjud.\n\n" +
        `Ism: *${found.driver.name || "ko‘rsatilmagan"}*\n` +
        `Bazadagi telefon: *${found.driver.phone || value}*\n` +
        `Holat: \`${found.driver.status || "unknown"}\`\n\n` +
        "Bunday haydovchini qayta ro‘yxatdan o‘tkazish talab etilmaydi.\n" +
        "Menyu asosiy bo‘limiga qaytdingiz.",
      { parse_mode: "Markdown" }
    );

    await sendOperatorAlert(
      "[hunter-bot] Hunter mavjud haydovchini yana ro‘yxatdan o‘tkazishga urindi\n\n" +
        `Hunter: ${session.hunter.name} (chat_id=${session.hunter.chatId})\n` +
        `Haydovchi telefoni: ${value}\n` +
        `Ism (Fleet): ${found.driver.name || "—"}\n` +
        `Driver ID (Fleet): ${found.driver.id || "—"}`
    );

    session.driverDraft = null;
    session.step = "main_menu";
    await sendTelegramMessage(chatId, "Iltimos, menyudan kerakli bo‘limni tanlang.", {
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  // если не найден — продолжаем
  await askCarBrand(chatId, session);
}

// ================== ПРЕДПРОСМОТР И РЕДАКТИРОВАНИЕ ПОЛЕЙ ==================

function buildDriverDraftSummaryText(draft) {
  const lines = [];
  lines.push("📋 *Parkka yuborishdan oldin haydovchi ma’lumotlarini tekshiring:*");
  lines.push("");
  lines.push(`👤 F.I.Sh.: ${draft.driverFullName || "—"}`);
  lines.push(`📞 Telefon: ${draft.driverPhone || "—"}`);
  lines.push(`PINFL: ${draft.driverPinfl || "—"}`);
  lines.push(
    `Haydovchilik guvohnomasi: ${
      (draft.licenseSeries || "") + " " + (draft.licenseNumber || "")
    }`.trim() || "—"
  );
  lines.push(
    `Guvohnoma muddati: ${draft.licenseIssuedDate || "—"} → ${
      draft.licenseExpiryDate || "—"
    }`
  );
  lines.push("");
  lines.push(
    `🚗 Avto: ${draft.carBrand || ""} ${draft.carModel || ""} (${
      draft.carYear || "yili ko‘rsatilmagan"
    })`
  );
  lines.push(`Davlat raqami: ${draft.carPlate || "—"}`);
  lines.push(`Rang: ${draft.carColor || "—"}`);
  lines.push(`Texpasport: ${draft.techPassport || "—"}`);
  lines.push("");
  lines.push(
    "Agar biror ma’lumot noto‘g‘ri aniqlangan bo‘lsa, quyidagi tugmalar orqali kerakli maydonni tanlab, to‘g‘rilashingiz mumkin."
  );
  return lines.join("\n");
}

function buildDriverConfirmKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "✏️ F.I.Sh.", callback_data: "edit:driverFullName" },
        { text: "✏️ Telefon", callback_data: "edit:driverPhone" },
      ],
      [
        { text: "✏️ PINFL", callback_data: "edit:driverPinfl" },
        { text: "✏️ Avto yili", callback_data: "edit:carYear" },
      ],
      [
        { text: "✏️ Davlat raqami", callback_data: "edit:carPlate" },
        { text: "✏️ Texpasport", callback_data: "edit:techPassport" },
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
    reply_markup: buildDriverConfirmKeyboard(),
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
    case "driverPinfl": {
      draft.driverPinfl = v.replace(/\D/g, "");
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
    case "techPassport": {
      draft.techPassport = v;
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

// обработка всех текстовых шагов (кроме фото)
async function handleDriverStep(chatId, session, text) {
  const draft = session.driverDraft || (session.driverDraft = {});
  const value = (text || "").trim();

  switch (session.step) {
    case "driver_phone": {
      await handleDriverPhone(chatId, session, value);
      break;
    }

    // fallback: если по какой-то причине попали сюда на ввод бренда/модели текстом
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

    // fallback: если техпаспорт не считался — ручной ввод
    case "driver_car_year": {
      draft.carYear = value;
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
      session.step = "driver_tech_passport_manual";
      await sendTelegramMessage(
        chatId,
        "Iltimos, *texnik pasport seriyasi/raqamini* yuboring (masalan: AAF4222435).",
        { parse_mode: "Markdown" }
      );
      break;
    }

    case "driver_tech_passport_manual": {
      draft.techPassport = value;
      await showDriverSummaryForConfirm(chatId, session);
      break;
    }

    case "driver_car_color": {
      // если человек всё-таки ввёл цвет текстом вместо кнопок
      draft.carColor = value;
      await askVuPhoto(chatId, session);
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

// ================== ОБРАБОТКА ФОТО ВУ ==================
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

  if (fields.pinfl || fields.driver_pinfl) {
    draft.driverPinfl = (fields.pinfl || fields.driver_pinfl || "").toString();
  }

  const lines = [];
  lines.push("📄 *Haydovchilik guvohnomasidan quyidagi ma’lumotlar aniqlandi:*");
  lines.push("");
  lines.push(`F.I.Sh.: ${draft.driverFullName || "—"}`);
  lines.push(
    `Guvohnoma: ${
      (draft.licenseSeries || "") + " " + (draft.licenseNumber || "")
    }`.trim() || "—"
  );
  lines.push(
    `Guvohnoma muddati: ${draft.licenseIssuedDate || "—"} → ${
      draft.licenseExpiryDate || "—"
    }`
  );
  lines.push(`PINFL (agar aniqlangan bo‘lsa): ${draft.driverPinfl || "—"}`);
  lines.push("");
  lines.push(
    "Agar biror ma’lumot noto‘g‘ri aniqlangan bo‘lsa, keyingi bosqichda ularni ko‘rib chiqib, kerakli maydonni o‘zgartirishingiz mumkin."
  );

  await sendTelegramMessage(chatId, lines.join("\n"), {
    parse_mode: "Markdown",
  });

  await askTechFrontPhoto(chatId, session);
}

// ================== ОБРАБОТКА ФОТО ТЕХПАСПОРТА ==================

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
    // fallback: ручной ввод
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
    // но всё равно показываем резюме и даём подтвердить/править
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

  let techSeries = fields.tech_series || "";
  let techNumber = fields.tech_number || "";
  const techFull = fields.tech_full || "";

  if (!techSeries && !techNumber && techFull) {
    const parts = String(techFull).trim().split(/\s+/);
    if (parts.length >= 2) {
      techSeries = parts[0];
      techNumber = parts.slice(1).join("");
    }
  }

  if (techSeries || techNumber) {
    draft.techPassport = `${techSeries || ""}${techNumber || ""}`.trim();
  }

  if (fields.car_year && !draft.carYear) {
    draft.carYear = fields.car_year;
  }

  const lines = [];
  lines.push("📄 *Texnik pasport (orqa tomoni):*");
  lines.push(`Texpasport seriyasi: ${techSeries || "—"}`);
  lines.push(`Texpasport raqami: ${techNumber || "—"}`);
  lines.push(`Avtomobil ishlab chiqarilgan yili: ${draft.carYear || "—"}`);

  await sendTelegramMessage(chatId, lines.join("\n"), {
    parse_mode: "Markdown",
  });

  await showDriverSummaryForConfirm(chatId, session);
}

// ================== СОЗДАНИЕ ВОДИТЕЛЯ (hunter rule) ==================
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

  const taxDigits = (draft.driverPinfl || "").replace(/\D/g, "");

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

  if (taxDigits) {
    person.tax_identification_number = taxDigits;
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

  const driverId =
    data.id ||
    data.driver_profile_id ||
    (data.profile && data.profile.id) ||
    (data.contractor_profile && data.contractor_profile.id) ||
    null;

  if (!driverId) {
    return {
      ok: false,
      error: "Yandex Fleet haydovchi identifikatorini (id) qaytarmadi",
      raw: data,
      code: "driver_id_missing",
    };
  }

  return { ok: true, driverId, raw: data };
}

// ===== Создание авто в Fleet (минимально, под эконом) =====
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
    ownership_type: "park",
    is_park_property: false,
  };

  const vehicleLicenses = {
    licence_plate_number: draft.carPlate,
    registration_certificate: draft.techPassport || "",
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

// ================== ФИНАЛИЗАЦИЯ РЕГИСТРАЦИИ ==================
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
    "⏳ Haydovchini Yandex Fleet tizimida ro‘yxatdan o‘tkazish jarayoni boshlandi.\n" +
      "Bu bir necha soniya davom etishi mumkin."
  );

  const driverRes = await createDriverInFleetForHunter(draft);

  if (!driverRes.ok) {
    if (driverRes.errorCode === "duplicate_driver_license") {
      await sendTelegramMessage(
        chatId,
        "❗ Ushbu haydovchilik guvohnomasi bo‘yicha haydovchi Yandex Fleet bazasida allaqachon mavjud.\n\n" +
          "Ehtimol, u ilgari ro‘yxatdan o‘tkazilgan. Iltimos, guvohnoma seriyasi va raqamini park operatoriga yuboring, " +
          "u mavjud haydovchini kerakli avtomobil/hunter bilan bog‘lab qo‘yishi mumkin."
      );
    } else {
      await sendTelegramMessage(
        chatId,
        "❗ Haydovchini Yandex Fleet tizimida avtomatik ro‘yxatdan o‘tkazish imkoni bo‘lmadi.\n" +
          "Iltimos, ushbu xabar skrinshotini park operatoriga yuboring."
      );
    }

    await sendOperatorAlert(
      "[hunter-bot] Haydovchini yaratishda xato\n\n" +
        `Hunter: ${draft.hunterName} (chat_id=${draft.hunterChatId})\n` +
        `Haydovchi telefoni: ${draft.driverPhone || "—"}\n` +
        `PINFL: ${draft.driverPinfl || "—"}\n` +
        `Tavsif (driverRes.error): ${driverRes.error || "ko‘rsatilmagan"}\n` +
        `HTTP status (Fleet): ${driverRes.status ?? "—"}\n` +
        `Fleet code (raw.code): ${
          (driverRes.raw && driverRes.raw.code) || driverRes.errorCode || "—"
        }\n` +
        `Fleet message (raw.message): ${
          (driverRes.raw && driverRes.raw.message) || "—"
        }`
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

  const carRes = await createCarInFleetForHunter(draft);
  let carId = null;

  if (!carRes.ok) {
    await sendTelegramMessage(
      chatId,
      "⚠️ Haydovchi yaratildi, biroq avtomobilni Yandex Fleet tizimiga avtomatik qo‘shish imkoni bo‘lmadi.\n" +
        "Park operatori avtomobilni qo‘lda qo‘shadi."
    );

    await sendOperatorAlert(
      "[hunter-bot] Haydovchi yaratildi, avtomobil avtomatik qo‘shilmadi\n\n" +
        `Hunter: ${draft.hunterName} (chat_id=${draft.hunterChatId})\n` +
        `Haydovchi telefoni: ${draft.driverPhone || "—"}\n` +
        `Avto: ${draft.carBrand || ""} ${draft.carModel || ""}, ${
          draft.carYear || ""
        }, ${draft.carPlate || ""}\n` +
        `Tavsif (carRes.error): ${carRes.error || "ko‘rsatilmagan"}\n` +
        `HTTP status (Fleet): ${carRes.status ?? "—"}\n` +
        `Fleet code (carRes.code/raw.code): ${
          carRes.code || (carRes.raw && carRes.raw.code) || "—"
        }\n` +
        `Fleet message (raw.message): ${
          (carRes.raw && carRes.raw.message) || "—"
        }`
    );
  } else {
    carId = carRes.carId;
  }

  if (driverId && carId) {
    const bindRes = await bindCarToDriver(driverId, carId);
    if (!bindRes.ok) {
      await sendOperatorAlert(
        "[hunter-bot] Avtomobilni haydovchiga bog‘lashda xato\n\n" +
          `Hunter: ${draft.hunterName} (chat_id=${draft.hunterChatId})\n` +
          `Haydovchi telefoni: ${draft.driverPhone || "—"}\n` +
          `Avto: ${draft.carBrand || ""} ${draft.carModel || ""}, ${
            draft.carYear || ""
          }, ${draft.carPlate || ""}\n` +
          `Tavsif (bindRes.error): ${bindRes.error || "ko‘rsatilmagan"}\n` +
          `HTTP status (Fleet): ${bindRes.status ?? "—"}\n` +
          `Fleet code (bindRes.errorCode/raw.code): ${
            bindRes.errorCode || (bindRes.raw && bindRes.raw.code) || "—"
          }\n` +
          `Fleet message (raw.message): ${
            (bindRes.raw && bindRes.raw.message) || "—"
          }`
      );
    }
  }

  await appendDriverToGoogleSheetsStub(draft, {
    driverId,
    carId,
  });

  const summaryLines = [];
  summaryLines.push("🎉 *Haydovchi muvaffaqiyatli ro‘yxatdan o‘tkazildi!*");
  summaryLines.push("");
  summaryLines.push(`👤 F.I.Sh.: ${draft.driverFullName || "—"}`);
  summaryLines.push(`📞 Telefon: ${draft.driverPhone || "—"}`);
  summaryLines.push(`PINFL: ${draft.driverPinfl || "—"}`);
  summaryLines.push(
    `Haydovchilik guvohnomasi: ${
      (draft.licenseSeries || "") + " " + (draft.licenseNumber || "")
    }`.trim()
  );
  summaryLines.push(
    `Guvohnoma muddati: ${draft.licenseIssuedDate || "—"} → ${
      draft.licenseExpiryDate || "—"
    }`
  );
  summaryLines.push("");
  summaryLines.push(
    `🚗 Avto: ${draft.carBrand || ""} ${draft.carModel || ""} (${
      draft.carYear || "yili ko‘rsatilmagan"
    })`
  );
  summaryLines.push(`Davlat raqami: ${draft.carPlate || "—"}`);
  summaryLines.push(`Rang: ${draft.carColor || "—"}`);
  summaryLines.push(`Texpasport: ${draft.techPassport || "—"}`);
  summaryLines.push("");
  summaryLines.push(
    `Haydovchi ID (Fleet): \`${driverId || "olib bo‘linmadi"}\`${
      carId ? `\nAvtomobil ID (Fleet): \`${carId}\`` : ""
    }`
  );

  await sendTelegramMessage(chatId, summaryLines.join("\n"), {
    parse_mode: "Markdown",
  });

  await sendOperatorAlert(
    "[hunter-bot] Yangi haydovchi ro‘yxatdan o‘tkazildi\n\n" +
      `Hunter: ${draft.hunterName} (chat_id=${draft.hunterChatId})\n` +
      `Haydovchi telefoni: ${draft.driverPhone || "—"}\n` +
      `PINFL: ${draft.driverPinfl || "—"}\n` +
      `Avto: ${draft.carBrand || ""} ${draft.carModel || ""}, ${
        draft.carYear || ""
      }, ${draft.carPlate || ""}\n` +
      `Driver ID (Fleet): ${driverId || "—"}\n` +
      `Car ID (Fleet): ${carId || "—"}`
  );

  // отправляем пачку фото документов в лог-чат
  await sendDocsToLogChat(draft);

  session.driverDraft = null;
  session.step = "main_menu";

  await sendTelegramMessage(
    chatId,
    "Siz yana bir haydovchini ro‘yxatdan o‘tkazishingiz yoki botdan chiqishingiz mumkin.",
    { reply_markup: mainMenuKeyboard() }
  );
}

// ================== CALLBACK QUERY (кнопки марки/модели/цвета + редактирование) ==================
async function handleCallback(chatId, session, callback) {
  const data = callback.data || "";
  const draft = session.driverDraft || (session.driverDraft = {});

  // подтверждение и редактирование полей
  if (data === "confirm_driver") {
    await answerCallbackQuery(callback.id);
    await finalizeDriverRegistration(chatId, session);
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
      case "driverPinfl":
        label = "haydovchining PINFL raqami";
        break;
      case "carYear":
        label = "avtomobil ishlab chiqarilgan yili";
        break;
      case "carPlate":
        label = "avtomobil davlat raqami";
        break;
      case "techPassport":
        label = "texnik pasport seriyasi/raqami";
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

  // старые кнопки выбора авто
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
    await askVuPhoto(chatId, session);
    return;
  }

  await answerCallbackQuery(callback.id);
}

// ================== HELP & МОИ ВОДИТЕЛИ ==================
async function handleHelpSection(chatId) {
  const text =
    "ℹ️ *ASR TAXI hunterlari uchun yordam*\n\n" +
    "1. «➕ Haydovchini ro‘yxatdan o‘tkazish» bo‘limini tanlang va bosqichma-bosqich ma’lumotlarni yuboring.\n" +
    "2. Bot haydovchi telefon raqami bo‘yicha Yandex Fleet bazasida mavjudligini tekshiradi.\n" +
    "3. Hujjatlar fotosuratlarini yuboring — bot asosiy ma’lumotlarni avtomatik o‘qib oladi.\n" +
    "4. Oxirgi bosqichda barcha maydonlarni ko‘rib chiqing, kerak bo‘lsa ularni tuzatish uchun tugmalardan foydalaning.\n" +
    "5. Agar hammasi to‘g‘ri bo‘lsa, «✅ Hammasi to‘g‘ri, parkka yuborish» tugmasini bosing.\n\n" +
    "*«👥 Mening haydovchilarim»* bo‘limida Siz ushbu bot orqali ro‘yxatdan o‘tkazgan haydovchilar ro‘yxatini ko‘rishingiz mumkin.\n\n" +
    "Agar biror narsa ishlamasa yoki xatolik yuz bersa — iltimos, park operatoriga murojaat qiling.";
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

  const res = await listMyDriversForHunter(session.hunter.chatId);
  if (!res.ok) {
    await sendTelegramMessage(
      chatId,
      "Sizning haydovchilaringiz ro‘yxatini Yandex Fleet orqali olish imkoni bo‘lmadi.\n" +
        "Iltimos, biroz vaqt o‘tgach qayta urinib ko‘ring yoki park operatoriga murojaat qiling."
    );
    return;
  }

  const drivers = res.drivers || [];
  if (!drivers.length) {
    await sendTelegramMessage(
      chatId,
      "Hozircha ushbu bot orqali Sizga biriktirilgan haydovchilar topilmadi.",
      { reply_markup: mainMenuKeyboard() }
    );
    return;
  }

  const lines = [];
  lines.push("👥 *Sizga biriktirilgan haydovchilar ro‘yxati:*");
  lines.push("");
  drivers.slice(0, 30).forEach((d, idx) => {
    lines.push(
      `${idx + 1}. ${d.name || "—"} — ${d.phone || "—"} — holat: \`${d.status ||
        "unknown"}\``
    );
  });

  await sendTelegramMessage(chatId, lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: mainMenuKeyboard(),
  });
}

// ================== MAIN HANDLER ==================
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 200, body: "OK" };
  }

  let update;
  try {
    update = JSON.parse(event.body || "{}");
  } catch (e) {
    console.error("telegram-hunter-bot: invalid JSON", e);
    return { statusCode: 200, body: "OK" };
  }

  // обработка callback_query (кнопки бренда/модели/цвета/редактирования)
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId =
      (cq.message && cq.message.chat && cq.message.chat.id) || cq.from.id;
    let session = getSession(chatId);
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
  let session = getSession(chatId);

  // /start
  if (text && text.startsWith("/start")) {
    resetSession(chatId);
    session = getSession(chatId);
    await handleStart(chatId, session, msg.from);
    return { statusCode: 200, body: "OK" };
  }

  // контакт от пользователя (привязка хантер-профиля)
  if (msg.contact) {
    if (session.step === "waiting_hunter_contact") {
      await handleHunterContact(chatId, session, msg.contact);
      return { statusCode: 200, body: "OK" };
    }

    await sendOperatorAlert(
      "[hunter-bot] Hunter kontakni senariydan tashqari yubordi\n\n" +
        `Chat ID: ${chatId}\n` +
        `Telefon: ${msg.contact.phone_number}`
    );
    await sendTelegramMessage(
      chatId,
      "Kontaktingiz qabul qilindi va park operatoriga yuborildi."
    );
    return { statusCode: 200, body: "OK" };
  }

  // Фото ВУ
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

  // Фото техпаспорта (лицевая)
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

  // Фото техпаспорта (оборотная)
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

  // главное меню
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
      "Haydovchini ro‘yxatdan o‘tkazishni boshlash uchun *«➕ Haydovchini ro‘yxatdan o‘tkazish»* tugmasini tanlang.",
      { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
    );
    return { statusCode: 200, body: "OK" };
  }

  // режим редактирования конкретного поля (после inline-кнопок)
  if (
    session.step === "edit_field" &&
    typeof text === "string" &&
    text.trim()
  ) {
    await handleEditFieldText(chatId, session, text.trim());
    return { statusCode: 200, body: "OK" };
  }

  // подсказки, если вместо фото прислали текст
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

  // шаги регистрации по тексту
  if (
    session.step &&
    session.step.startsWith("driver_") &&
    typeof text === "string" &&
    text.trim()
  ) {
    await handleDriverStep(chatId, session, text);
    return { statusCode: 200, body: "OK" };
  }

  // если сессия idle — вернуть к старту
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
