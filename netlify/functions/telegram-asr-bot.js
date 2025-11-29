// netlify/functions/telegram-asr-bot.js

const TELEGRAM_TOKEN = process.env.TG_BOT_TOKEN;
const TELEGRAM_API = TELEGRAM_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_TOKEN}`
  : null;

const UPLOAD_DOC_URL =
  process.env.UPLOAD_DOC_URL ||
  (process.env.URL &&
    `${process.env.URL.replace(/\/$/, "")}/.netlify/functions/upload-doc`) ||
  null;

// операторы / логи — такие же переменные, как в upload-doc.js
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || process.env.ADMIN_CHAT_ID || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const LOG_CHAT_ID = process.env.LOG_CHAT_ID || null;

// ===== Google Sheets / бонусы (через вебхук) =====
const GSHEETS_WEBHOOK_URL = process.env.GSHEETS_WEBHOOK_URL || null;

// Одноразовый бонус за регистрацию
const BONUS_AMOUNT = 50000; // сум

// ===== Yandex Fleet API (Park) =====
const FLEET_API_URL = process.env.FLEET_API_URL || null;
const FLEET_API_KEY = process.env.FLEET_API_KEY || null;
const FLEET_CLIENT_ID = process.env.FLEET_CLIENT_ID || null;
const FLEET_PARK_ID = process.env.FLEET_PARK_ID || null;

// из ТЗ про условия работы и оплату:
const FLEET_WORK_RULE_ID_DEFAULT =
  process.env.FLEET_WORK_RULE_ID_DEFAULT || null; // обычный 3% бот
const FLEET_WORK_RULE_ID_HUNTER =
  process.env.FLEET_WORK_RULE_ID_HUNTER || null; // 3% hunter

// платёжный сервис Яндекса, без него Account не создать
const FLEET_PAYMENT_SERVICE_ID =
  process.env.FLEET_PAYMENT_SERVICE_ID || null;

// дефолты для профиля водителя / авто
const FLEET_DEFAULT_LICENSE_COUNTRY =
  process.env.FLEET_DEFAULT_LICENSE_COUNTRY || "UZB";
const FLEET_DEFAULT_EMPLOYMENT_TYPE =
  process.env.FLEET_DEFAULT_EMPLOYMENT_TYPE || "selfemployed"; // самозанятый
const FLEET_DEFAULT_TRANSMISSION =
  process.env.FLEET_DEFAULT_TRANSMISSION || "automatic";
const FLEET_DEFAULT_FUEL_TYPE =
  process.env.FLEET_DEFAULT_FUEL_TYPE || "petrol";

// базовый URL API Флита
const FLEET_API_BASE_URL =
  (FLEET_API_URL && FLEET_API_URL.replace(/\/$/, "")) ||
  "https://fleet-api.taxi.yandex.net";

if (!TELEGRAM_TOKEN) {
  console.error("TG_BOT_TOKEN is not set (telegram-asr-bot.js)");
}
if (!UPLOAD_DOC_URL) {
  console.error("UPLOAD_DOC_URL is not set and URL is not available");
}
// Кнопка для принудительной остановки регистрации
const STOP_REGISTRATION_TEXT = "⛔ Ro‘yxatdan o‘tishni to‘xtatish";

function getStopKeyboard() {
  return {
    keyboard: [[{ text: STOP_REGISTRATION_TEXT }]],
    resize_keyboard: true,
  };
}

// ====== простая сессия в памяти (best-effort для Netlify) ======
const sessions = new Map();

// напоминания о проверке статуса (в памяти)
const reminderTimers = new Map();

function cancelStatusReminders(chatId) {
  const timers = reminderTimers.get(chatId);
  if (timers && timers.length) {
    for (const t of timers) clearTimeout(t);
  }
  reminderTimers.delete(chatId);
}

function scheduleStatusReminders(chatId) {
  cancelStatusReminders(chatId);

  const delaysMinutes = [5, 10, 15];
  const text =
    "ℹ️ Eslatma: agar hali ro‘yxatdan o‘tish holatini tekshirmagan bo‘lsangiz, " +
    '"🔄 Ro‘yxatdan o‘tish holatini tekshirish" tugmasini bosib ko‘rishingiz mumkin.';

  const timers = delaysMinutes.map((min) =>
    setTimeout(() => {
      sendTelegramMessage(chatId, text, {
        reply_markup: {
          keyboard: [[{ text: "🔄 Ro‘yxatdan o‘tish holatini tekshirish" }]],
          resize_keyboard: true,
        },
      }).catch((e) =>
        console.error("status reminder send error for chat", chatId, e)
      );
    }, min * 60 * 1000)
  );

  reminderTimers.set(chatId, timers);
}

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      step: "idle",

      phone: null,
      isExistingDriver: false,
      driverFleetId: null,
      driverName: null,

      carBrandCode: null,
      carBrandLabel: null,
      carModelCode: null,
      carModelLabel: null,
      carColor: null,
      carColorCode: null,

      isCargo: false,
      cargoSizeCode: null,
      cargoDimensions: null,

      assignedTariffs: [],
      registerWithoutCar: false,

      docs: {
        vu_front: null,
        tech_front: null,
        tech_back: null,
      },

      data: {},

      confirmStage: "none",
      editIndex: 0,
      editAwaitingValue: false,
      currentFieldKey: null,

      isHunterReferral: false,
      hunterCode: null,
      wantsDelivery: false,

      // 🔴 НОВОЕ: бонус / друг
      bonusGiven: false,
      isFriendRegistration: false,
      inviterDriverId: null,
      inviterPhone: null,
    });
  }
  return sessions.get(chatId);
}


function resetSession(chatId) {
  sessions.delete(chatId);
  cancelStatusReminders(chatId);
}

// ===== утилиты =====

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

function applyStartPayloadToSession(session, payloadRaw) {
  if (!payloadRaw) return;
  const payload = String(payloadRaw).trim();

  if (payload.toLowerCase().startsWith("hunter_")) {
    session.isHunterReferral = true;
    session.hunterCode = payload.slice("hunter_".length);
    return;
  }

  if (payload.toLowerCase().startsWith("hunter:")) {
    session.isHunterReferral = true;
    session.hunterCode = payload.slice("hunter:".length);
    return;
  }

  // 🔴 НОВОЕ: регистрация друга по реф-ссылке
  if (payload.toLowerCase().startsWith("friend_")) {
    session.isFriendRegistration = true;
    session.inviterDriverId = payload.slice("friend_".length);
    return;
  }

  // другие варианты...
}


// ===== МАРКИ / МОДЕЛИ / ГРУЗОВЫЕ =====

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
  { code: "CARGO", label: "Yuk avtomobillari" }, // было "Грузовые"
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
    "Volt",
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
  CARGO: [
    "Damas",
    "Labo",
    "Gazel 3302",
    "Gazel Next",
    "Gazel Business",
    "Isuzu NQR",
    "Isuzu NPR",
    "Isuzu Elf",
    "Foton Aumark",
    "Foton Aoling",
    "FAW Tiger V",
    "FAW J6F",
    "FAW CA1041",
    "FAW Victory",
  ],
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

// ===== ГРУЗОВЫЕ: размеры кузова =====

const CARGO_SIZES = {
  S: { code: "S", label: "S — 170×150×120 см", length: 170, width: 150, height: 120 },
  M: { code: "M", label: "M — 260×160×150 см", length: 260, width: 160, height: 150 },
  L: { code: "L", label: "L — 320×170×170 см", length: 320, width: 170, height: 170 },
  XL: { code: "XL", label: "XL — 420×190×190 см", length: 420, width: 190, height: 190 },
  XXL: { code: "XXL", label: "XXL — 450×210×210 см", length: 450, width: 210, height: 210 },
};

// ===== ТАРИФЫ: правила (по ТЗ) =====
const TARIFF_RULES = {
  // ... (ВСЯ твоя большая структура TARIFF_RULES БЕЗ ИЗМЕНЕНИЙ)
  // Я её не сокращаю комментариями в реальном файле — оставь как есть из своей версии.
  // Тут пропусти, чтобы ответ не раздувать, но в проекте просто оставь как было.
  CHEVROLET: {
    Cobalt: {
      start: true,
      comfort: { minYear: 2019 },
    },
    "Nexia 3": {
      start: true,
      comfort: { minYear: 2019 },
    },
    Gentra: {
      start: true,
      comfort: { minYear: 2015 },
    },
    Lacetti: {
      start: true,
      comfort: { minYear: 2012 },
    },
    Spark: {
      start: true,
    },
    Onix: {
      start: true,
      comfort: { minYear: 2019 },
    },
    Epica: {
      start: true,
      comfort: { minYear: 2006 },
    },
    Cruze: {
      start: true,
      comfort: { minYear: 2012 },
      comfortPlus: { minYear: 2018 },
    },
    Orlando: {
      start: true,
      comfort: { minYear: 2012 },
    },
    Menlo: {
      start: true,
      comfort: { minYear: 2020 },
      comfortPlus: { minYear: 2020 },
      electro: true,
    },
    Monza: {
      start: true,
      comfort: { minYear: 2012 },
    },
    "Bolt EV": {
      start: true,
      comfort: { minYear: 2019 },
      comfortPlus: { minYear: 2019 },
      electro: true,
    },
    Volt: {
      start: true,
      comfort: { minYear: 2012 },
      comfortPlus: { minYear: 2012 },
      electro: true,
    },
    Tracker: {
      start: true,
      comfort: { minYear: 2019 },
      comfortPlus: { minYear: 2021 },
    },
    Tahoe: {
      start: true,
    },
    Captiva: {
      start: true,
    },
    Trailblazer: {
      start: true,
      comfort: { minYear: 2012 },
    },
    Traverse: {
      start: true,
      comfort: { minYear: 2008 },
      comfortPlus: { minYear: 2010 },
    },
    Equinox: {
      start: true,
      comfortPlus: { minYear: 2012 },
    },
    Colorado: {
      start: true,
    },
    Evanda: {
      start: true,
    },
    Malibu: {
      start: true,
      comfort: { minYear: 2006 },
      comfortPlus: { minYear: 2012 },
      business: { minYear: 2018 },
    },
    "Malibu Turbo": {
      start: true,
      comfort: { minYear: 2012 },
      comfortPlus: { minYear: 2012 },
      business: { minYear: 2018 },
    },
  },

  // ... остальные бренды BYD / CHERY / CHANGAN / JAC / GEELY / HYUNDAI / KIA / LEAPMOTOR
  // тут ничего не менял, оставь свой код как был
};


// Маппинг внутренних тарифов → категории Флита
const TARIFF_CATEGORY_MAP = {
  Start: "econom",
  Comfort: "comfort",
  "Comfort+": "comfort_plus",
  Business: "business",
  Electro: "electric",
  Cargo: "cargo",
};

// Определение тарифов по бренду / модели / году
function getTariffsForCar(brandCode, modelLabel, carYearRaw) {
  const year = parseInt(String(carYearRaw || "").trim(), 10);
  const tariffs = [];

  const rulesByBrand = TARIFF_RULES[brandCode];
  if (!rulesByBrand) return { tariffs: [], hasRules: false };

  const rules =
    rulesByBrand[modelLabel] ||
    rulesByBrand[String(modelLabel).replace(/\s+\(.+\)$/, "").trim()];
  if (!rules) return { tariffs: [], hasRules: false };

  if (rules.start) tariffs.push("Start");
  if (rules.comfort && (!year || year >= rules.comfort.minYear)) {
    tariffs.push("Comfort");
  }
  if (rules.comfortPlus && (!year || year >= rules.comfortPlus.minYear)) {
    tariffs.push("Comfort+");
  }
  if (rules.business && (!year || year >= rules.business.minYear)) {
    tariffs.push("Business");
  }
  if (rules.electro) tariffs.push("Electro");

  return { tariffs, hasRules: true };
}

// ===== СПИСОК ЦВЕТОВ (бот) =====

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

// маппинг в ColorEnum Яндекса (значения на русском из документации)
function mapColorToYandex(session) {
  if (session.carColorCode) {
    switch (session.carColorCode) {
      case "WHITE":
        return "Белый";
      case "BLACK":
        return "Черный";
      case "GRAY":
        return "Серый";
      case "SILVER":
        return "Серый";
      case "BLUE":
      case "DARK_BLUE":
        return "Синий";
      case "RED":
      case "BURGUNDY":
        return "Красный";
      case "YELLOW":
        return "Желтый";
      case "GREEN":
        return "Зеленый";
      case "BROWN":
        return "Коричневый";
      case "BEIGE":
        return "Бежевый";
      case "ORANGE":
        return "Оранжевый";
      case "PURPLE":
        return "Фиолетовый";
      default:
        return "Белый";
    }
  }

  const txt = (session.carColor || "").toLowerCase();
  if (!txt) return "Белый";

  if (txt.includes("oq") || txt.includes("white")) return "Белый";
  if (txt.includes("qora") || txt.includes("black")) return "Черный";
  if (txt.includes("kul") || txt.includes("gray") || txt.includes("grey"))
    return "Серый";
  if (txt.includes("kumush") || txt.includes("silver")) return "Серый";
  if (txt.includes("ko‘k") || txt.includes("kök") || txt.includes("blue"))
    return "Синий";
  if (txt.includes("qizil") || txt.includes("red") || txt.includes("bordo"))
    return "Красный";
  if (txt.includes("sariq") || txt.includes("yellow")) return "Желтый";
  if (txt.includes("yashil") || txt.includes("green")) return "Зеленый";
  if (txt.includes("jigar") || txt.includes("brown")) return "Коричневый";
  if (txt.includes("bej") || txt.includes("beige")) return "Бежевый";
  if (txt.includes("to‘q sariq") || txt.includes("orange")) return "Оранжевый";
  if (txt.includes("binafsha") || txt.includes("purple")) return "Фиолетовый";

  return "Белый";
}

// ===== поля для редактирования =====

const EDIT_FIELDS = [
  { key: "lastName", label: "Familiya" },
  { key: "firstName", label: "Ism" },
  { key: "middleName", label: "Otasining ismi" },
  { key: "licenseSeries", label: "Haydovchilik guvohnomasi seriyasi" },
  { key: "licenseNumber", label: "Haydovchilik guvohnomasi raqami" },
  { key: "techSeries", label: "Texpasport seriyasi" },
  { key: "techNumber", label: "Texpasport raqami" },
  { key: "plateNumber", label: "Davlat raqami" },
  { key: "carYear", label: "Avtomobil chiqarilgan yili" },
  { key: "bodyNumber", label: "Kuzov raqami" },
  { key: "pinfl", label: "JShShIR (PINFL)" },
  { key: "carModelLabel", label: "Avtomobil modeli" },
  { key: "carColor", label: "Avtomobil rangi" },
];

// ===== Telegram helpers =====

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

async function sendOperatorAlert(text) {
  const targetIds = new Set();
  for (const id of ADMIN_CHAT_IDS) {
    if (id) targetIds.add(id);
  }
  if (LOG_CHAT_ID) targetIds.add(LOG_CHAT_ID);
  if (!targetIds.size) return;

  for (const id of targetIds) {
    await sendTelegramMessage(id, text);
  }
}

// ===== формирование сводок для операторов / водителя =====

function humanDocTitle(docType) {
  if (docType === "vu_front") return "Водительское удостоверение (лицевая)";
  if (docType === "tech_front") return "Техпаспорт (лицевая)";
  if (docType === "tech_back") return "Техпаспорт (оборотная)";
  return "Документ";
}

function splitCarBrandModel(source) {
  if (!source) return { brand: "—", model: "—" };
  const s = String(source).trim().replace(/\s+/g, " ");
  if (!s) return { brand: "—", model: "—" };
  const parts = s.split(" ");
  if (parts.length === 1) {
    return { brand: parts[0], model: "—" };
  }
  return {
    brand: parts[0],
    model: parts.slice(1).join(" "),
  };
}

function formatSummaryForOperators(docs, commonMeta = {}, options = {}) {
  const {
    phone,
    tg_id,
    carModel,
    carColor,
    tariffs,
    isCargo,
    cargoSize,
    carBrandLabel,
  } = commonMeta;

  const { note } = options;

  const vu = docs.find((d) => d.docType === "vu_front");
  const tFront = docs.find((d) => d.docType === "tech_front");
  const tBack = docs.find((d) => d.docType === "tech_back");

  const fVu =
    (vu && vu.result && vu.result.parsed && vu.result.parsed.fields) || {};
  const fTf =
    (tFront && tFront.result && tFront.result.parsed && tFront.result.parsed.fields) ||
    {};
  const fTb =
    (tBack && tBack.result && tBack.result.parsed && tBack.result.parsed.fields) ||
    {};

  let fam = "";
  let name = "";
  if (fVu.driver_name) {
    const parts = String(fVu.driver_name).trim().split(/\s+/);
    fam = parts[0] || "";
    name = parts[1] || "";
  }

  const licenseSeries = (fVu.license_series || "").trim() || null;
  const issuedDate = fVu.issued_date || "—";
  const expiryDate = fVu.expiry_date || "—";

  // 🔧 ПИНФЛ водителя — ТОЛЬКО с ВУ
  const driverPinfl =
    fVu.pinfl ||
    fVu.driver_pinfl ||
    "—";


  const plateNumber = fTf.plate_number || "—";

  // 🔧 ИСПРАВЛЕНО: приоритет — марка/модель, выбранные в боте
  let brand = "—";
  let model = "—";

  if (carBrandLabel || carModel) {
    const modelLabel = carModel || fTf.car_model_text || "";
    if (carBrandLabel) {
      brand = carBrandLabel;
      if (modelLabel) {
        const short = String(modelLabel)
          .replace(new RegExp(`^${carBrandLabel}\\s+`, "i"), "")
          .trim();
        model = short || modelLabel;
      }
    } else if (modelLabel) {
      const split = splitCarBrandModel(modelLabel);
      brand = split.brand;
      model = split.model;
    }
  } else {
    const carModelSource = fTf.car_model_text || "";
    const split = splitCarBrandModel(carModelSource);
    brand = split.brand;
    model = split.model;
  }

  const colorDocOrForm = fTf.car_color_text || carColor || "—";
  const carYear = fTb.car_year || "—";
  const bodyNumber = fTb.body_number || "—";
  const techSeries = (fTb.tech_series || "").trim() || "—";

  const lines = [];

  if (note) {
    lines.push(`⚠️ ${note}`);
    lines.push("");
  }

  lines.push("📄 *Набор документов от водителя ASR TAXI*");
  lines.push("");

  lines.push(`Телефон: ${phone ? "`" + phone + "`" : "—"}`);
  lines.push(`Chat ID: ${tg_id ? "`" + tg_id + "`" : "—"}`);
  lines.push(`Цвет авто (выбор в боте): ${carColor || "—"}`);
  lines.push(`Модель авто (выбор в боте): ${carModel || "—"}`);
  if (isCargo) {
    lines.push(`Грузовой кузов: ${cargoSize || "—"}`);
  }
  if (tariffs && tariffs.length) {
    lines.push(`Тарифы: ${tariffs.join(", ")}`);
  }
  lines.push("");

  lines.push("👤 *Водитель*");
  lines.push(`Фамилия: ${fam || "—"}`);
  lines.push(`Имя: ${name || "—"}`);
  lines.push(`Дата выдачи ВУ: ${issuedDate}`);
  lines.push(`Дата истечения срока ВУ: ${expiryDate}`);
  lines.push(`ПИНФЛ: ${driverPinfl}`);
  lines.push(`Серия В/У: ${licenseSeries || "—"}`);
  lines.push("");

  lines.push("🚗 *Авто*");
  lines.push(`Гос номер: ${plateNumber}`);
  lines.push(`Марка: ${brand}`);
  lines.push(`Модель: ${model}`);
  lines.push(`Цвет: ${colorDocOrForm}`);
  lines.push(`Год выпуска авто: ${carYear}`);
  lines.push(`Номер кузова: ${bodyNumber}`);
  lines.push(`Серия тех паспорта: ${techSeries}`);

  return lines.join("\n");
}


function formatSummaryForDriverUz(docs, commonMeta = {}) {
  const { carModel, carColor, isCargo, cargoSize, tariffs } = commonMeta;

  const vu = docs.find((d) => d.docType === "vu_front");
  const tFront = docs.find((d) => d.docType === "tech_front");
  const tBack = docs.find((d) => d.docType === "tech_back");

  const fVu =
    (vu && vu.result && vu.result.parsed && vu.result.parsed.fields) || {};
  const fTf =
    (tFront && tFront.result && tFront.result.parsed && tFront.result.parsed.fields) ||
    {};
  const fTb =
    (tBack && tBack.result && tBack.result.parsed && tBack.result.parsed.fields) || {};

  // ПИНФЛ водителя (тот же приоритет, что и для операторов)
  // 🔧 PINFL haydovchi uchun — faqat haydovchilik guvohnomasidan
  const driverPinfl =
    fVu.pinfl ||
    fVu.driver_pinfl ||
    "—";


  let fam = "";
  let name = "";
  let otch = "";
  if (fVu.driver_name) {
    const parts = String(fVu.driver_name).trim().split(/\s+/);
    fam = parts[0] || "";
    name = parts[1] || "";
    otch = parts.slice(2).join(" ");
  }

  const licenseSeries = (fVu.license_series || "").trim();
  const licenseNumber = (fVu.license_number || "").trim();
  const licenseFullFromField = (fVu.license_full || "").trim();
  const licenseFullCombined = `${licenseSeries} ${licenseNumber}`.trim();
  const licenseFull = licenseFullFromField || licenseFullCombined || "—";

  const techSeries = (fTb.tech_series || "").trim();
  const techNumber = (fTb.tech_number || "").trim();
  const techFullFromField = (fTb.tech_full || "").trim();
  const techFullCombined = `${techSeries} ${techNumber}`.trim();
  const techFull = techFullFromField || techFullCombined || "—";

  const finalCarColor = fTf.car_color_text || carColor || "—";
  const finalCarModelForm = carModel || "—";
  const finalCarModelDoc = fTf.car_model_text || "—";

  const lines = [];

  lines.push("👤 Haydovchi ma'lumotlari");
  lines.push("");
  lines.push(`1. Familiya: ${fam || "—"}`);
  lines.push(`2. Ism: ${name || "—"}`);
  lines.push(`3. Otasining ismi: ${otch || "—"}`);
  lines.push(`4. Tug‘ilgan sana: ${fVu.birth_date || "—"}`);
  lines.push(
    `5. Haydovchilik guvohnomasi (seriya va raqam): ${licenseFull || "—"}`
  );
  lines.push(`6. Berilgan sana: ${fVu.issued_date || "—"}`);
  lines.push(`7. Amal qilish muddati: ${fVu.expiry_date || "—"}`);
  lines.push(`8. PINFL (agar ko‘rsatilgan bo‘lsa): ${driverPinfl}`);

  lines.push("");
  lines.push("🚗 Avtomobil ma'lumotlari");
  lines.push("");
  lines.push(`1. Davlat raqami: ${fTf.plate_number || "—"}`);
  lines.push(`2. Marka/model (hujjat bo‘yicha): ${finalCarModelDoc}`);
  lines.push(`3. Model (botda tanlangan): ${finalCarModelForm}`);
  lines.push(`4. Rangi: ${finalCarColor}`);
  lines.push(`5. Chiqarilgan yili: ${fTb.car_year || "—"}`);
  lines.push(`6. Kuzov/shassi raqami: ${fTb.body_number || "—"}`);
  lines.push(`7. Texpasport (seriya va raqam): ${techFull || "—"}`);

  if (isCargo) {
    lines.push("");
    lines.push("🚚 Yuk avtomobili ma'lumotlari");
    lines.push(`Kuzov o‘lchami: ${cargoSize || "—"}`);
  }

  if (tariffs && tariffs.length) {
    lines.push("");
    lines.push("📊 Tariflar:");
    lines.push(tariffs.join(", "));
  }

  return lines.join("\n");
}

async function sendDocsToOperators(chatId, session, options = {}) {
  const targetIds = new Set();
  for (const id of ADMIN_CHAT_IDS) {
    if (id) targetIds.add(id);
  }
  if (LOG_CHAT_ID) targetIds.add(LOG_CHAT_ID);

  if (!targetIds.size) {
    console.log("sendDocsToOperators: no ADMIN_CHAT_IDS or LOG_CHAT_ID");
    return;
  }

  const docs = [];
  const order = ["vu_front", "tech_front", "tech_back"];
  for (const t of order) {
    const d = session.docs[t];
    if (d && d.doc) docs.push(d.doc);
  }

  const commonMeta = {
    phone: session.phone,
    tg_id: chatId,
    carModel: session.carModelLabel,
    carColor: session.carColor,
    tariffs: session.assignedTariffs || [],
    isCargo: session.isCargo,
    cargoSize: session.cargoSizeCode,
    carBrandLabel: session.carBrandLabel,
  };


  const summaryText = formatSummaryForOperators(docs, commonMeta, options);

  const media = [];
  for (const t of order) {
    const d = session.docs[t];
    if (!d || !d.fileId) continue;
    const item = {
      type: "photo",
      media: d.fileId,
    };

    media.push(item);
  }

  for (const adminId of targetIds) {
    if (media.length >= 1) {
      try {
        const res = await fetch(`${TELEGRAM_API}/sendMediaGroup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: adminId,
            media,
          }),
        });
        if (!res.ok) {
          const txt = await res.text();
          console.error("sendMediaGroup error:", res.status, txt);
        }
      } catch (e) {
        console.error("sendMediaGroup exception:", e);
      }
    }

    await sendTelegramMessage(adminId, summaryText, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
  }
}

// ===== upload-doc интеграция =====

async function forwardDocToUploadDoc(telegramUpdate, meta) {
  if (!UPLOAD_DOC_URL) {
    console.error("forwardDocToUploadDoc: no UPLOAD_DOC_URL");
    return null;
  }
  try {
    const res = await fetch(UPLOAD_DOC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "telegram_bot",
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

// ===== helpers для session.data =====

function updateSessionDataFromFields(session, docType, f) {
  const d = session.data || (session.data = {});

  if (docType === "vu_front") {
    if (f.driver_name && !d.driverName) d.driverName = f.driver_name;
    if (f.driver_name) {
      const parts = String(f.driver_name).trim().split(/\s+/);
      if (!d.lastName && parts[0]) d.lastName = parts[0];
      if (!d.firstName && parts[1]) d.firstName = parts[1];
      if (!d.middleName && parts[2]) d.middleName = parts.slice(2).join(" ");
    }

    if (f.license_series && !d.licenseSeries) d.licenseSeries = f.license_series;
    if (f.license_number && !d.licenseNumber) d.licenseNumber = f.license_number;
    if (f.license_full && !d.licenseFull) d.licenseFull = f.license_full;

    if (f.birth_date && !d.birthDate) d.birthDate = f.birth_date;
    if (f.issued_date && !d.issuedDate) d.issuedDate = f.issued_date;
    if (f.expiry_date && !d.expiryDate) d.expiryDate = f.expiry_date;

    // 🔧 ВАЖНО: PINFL ТОЛЬКО С ВУ
    const pinflFromVu = f.pinfl || f.driver_pinfl;
    if (pinflFromVu) {
      if (!d.driverPinfl) d.driverPinfl = pinflFromVu;
      // d.pinfl считаем «водительским» и держим в синхроне с driverPinfl
      d.pinfl = pinflFromVu;
    }

  } else if (docType === "tech_front") {
    if (f.plate_number && !d.plateNumber) d.plateNumber = f.plate_number;
    if (f.owner_name && !d.ownerName) d.ownerName = f.owner_name;
    if (f.owner_address && !d.ownerAddress) d.ownerAddress = f.owner_address;

    // 🔧 PINFL владельца техпаспорта — в отдельное поле, НЕ трогаем d.pinfl
    const pinflFromTech = f.owner_pinfl || f.pinfl;
    if (pinflFromTech && !d.ownerPinfl) {
      d.ownerPinfl = pinflFromTech;
    }

  } else if (docType === "tech_back") {
    if (f.tech_series && !d.techSeries) d.techSeries = f.tech_series;
    if (f.tech_number && !d.techNumber) d.techNumber = f.tech_number;
    if (f.tech_full && !d.techFull) d.techFull = f.tech_full;

    if (f.car_year && !d.carYear) d.carYear = f.car_year;
    if (f.body_number && !d.bodyNumber) d.bodyNumber = f.body_number;
    if (f.engine_volume && !d.engineVolume) d.engineVolume = f.engine_volume;
    if (f.fuel_type && !d.fuelType) d.fuelType = f.fuel_type;
    if (f.vin && !d.vin) d.vin = f.vin;

    // 🔧 Если с оборота техпаспорта тоже где-то приходит PINFL — считаем его владельческим
    const pinflFromBack = f.pinfl_back;
    if (pinflFromBack && !d.ownerPinfl && !d.driverPinfl) {
      d.ownerPinfl = pinflFromBack;
    }
  }

  if (session.carModelLabel) d.carModelLabel = session.carModelLabel;
  if (session.carColor) d.carColor = session.carColor;
  if (session.phone) d.phone = session.phone;
}


function recomputeDerived(session) {
  const d = session.data || (session.data = {});
  const fioParts = [d.lastName, d.firstName, d.middleName].filter(Boolean);
  if (fioParts.length) d.driverName = fioParts.join(" ");

  if (d.licenseSeries || d.licenseNumber) {
    d.licenseFull = `${d.licenseSeries || ""} ${d.licenseNumber || ""}`.trim();
  }
  if (d.techSeries || d.techNumber) {
    d.techFull = `${d.techSeries || ""} ${d.techNumber || ""}`.trim();
  }
}

function applySessionDataToDocs(session) {
  const d = session.data || {};
  const map = session.docs || {};

  if (map.vu_front && map.vu_front.doc && map.vu_front.doc.result?.parsed) {
    const f = map.vu_front.doc.result.parsed.fields || {};
    if (d.licenseSeries) f.license_series = d.licenseSeries;
    if (d.licenseNumber) f.license_number = d.licenseNumber;
    if (d.licenseFull) f.license_full = d.licenseFull;
    if (d.driverName) f.driver_name = d.driverName;
    if (d.birthDate) f.birth_date = d.birthDate;
    if (d.issuedDate) f.issued_date = d.issuedDate;
    if (d.expiryDate) f.expiry_date = d.expiryDate;
    if (d.driverPinfl || d.pinfl) {
      f.pinfl = d.driverPinfl || d.pinfl;
      f.driver_pinfl = d.driverPinfl || d.pinfl;
    }
  }

  if (map.tech_front && map.tech_front.doc && map.tech_front.doc.result?.parsed) {
    const f = map.tech_front.doc.result.parsed.fields || {};
    if (d.plateNumber) f.plate_number = d.plateNumber;
    if (d.ownerName) f.owner_name = d.ownerName;
    if (d.ownerAddress) f.owner_address = d.ownerAddress;
    if (d.ownerPinfl) f.pinfl = d.ownerPinfl;
  }

  if (map.tech_back && map.tech_back.doc && map.tech_back.doc.result?.parsed) {
    const f = map.tech_back.doc.result.parsed.fields || {};
    if (d.techSeries) f.tech_series = d.techSeries;
    if (d.techNumber) f.tech_number = d.techNumber;
    if (d.techFull) f.tech_full = d.techFull;
    if (d.carYear) f.car_year = d.carYear;
    if (d.bodyNumber) f.body_number = d.bodyNumber;
    if (d.engineVolume) f.engine_volume = d.engineVolume;
    if (d.fuelType) f.fuel_type = d.fuelType;
    if (d.vin) f.vin = d.vin;
  }
}

function getFieldValue(session, key) {
  const d = session.data || {};
  if (key === "carModelLabel") return session.carModelLabel || d.carModelLabel;
  if (key === "carColor") return session.carColor || d.carColor;
  return d[key];
}

function setFieldValue(session, key, value) {
  const d = session.data || (session.data = {});
  if (key === "carModelLabel") {
    session.carModelLabel = value;
    d.carModelLabel = value;
  } else if (key === "carColor") {
    session.carColor = value;
    d.carColor = value;
  } else {
    d[key] = value;
  }
}

// ===== YANDEX FLEET API HELPERS =====

function ensureFleetConfigured() {
  if (!FLEET_CLIENT_ID || !FLEET_API_KEY || !FLEET_PARK_ID) {
    return {
      ok: false,
      message:
        "Yandex Fleet integratsiyasi sozlanmagan (FLEET_CLIENT_ID / FLEET_API_KEY / FLEET_PARK_ID).",
    };
  }
  return { ok: true };
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
async function callFleetGet(path, query) {
  const cfg = ensureFleetConfigured();
  if (!cfg.ok) {
    console.error("callFleetGet: fleet not configured:", cfg.message);
    return { ok: false, message: cfg.message };
  }

  let url = `${FLEET_API_BASE_URL}${path}`;
  if (query && Object.keys(query).length) {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    if (qs) url += `?${qs}`;
  }

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Client-ID": FLEET_CLIENT_ID,
        "X-API-Key": FLEET_API_KEY,
        "X-Park-ID": FLEET_PARK_ID,
      },
    });

    let json = null;
    try {
      json = await res.json();
    } catch (e) {
      // ignore
    }

    if (!res.ok) {
      console.error("callFleetGet error:", res.status, json);
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
    console.error("callFleetGet exception:", e);
    return { ok: false, message: String(e) };
  }
}

async function callFleetPostIdempotent(path, payload, idempotencyKey) {
  const cfg = ensureFleetConfigured();
  if (!cfg.ok) return { ok: false, message: cfg.message };

  const url = `${FLEET_API_BASE_URL}${path}`;
  const key =
    idempotencyKey ||
    `idemp-${Date.now()}-${Math.random().toString(16).slice(2)}`;

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
    return { ok: false, message: String(e) };
  }
}

/**
 * Привязка авто к водителю
 */
async function bindCarToDriver(driverId, vehicleId) {
  const cfg = ensureFleetConfigured();
  if (!cfg.ok) return { ok: false, error: cfg.message };

  if (!driverId || !vehicleId) {
    return {
      ok: false,
      error: "Нет driverId или vehicleId для привязки авто к водителю",
    };
  }

  const url = `${FLEET_API_BASE_URL}/v1/parks/driver-profiles/car-bindings` +
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
      // тело можно оставить пустым или минимальным
      body: JSON.stringify({}),
    });

    let json = null;
    try {
      json = await res.json();
    } catch (e) {}

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error:
          (json && (json.message || json.code)) ||
          `Yandex Fleet API xatosi: ${res.status}`,
        raw: json,
      };
    }

    return { ok: true, data: json };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ===== YANDEX FLEET: НАЧИСЛЕНИЕ БОНУСА ЧЕРЕЗ ТРАНЗАКЦИЮ =====

async function createDriverTransaction(driverId, amount, description) {
  const cfg = ensureFleetConfigured();
  if (!cfg.ok) {
    return { ok: false, error: cfg.message };
  }

  if (!driverId) {
    return { ok: false, error: "driverId is missing for transaction" };
  }

  const url = `${FLEET_API_BASE_URL}/v3/parks/driver-profiles/transactions`;

  const body = {
    park_id: FLEET_PARK_ID,
    driver_profile_id: driverId,
    // В Яндекс Флит обычно используется строка с числом в минимальных единицах
    amount: String(amount),
    currency: "UZS",
    category: "partner_service", // при желании можешь потом поменять
    description: description || "Bonus for registration via ASR TAXI bot",
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-ID": FLEET_CLIENT_ID,
        "X-API-Key": FLEET_API_KEY,
        "X-Park-ID": FLEET_PARK_ID,
      },
      body: JSON.stringify(body),
    });

    let json = null;
    try {
      json = await res.json();
    } catch (e) {
      // если тело пустое — просто игнорируем
    }

    if (!res.ok) {
      console.error("createDriverTransaction error:", res.status, json);
      return {
        ok: false,
        status: res.status,
        error:
          (json && (json.message || json.code)) ||
          `Yandex Fleet transactions error: ${res.status}`,
        raw: json,
      };
    }

    return { ok: true, data: json };
  } catch (e) {
    console.error("createDriverTransaction exception:", e);
    return { ok: false, error: String(e) };
  }
}

/**
 * Нормализация телефона
 */
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

function normalizeDriverLicenseNumber(countryCode, licenseSeries, licenseNumber, licenseFull) {
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

async function createDriverInFleet(driverPayload) {
  const cfg = ensureFleetConfigured();
  if (!cfg.ok) return { ok: false, error: cfg.message };

  const workRuleDefault = FLEET_WORK_RULE_ID_DEFAULT;
  const workRuleHunter = FLEET_WORK_RULE_ID_HUNTER;
  let workRuleId = workRuleDefault;

  if (driverPayload.isHunter && workRuleHunter) {
    workRuleId = workRuleHunter;
  }

  if (!workRuleId) {
    return {
      ok: false,
      error:
        "Не задан FLEET_WORK_RULE_ID_DEFAULT (и FLEET_WORK_RULE_ID_HUNTER). Нужно создать условия работы в таксопарке и записать их ID в переменные окружения.",
    };
  }

  const phoneNorm = normalizePhoneForYandex(driverPayload.phone);
  const todayIso = new Date().toISOString().slice(0, 10);
  const idempotencyKey = `driver-${FLEET_PARK_ID}-${phoneNorm || ""}`;

  const fullName = {
    first_name: driverPayload.first_name || driverPayload.firstName || "",
    last_name: driverPayload.last_name || driverPayload.lastName || "",
  };
  if (driverPayload.middle_name || driverPayload.middleName) {
    fullName.middle_name =
      driverPayload.middle_name || driverPayload.middleName;
  }

  const issuedISO = normalizeDateToISO(driverPayload.issuedDate);
  const expiryISO = normalizeDateToISO(driverPayload.expiryDate);
  const birthISO = normalizeDateToISO(driverPayload.birthDate);

  const countryCode = (FLEET_DEFAULT_LICENSE_COUNTRY || "UZB").toUpperCase();
  const driverLicenseNumber = normalizeDriverLicenseNumber(
    countryCode,
    driverPayload.licenseSeries,
    driverPayload.licenseNumber,
    driverPayload.licenseFull
  );

  if (driverLicenseNumber) {
    driverPayload.licenseFull = driverLicenseNumber;
  }

  let license = undefined;
  if (driverLicenseNumber) {
    license = {
      number: driverLicenseNumber,
      country: countryCode,
      issue_date: issuedISO,
      expiry_date: expiryISO,
      birth_date: birthISO,
    };
  }

  const totalSince = issuedISO || expiryISO || birthISO || "2005-01-01";

  let employmentType =
    (FLEET_DEFAULT_EMPLOYMENT_TYPE || "selfemployed").toLowerCase();
  if (employmentType !== "selfemployed" && employmentType !== "individual") {
    employmentType = "selfemployed";
  }

  let taxIdRaw =
    (driverPayload.taxId && String(driverPayload.taxId).trim()) ||
    (driverPayload.pinfl && String(driverPayload.pinfl).trim()) ||
    "";

  const taxDigits = taxIdRaw.replace(/\D/g, "");

  if (!taxDigits) {
    return {
      ok: false,
      error:
        "Для регистрации водителя в Yandex Fleet не найден PINFL (tax_identification_number). Нужен корректный PINFL из документов.",
      code: "missing_pinfl_for_driver",
    };
  }

  const balanceLimit = driverPayload.isCargo ? "15000" : "5000";

  const account = {
    balance_limit: balanceLimit,
    block_orders_on_balance_below_limit: false,
    work_rule_id: workRuleId,
  };

  if (FLEET_PAYMENT_SERVICE_ID) {
    account.payment_service_id = FLEET_PAYMENT_SERVICE_ID;
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
    tax_identification_number: taxDigits,
  };

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
      comment: driverPayload.comment || undefined,
    },
  };

  const res = await callFleetPostIdempotent(
    "/v2/parks/contractors/driver-profile",
    body,
    idempotencyKey
  );

  if (!res.ok) {
    return {
      ok: false,
      error: res.message || "driver create error",
      raw: res.raw,
    };
  }

  const data = res.data || {};

  let driverId =
    data.id ||
    (data.profile && data.profile.id) ||
    (data.contractor_profile && data.contractor_profile.id) ||
    (data.driver_profile && data.driver_profile.id) ||
    data.driver_profile_id ||
    data.contractor_profile_id ||
    null;

  if (!driverId && driverPayload.phone) {
    const found = await findDriverByPhone(driverPayload.phone);
    if (found.ok && found.found && found.driver && found.driver.id) {
      driverId = found.driver.id;
    }
  }

  if (!driverId) {
    return {
      ok: false,
      error:
        "Yandex Fleet не вернул id водителя (после create и поиска по телефону)",
      raw: data,
    };
  }

  return { ok: true, driverId, raw: data };
}

/**
 * Создание автомобиля
 */
async function createCarInFleet(carPayload, session) {
  const cfg = ensureFleetConfigured();
  if (!cfg.ok) return { ok: false, error: cfg.message };

  const yandexColor = mapColorToYandex(session);

  const baseTariffs = Array.isArray(carPayload.tariffs)
    ? carPayload.tariffs
    : [];
  const categories = baseTariffs
    .map((t) => TARIFF_CATEGORY_MAP[t])
    .filter(Boolean);

  // 🔴 По ТЗ: при создании авто включаем все основные тарифы,
  // оператор потом отключает лишние.
  const ALL_TARIFF_CATEGORIES = [
    "econom",        // Start / Econom
    "comfort",       // Comfort
    "comfort_plus",  // Comfort+
    "electric",      // Electro
    "business",      // Business
    "vip",           // Premier
    "express",       // Delivery / Express
    "cargo",         // грузовые
  ];

  for (const c of ALL_TARIFF_CATEGORIES) {
    if (!categories.includes(c)) categories.push(c);
  }

  // Если включали Delivery — отмечаем это дополнительно в amenities (ниже)


  const yearInt = parseInt(carPayload.year, 10);
  const nowYear = new Date().getFullYear();
  if (!yearInt || yearInt < 1980 || yearInt > nowYear + 1) {
    return {
      ok: false,
      error:
        "Год выпуска авто не распознан или выходит за допустимые рамки. Авто нельзя автоматически создать, его нужно будет добавить оператору вручную.",
      code: "car_year_invalid",
    };
  }

  if (!carPayload.plate_number) {
    return {
      ok: false,
      error:
        "Госномер не распознан. Авто нельзя автоматически создать, его нужно будет добавить оператору вручную.",
      code: "plate_missing",
    };
  }

  // 🔴 Правильный объект vehicle_specifications (обязательные поля)
  const vehicleSpecifications = {
    brand: carPayload.brand || "",          // Марка ТС (обязательно)
    model: carPayload.model || "",          // Модель ТС (обязательно)
    color: yandexColor,                     // Цвет ТС из ColorEnum (обязательно)
    year: yearInt,                          // Год выпуска (обязательно)
    transmission: FLEET_DEFAULT_TRANSMISSION || "automatic", // Transmission (обязательно)
  };

  // Необязательные, но полезные поля
  if (carPayload.body_number) {
    vehicleSpecifications.body_number = carPayload.body_number;
  }
  if (carPayload.vin) {
    vehicleSpecifications.vin = carPayload.vin;
  }

  // 🔧 ВАЖНО: park_profile БЕЗ ownership_type / is_park_property
  const parkProfile = {
    callsign: carPayload.call_sign || undefined,
    status: "working",
    categories: categories.length ? categories : undefined,
    fuel_type: carPayload.fuel_type || FLEET_DEFAULT_FUEL_TYPE,
  };

  // Если включали Delivery — отмечаем это в amenities
  if (session.wantsDelivery) {
    parkProfile.amenities = ["delivery"];
  }

  const vehicleLicenses = {
    licence_plate_number: carPayload.plate_number,
    registration_certificate:
      carPayload.tech_full || carPayload.tech_number || "",
  };

  const idempotencyKey = `car-${FLEET_PARK_ID}-${
    carPayload.plate_number || ""
  }`;

  // 🔴 Отдельный объект cargo по спецификации Яндекса
  let cargo = undefined;
  if (carPayload.is_cargo && carPayload.cargo_dimensions) {
    let carrying = 500;
    if (session.cargoSizeCode && session.cargoSizeCode.startsWith("M"))
      carrying = 800;
    if (session.cargoSizeCode && session.cargoSizeCode.startsWith("L"))
      carrying = 1500;
    if (session.cargoSizeCode === "XL") carrying = 2000;
    if (session.cargoSizeCode === "XXL") carrying = 2500;

    cargo = {
      carrying_capacity: carrying,
      cargo_hold_dimensions: {
        length: carPayload.cargo_dimensions.length,
        width: carPayload.cargo_dimensions.width,
        height: carPayload.cargo_dimensions.height,
      },
    };
  }

  // 🔴 Финальное тело запроса /v2/parks/vehicles/car
  const body = {
    park_profile: parkProfile,
    vehicle_licenses: vehicleLicenses,
    vehicle_specifications: vehicleSpecifications,
  };

  if (cargo) {
    body.cargo = cargo;
  }

  const res = await callFleetPostIdempotent(
    "/v2/parks/vehicles/car",
    body,
    idempotencyKey
  );

  if (!res.ok) {
    return {
      ok: false,
      error: res.message || "car create error",
      raw: res.raw,
    };
  }

  const data = res.data || {};
  const carId = data.vehicle_id || data.id || null;

  if (!carId) {
    return {
      ok: false,
      error: "Yandex Fleet не вернул id автомобиля",
      raw: data,
    };
  }

  return { ok: true, carId, raw: data };
}


/**
 * Поиск водителя по телефону (рабочий вариант как в хантер-боте)
 */
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

/**
 * Поиск водителя по номеру водительского удостоверения
 * licenseCandidatesRaw — строка или массив вариантов (серия+номер в разных форматах)
 */
async function findDriverByLicense(licenseCandidatesRaw) {
  const cfg = ensureFleetConfigured();
  if (!cfg.ok) {
    return { ok: false, found: false, error: cfg.message };
  }

  // Собираем кандидатов
  let candidates = [];
  if (Array.isArray(licenseCandidatesRaw)) {
    candidates = licenseCandidatesRaw.filter(Boolean);
  } else if (licenseCandidatesRaw) {
    candidates = [licenseCandidatesRaw];
  }

  const countryCode = (FLEET_DEFAULT_LICENSE_COUNTRY || "UZB").toUpperCase();

  // Нормализуем коды ВУ так же, как мы отдаем их в Яндекс
  const normalizedSet = new Set();
  const digitsSet = new Set();

  for (const raw of candidates) {
    const n = normalizeDriverLicenseNumber(
      countryCode,
      null,
      null,
      raw
    );
    if (!n) continue;

    normalizedSet.add(n);
    digitsSet.add(n.replace(/\D/g, ""));
  }

  if (!normalizedSet.size && !digitsSet.size) {
    // Нечего искать — считаем, что просто не нашли
    return { ok: true, found: false };
  }

  // Достаём всех водителей парка и смотрим их driver_license
  const body = {
    limit: 1000,
    offset: 0,
    query: {
      park: { id: FLEET_PARK_ID },
    },
    fields: {
      driver_profile: [
        "id",
        "first_name",
        "last_name",
        "middle_name",
        "driver_license",
        "phones",
      ],
    },
  };

  const res = await callFleetPost("/v1/parks/driver-profiles/list", body);
  if (!res.ok) {
    console.error("findDriverByLicense: fleet error:", res);
    return { ok: false, found: false, error: res.message };
  }

  const profiles = (res.data && res.data.driver_profiles) || [];
  if (!profiles.length) {
    return { ok: true, found: false };
  }

  for (const item of profiles) {
    const dp = (item && item.driver_profile) || {};

    // Достаём номер ВУ у профиля
    let licenseNumber = null;
    const lic = dp.driver_license;

    if (Array.isArray(lic) && lic.length) {
      licenseNumber = lic[0].number || lic[0].license_number || null;
    } else if (lic && typeof lic === "object") {
      licenseNumber = lic.number || lic.license_number || null;
    }

    if (!licenseNumber) continue;

    const n = normalizeDriverLicenseNumber(
      countryCode,
      null,
      null,
      licenseNumber
    );
    if (!n) continue;

    const nDigits = n.replace(/\D/g, "");

    const hit =
      normalizedSet.has(n) ||
      digitsSet.has(nDigits);

    if (!hit) continue;

    // Совпадение найдено — собираем инфу по водителю
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

    const phone = phonesRaw[0] || null;
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
        phone,
        status,
        license_number: n,
      },
    };
  }

  return { ok: true, found: false };
}

/**
 * Проверка статуса по телефону
 */
/**
 * Проверка статуса по телефону + простой чек по балансу
 */
/**
 * Проверка статуса по телефону + вытягивание баланса, если водитель найден
 */
async function checkYandexStatus(phone) {
  const found = await findDriverByPhone(phone);

  if (!found.ok) {
    return {
      ok: false,
      status: "unknown",
      message: found.error || "Yandex Fleet bilan bog‘lanib bo‘lmadi",
    };
  }

  if (!found.found) {
    return {
      ok: true,
      status: "pending",
      message: "Haydovchi hozircha topilmadi",
    };
  }

  let balanceInfo = null;
  if (found.driver && found.driver.id) {
    balanceInfo = await getDriverBalanceInfo(found.driver.id);
  }

  return {
    ok: true,
    status: (found.driver && found.driver.status) || "registered",
    driver: found.driver,
    balance: balanceInfo && balanceInfo.ok ? balanceInfo.balance : null,
    blocked: balanceInfo && balanceInfo.ok ? balanceInfo.blocked : null,
    balanceDetails:
      balanceInfo && balanceInfo.ok ? balanceInfo.details : null,
    balanceError: balanceInfo && !balanceInfo.ok ? balanceInfo.error : null,
  };
}



function buildDriverMenuKeyboard() {
  return {
    keyboard: [
      // 📊 Раздел "Счет и баланс"
      [{ text: "📊 Hisob va balans" }],
      [
        { text: "🩺 Hisob diagnostikasi" },
        { text: "💳 Balansni to‘ldirish" },
        { text: "💸 Mablag‘ni yechib olish" },
      ],

      // 🚕 Раздел "Работа и заказы"
      [{ text: "🚕 Buyurtmalar va ish" }],
      [
        { text: "📸 Fotokontrol bo‘yicha yordam" },
        { text: "📍 GPS xatoliklari" },
        { text: "🎯 Maqsadlar va bonuslar" },
      ],

      // 📄 Раздел "Документы"
      [{ text: "📄 Hujjatlar" }],
      [{ text: "📄 Litsenziya va OSAGO" }],

      // 🤝 Раздел "Связь и бонусы"
      [{ text: "🤝 Aloqa va bonuslar" }],
      [
        { text: "🤝 Do‘stni taklif qilish" },
        { text: "🎥 Video qo‘llanma" },
        { text: "👨‍💼 Operator bilan aloqa" },
      ],
    ],
    resize_keyboard: true,
  };
}



// 🔧 НОВОЕ: если телефон не сохранён (после рестарта), просим его заново
async function ensurePhoneForStatus(chatId, session) {
  const existing =
    session.phone || (session.data && session.data.phone);
  if (existing) return existing;

  session.step = "waiting_phone_for_status";

  await sendTelegramMessage(
    chatId,
    "Hisobingiz bo‘yicha diagnostika qilish uchun telefon raqamingiz kerak.\n" +
      "Iltimos, quyidagi tugma orqali telefon raqamingizni yuboring.",
    {
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
    }
  );

  return null;
}


async function openDriverCabinet(chatId, session, driverInfo) {
  if (driverInfo) {
    session.isExistingDriver = true;
    session.driverFleetId = driverInfo.id || null;
    session.driverName = driverInfo.name || null;
    if (driverInfo.phone) {
      session.inviterPhone = driverInfo.phone;
    }
  }

  session.step = "driver_menu";

  const name = session.driverName || "haydovchi";

  const text =
    `👋 Assalomu alaykum, *${name}*!\n\n` +
    "Bu yerda sizning *ASR TAXI shaxsiy kabinetingiz*.\n" +
    "Quyidagi menyudan kerakli bo‘limni tanlang.";

  await sendTelegramMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: buildDriverMenuKeyboard(),
  });
}

async function handleMenuAction(chatId, session, action) {
  switch (action) {
    case "status": {
      // диагностика "всё ли в порядке"
      let phone =
        session.phone || (session.data && session.data.phone);

      if (!phone) {
        // если телефона нет (новый инстанс функции) — просим его
        await ensurePhoneForStatus(chatId, session);
        return;
      }

      await sendTelegramMessage(
        chatId,
        "⏳ Hisobingiz bo‘yicha diagnostika o‘tkazilyapti (Yandex tizimi bilan bog‘lanmoqdaman)..."
      );

      const res = await checkYandexStatus(phone);

      if (!res.ok) {
        await sendTelegramMessage(
          chatId,
          `❗️ Diagnostika vaqtida xatolik yuz berdi: ${res.message || ""}\n\n` +
            "Iltimos, birozdan keyin yana urinib ko‘ring yoki operatorga yozing: @AsrTaxiAdmin."
        );
        return;
      }

      const baseAdvice =
        "\n\nAgar baribir buyurtmalar kelmasa, ilovadagi *«Diagnostika»* bo‘limini tekshirib chiqing va quyidagilarni ko‘ring:\n" +
        "• GPS yoqilganmi va aniqlik rejimida ishlayaptimi\n" +
        "• Selfi-fotokontrol talab qilinmaganmi\n" +
        "• Oxirgi 7 kun ichida onlayn bo‘lganmisiz\n" +
        "• Balansingiz manfiy holatga tushib qolmaganmi\n\n" +
        "Qiyinchilik bo‘lsa — operatorga murojaat qiling: @AsrTaxiAdmin.";

      const fmtMoney = (v) =>
        v === null || v === undefined ? "—" : String(v);

      let balancePart = "";
      if (res.balance !== null && res.balance !== undefined) {
        balancePart =
          "\n\n💳 *Balans ma'lumotlari:*\n" +
          `• Joriy balans: ${fmtMoney(res.balance)}\n` +
          `• Bloklangan balans: ${fmtMoney(res.blocked)}`;

        if (res.balanceDetails) {
          const d = res.balanceDetails;
          balancePart +=
            "\n" +
            `  – Bonuslar (blocked_bonuses): ${fmtMoney(d.blockedBonuses)}\n` +
            `  – Naqd pulsiz tushum (blocked_cashless): ${fmtMoney(d.blockedCashless)}\n` +
            `  – Moliyaviy hisobotlar (blocked_financial_statements): ${fmtMoney(d.blockedFinancialStatements)}\n` +
            `  – Yopuvchi hujjatlar (blocked_closing_documents): ${fmtMoney(d.blockedClosingDocuments)}\n` +
            `  – Choypuli (blocked_tips): ${fmtMoney(d.blockedTips)}`;
        }
      }

      const statusHuman = humanizeDriverStatusUz(res.status);

      if (res.status === "working" || res.status === "registered") {
        await sendTelegramMessage(
          chatId,
          "✅ *Diagnostika: hisobingiz faol, buyurtmalarni qabul qilishga tayyor.*\n" +
            `Joriy holat: *${statusHuman}*.` +
            balancePart +
            baseAdvice,
          { parse_mode: "Markdown" }
        );
      } else if (res.status === "pending") {
        await sendTelegramMessage(
          chatId,
          "ℹ️ *Bu telefon raqami bo‘yicha parkda faol haydovchi topilmadi.*\n" +
            "Agar hali ulanish jarayonini tugatmagan bo‘lsangiz — botdagi ro‘yxatdan o‘tish bosqichlarini yakunlang.\n" +
            "Agar siz allaqachon ishlayotgan bo‘lsangiz, telefon raqamingizni tekshirtirish uchun operatorga yozing: @AsrTaxiAdmin.",
          { parse_mode: "Markdown" }
        );
      } else if (res.status === "fired") {
        await sendTelegramMessage(
          chatId,
          "❗️ *Diagnostika: hisobingiz parkda bloklangan (status: fired).* \n" +
            `Holat: *${statusHuman}*.` +
            balancePart +
            "\n\nTafsilotlar uchun operatorga murojaat qiling: @AsrTaxiAdmin.",
          { parse_mode: "Markdown" }
        );
      } else {
        await sendTelegramMessage(
          chatId,
          `ℹ️ *Diagnostika natijasi:* \`${res.status}\` ( ${statusHuman} ).` +
            balancePart +
            baseAdvice,
          { parse_mode: "Markdown" }
        );
      }

      break;
    }



    case "photocontrol": {
      await sendTelegramMessage(
        chatId,
        "📸 *Fotokontrol bo‘yicha yo‘riqnoma*\n\n" +
          "• Suratni yorug‘ joyda, soyasiz va yaltiramagan holda oling.\n" +
          "• Yuzingiz to‘liq ko‘rinib tursin, ko‘zoynak va bosh kiyimsiz.\n" +
          "• Avtomobil raqami aniq o‘qiladigan bo‘lsin.\n\n" +
          "Agar fotokontrol o‘tmasa — operator bilan bog‘laning: @AsrTaxiAdmin",
        { parse_mode: "Markdown" }
      );
      break;
    }

    case "gps": {
      await sendTelegramMessage(
        chatId,
        "📍 *GPS xatoliklarini bartaraf etish*\n\n" +
          "1. Telefoningizda geolokatsiyani yoqing.\n" +
          "2. Yandex Pro ilovasiga geodanniyalarga ruxsat bering.\n" +
          "3. Geolokatsiya rejimini *yuqori aniqlik*ga o‘rnating.\n" +
          "4. Ilovani qayta ishga tushiring.\n\n" +
          "Muammo hal bo‘lmasa — operatorga yozing: @AsrTaxiAdmin",
        { parse_mode: "Markdown" }
      );
      break;
    }

    case "goals": {
      await sendTelegramMessage(
        chatId,
        "🎯 *Maqsadlar va bonuslar*\n\n" +
          "• Yandex Pro ilovasidagi *«Maqsadlar»* bo‘limida shaxsiy bonuslaringizni ko‘rasiz.\n" +
          "• Kerakli miqdordagi buyurtmalarni bajaring va qo‘shimcha to‘lovlar oling.\n" +
          "• Savollar bo‘lsa, operatorga murojaat qiling: @AsrTaxiAdmin.",
        { parse_mode: "Markdown" }
      );
      break;
    }

    case "topup": {
      await sendTelegramMessage(
        chatId,
        "💳 *Balansni to‘ldirish*\n\n" +
          "Balansni quyidagi usullar bilan to‘ldirishingiz mumkin:\n\n" +
          "• PayMe\n" +
          "• PayNet\n" +
          "• @AsrPulBot — bot orqali kartadan to‘lov.\n\n" +
          "Aniq rekvizitlar va yo‘riqnoma uchun operator bilan bog‘laning: @AsrTaxiAdmin.",
        { parse_mode: "Markdown" }
      );
      break;
    }

    case "withdraw": {
      await sendTelegramMessage(
        chatId,
        "💸 *Mablag‘ni yechib olish*\n\n" +
          "Pul yechish faqat *@AsrPulBot* orqali amalga oshiriladi.\n" +
          "Botga o‘ting va ko‘rsatmalarga amal qiling.\n\n" +
          "Savollar bo‘lsa — operatorga yozing: @AsrTaxiAdmin.",
        { parse_mode: "Markdown" }
      );
      break;
    }

    case "license": {
      await sendTelegramMessage(
        chatId,
        "📄 *Litsenziya va OSAGO (OSGOP)*\n\n" +
          "Parkda ishlash uchun amal qiluvchi litsenziya va OSAGO talab qilinadi.\n\n" +
          "Umumiy tartib:\n" +
          "1. @AsrPulBot orqali samozanyatlikdan o‘tasiz.\n" +
          "2. Park yo‘riqnomasi bo‘yicha litsenziya va OSAGO olasiz.\n" +
          "3. Hujjatlarni operatorga yuborasiz, u ularni tizimga yuklaydi.\n\n" +
          "Batafsil yo‘riqnoma uchun operatorga yozing: @AsrTaxiAdmin.",
        { parse_mode: "Markdown" }
      );
      break;
    }

    case "invite": {
      // Формируем реферальную ссылку вида t.me/<bot>?start=friend_<driverId>
      const driverId = session.driverFleetId || null;
      const botUsername =
        process.env.TELEGRAM_BOT_USERNAME || "YOUR_BOT_USERNAME";

      let inviteText =
        "🤝 *Do‘stni taklif qilish*\n\n" +
        "Do‘stingizni ASR TAXI parkiga taklif qiling va aksiya shartlariga ko‘ra bonuslarga ega bo‘ling.\n\n";

      if (driverId) {
        const link = `https://t.me/${botUsername}?start=friend_${driverId}`;
        inviteText +=
          "Quyidagi havolani do‘stingizga yuboring. U shu havola orqali botni ochib, ro‘yxatdan o‘tadi:\n\n" +
          `[Do‘stni taklif qilish havolasi](${link})\n\n` +
          "Do‘st ro‘yxatdan o‘tgandan so‘ng u ham 50 000 so‘м bonus oladi (park qoidalariga muvofiq).";
      } else {
        inviteText +=
          "Hozircha sizning driver ID’ingiz aniqlanmadi. Operator bilan bog‘lanib, referal havolani so‘rashingiz mumkin: @AsrTaxiAdmin.";
      }

      await sendTelegramMessage(chatId, inviteText, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
      break;
    }



    case "video": {
      await sendTelegramMessage(
        chatId,
        "🎥 *Video qo‘llanma*\n\n" +
          "Ro‘yxatdan o‘tish va ulanishning asosiy bosqichlari shu botda tushuntirilgan.\n" +
          "Alohida video-yo‘riqnoma tayyor bo‘lgach, operator sizga havolani yuboradi.\n\n" +
          "Hozirning o‘zida yordam kerak bo‘lsa — operatorga yozing: @AsrTaxiAdmin.",
        { parse_mode: "Markdown" }
      );
      break;
    }

    case "operator": {
      await sendTelegramMessage(
        chatId,
        "👨‍💼 *Operator bilan aloqa*\n\n" +
          "Tezkor aloqa uchun operatorga Telegram’da yozing: @AsrTaxiAdmin",
        { parse_mode: "Markdown" }
      );
      await sendOperatorAlert(
        "*Запрос связи с оператором из бота ASR TAXI*\n\n" +
          `Chat ID: \`${chatId}\``
      );
      break;
    }

    default:
      break;
  }
}

// ===== ЛОГИКА ШАГОВ РЕГИСТРАЦИИ =====

async function handleStart(chatId, session) {
  session.step = "waiting_phone";

  const text =
    "👋 Assalomu alaykum!\n\n" +
    "Ushbu bot sizga *ASR TAXI* parkiga ulanishga yordam beradi.\n\n" +
    "1️⃣ Avval telefon raqamingizni yuboring.\n" +
    "2️⃣ Bot Yandex tizimida raqamingizni tekshiradi.\n" +
    "3️⃣ Agar allaqachon ro‘yxatdan o‘tgan bo‘lsangiz — *shaxsiy kabinet*ni ochamiz.\n" +
    "4️⃣ Agar yo‘q bo‘lsa — yangi ro‘yxatdan o‘tish jarayonini boshlaymiz.";

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
        [{ text: STOP_REGISTRATION_TEXT }],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  });
}

async function askPlateNumber(chatId, session) {
  session.step = "waiting_plate";

  const text =
    "🚘 Iltimos, avtomobilingizning *davlat raqamini* yozing.\n" +
    "Masalan: `01A123BC` yoki `01 A 123 BC`.\n\n" +
    "Raqamni faqat matn bilan yuboring.";
  await sendTelegramMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: getStopKeyboard(),
  });
}

async function askCarBrand(chatId, session) {
  session.step = "waiting_car_brand";

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
    "🚗 Avtomobil *markasini* quyidagi ro‘yxatdan tanlang.\n\n" +
    "Agar yuk mashinasi bo‘lsa — «Yuk avtomobillari» bandini tanlang.";

  await sendTelegramMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: rows,
    },
  });
}

async function askCarModelForBrand(chatId, session) {
  const brandCode = session.carBrandCode;
  const brandLabel = session.carBrandLabel;
  const models = CAR_MODELS_INDEX[brandCode] || [];

  session.step = "waiting_car_model";

  if (!models.length) {
    await sendTelegramMessage(
      chatId,
      "Bu marka uchun modellarning ichki ro‘yxati topilmadi. Operator avtomobilingizni qo‘lda qo‘shadi."
    );
    await askDocTechFront(chatId, session);
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
    `🚗 Marka: *${brandLabel}*\n\n` +
    "Endi *avtomobil modelini* tanlang:";

  await sendTelegramMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: rows,
    },
  });
}

async function askCarColor(chatId, session) {
  session.step = "waiting_car_color";

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
    "🎨 Avtomobil rangini tanlang.\n\n" +
    "Quyidagi tugmalardan foydalaning yoki kerak bo‘lsa rangni matn bilan yuboring.";

  await sendTelegramMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: rows,
    },
  });
}

async function askCargoSize(chatId, session) {
  session.step = "waiting_cargo_size";

  const rows = [];
  for (const key of ["S", "M", "L", "XL", "XXL"]) {
    const size = CARGO_SIZES[key];
    if (!size) continue;
    rows.push([
      {
        text: size.label,
        callback_data: `cargo_size:${size.code}`,
      },
    ]);
  }

  const text =
    "🚚 Kuzov o‘lchamini tanlash\n\n" +
    "Agar realdan katta kuzov tanlasangiz — *Yandex akkauntingiz bloklanishi mumkin*.\n\n" +
    "Kuzov o‘lchamini *aniq* tanlang:";

  await sendTelegramMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: rows,
    },
  });
}

async function askDocVuFront(chatId, session) {
  session.step = "waiting_vu_front";
  const text =
    "📄 Endi haydovchilik guvohnomangizning *old tomonini* rasmga olib yuboring.\n\n" +
    "Foto aniq, yorug‘lik yaxshi, matn o‘qiladigan bo‘lsin. Yaltirash va xiralik bo‘lmasin.";
  await sendTelegramMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: getStopKeyboard(),
  });
}


async function askDocTechFront(chatId, session) {
  session.step = "waiting_tech_front";
  const text =
    "📄 Endi avtomobil *texpasportining old tomonini* yuboring.\n\n" +
    "Foto aniq va to‘liq hujjat ko‘rinadigan bo‘lsin.";
  await sendTelegramMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: getStopKeyboard(),
  });
}

async function askDocTechBack(chatId, session) {
  session.step = "waiting_tech_back";
  const text =
    "📄 Va nihoyat, texpasportning *orqa tomonini* yuboring.\n\n" +
    "Bu yerdan avtomobil yili, kuzov raqami va boshqa ma'lumotlar olinadi.";
  await sendTelegramMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: getStopKeyboard(),
  });
}


// Вопрос про Delivery
async function askDeliveryOption(chatId, session) {
  session.step = "waiting_delivery_choice";

  const text =
    "📦 *Delivery (yetkazib berish) opsiyasi*\n\n" +
    "Siz taksi bilan bir qatorda *Delivery* (yetkazib berish) buyurtmalarini ham qabul qilishingiz mumkin.\n\n" +
    "Delivery faqat sizning roziligingiz bilan yoqiladi.\n\n" +
    "Delivery ulashni xohlaysizmi?";

  await sendTelegramMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Ha, Delivery ni ulash", callback_data: "delivery_yes" },
          { text: "❌ Yo‘q, faqat taksi", callback_data: "delivery_no" },
        ],
      ],
    },
  });
}

// ===== подтверждение и редактирование =====

async function startFirstConfirmation(chatId, session) {
  session.confirmStage = "first";
  session.step = "confirm_summary_1";

  recomputeDerived(session);
  applySessionDataToDocs(session);

  const docs = [];
  const order = ["vu_front", "tech_front", "tech_back"];
  for (const t of order) {
    const d = session.docs[t];
    if (d && d.doc) docs.push(d.doc);
  }

  const driverSummary = formatSummaryForDriverUz(docs, {
    carModel: session.carModelLabel,
    carColor: session.carColor,
    isCargo: session.isCargo,
    cargoSize: session.cargoSizeCode,
    tariffs: session.assignedTariffs || [],
  });

  const text =
    driverSummary +
    "\n\n" +
    "🔎 Iltimos, barcha ma'lumotlarni diqqat bilan tekshiring.\n" +
    "Agar hammasi to‘g‘ri bo‘lsa — *«Ha, hammasi to‘g‘ri»* tugmasini bosing.\n" +
    "Agar nimanidir o‘zgartirish kerak bo‘lsa — *«O‘zgartirish»* tugmasini bosing.";

  await sendTelegramMessage(chatId, text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Ha, hammasi to‘g‘ri", callback_data: "confirm1_yes" },
          { text: "✏️ O‘zgartirish", callback_data: "confirm1_edit" },
        ],
      ],
    },
  });
}

async function startSecondConfirmation(chatId, session) {
  session.confirmStage = "second";
  session.step = "confirm_summary_2";

  const text =
    "‼️ Iltimos, *yana bir bor* barcha ma'lumotlarni sinchiklab tekshiring.\n\n" +
    "Tasdiqlash orqali siz barcha ma'lumotlar to‘g‘ri ekanini tasdiqlaysiz.\n\n" +
    "Agar ishonchingiz komil bo‘lsa — *«Ha, tasdiqlayman»* tugмасини bosing.\n" +
    "Agar nimanidir o‘zgartirmoqchi bo‘lsangiz — *«O‘zgartirish»* tugmasини bosing.";

  await sendTelegramMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "✅ Ha, tasdiqlayman",
            callback_data: "confirm2_yes",
          },
          {
            text: "✏️ O‘zgartirish",
            callback_data: "confirm2_edit",
          },
        ],
      ],
    },
  });
}

async function askNextEditField(chatId, session) {
  const idx = session.editIndex || 0;
  if (idx >= EDIT_FIELDS.length) {
    await startFirstConfirmation(chatId, session);
    return;
  }

  const field = EDIT_FIELDS[idx];
  session.currentFieldKey = field.key;
  session.editAwaitingValue = false;
  session.step = "editing_field";

  const currentValue = getFieldValue(session, field.key) || "ko‘rsatilmagan";

  const text =
    `Maydon: *${field.label}*\n` +
    `Joriy qiymat: \`${currentValue}\`.\n\n` +
    "Agar shu holatda qoldirmoqchi bo‘lsangiz — *«Tasdiqlash»* tugmasini bosing.\n" +
    "Agar o‘zgartirmoqchi bo‘lsangiz — *«O‘zgartirish»* tugmasini bosing.";

  await sendTelegramMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Tasdiqlash", callback_data: "edit_field_confirm" },
          { text: "✏️ O‘zgartirish", callback_data: "edit_field_change" },
        ],
      ],
    },
  });
}

// ===== АВТО-РЕГИСТРАЦИЯ В YANDEX FLEET =====

// ===== АВТО-РЕГИСТРАЦИЯ В YANDEX FLEET (2 ЭТАПА) =====

async function autoRegisterInYandexFleet(chatId, session) {
  const d = session.data || {};
  const brandCode = session.carBrandCode;
  const brandLabel = session.carBrandLabel;
  const phone = session.phone || d.phone;

  // 1) Определяем тарифы по машине / грузовой
  let tariffsInfo = { tariffs: [], hasRules: false };

  if (brandCode && !session.isCargo) {
    const shortModel =
      (session.carModelLabel || "").replace(`${brandLabel} `, "").trim();
    tariffsInfo = getTariffsForCar(brandCode, shortModel, d.carYear);
    session.assignedTariffs = tariffsInfo.tariffs || [];
  } else if (session.isCargo) {
    session.assignedTariffs = ["Cargo"];
    tariffsInfo = { tariffs: ["Cargo"], hasRules: true };
  }

  // если по машине не нашли правил — считаем, что авто может быть только вручную
  if (!tariffsInfo.hasRules) {
    session.registerWithoutCar = true;
  }

  // 2) Разбираем марку/модель из выбранного текста
  const { brand, model } = splitCarBrandModel(session.carModelLabel || "");
  const nowYear = new Date().getFullYear();
  const carYearInt = parseInt(d.carYear, 10);

  // Можно ли вообще пытаться создать авто?
  let canCreateCar = !session.registerWithoutCar;
  if (canCreateCar) {
    if (!brand || !d.plateNumber) {
      canCreateCar = false;
      session.registerWithoutCar = true;
    }
  }
  if (canCreateCar) {
    if (!carYearInt || carYearInt < 1980 || carYearInt > nowYear + 1) {
      canCreateCar = false;
      session.registerWithoutCar = true;
    }
  }

  // ========== ЭТАП 1/2: СОЗДАНИЕ ПРОФИЛЯ ВОДИТЕЛЯ ==========

  const driverPayload = {
    phone,
    full_name: d.driverName,
    last_name: d.lastName,
    first_name: d.firstName,
    middle_name: d.middleName,
    licenseFull: d.licenseFull,
    licenseSeries: d.licenseSeries,
    licenseNumber: d.licenseNumber,
    // 🔧 В Fleet всегда отдаём ПИНФЛ только с ВУ
    pinfl: d.driverPinfl || d.pinfl,
    issuedDate: d.issuedDate,
    expiryDate: d.expiryDate,
    birthDate: d.birthDate,
    isHunter: session.isHunterReferral,
    isCargo: session.isCargo,
  };


  await sendTelegramMessage(
    chatId,
    "1/2 bosqich: Yandex tizimida haydovchi profilini yaratmoqdaman..."
  );

  const driverRes = await createDriverInFleet(driverPayload);
  if (!driverRes.ok) {
    // Этап 1 не прошёл — сразу говорим водителю и оператору
    await sendTelegramMessage(
      chatId,
      "❗️ Yandex tizimida haydovchi ro‘yxatdan o‘tkazishda xatolik yuz berdi. Operator bilan bog‘laning."
    );
    await sendOperatorAlert(
      "*Ошибка авто-регистрации водителя в Yandex Fleet (этап 1/2)*\n\n" +
        `Телефон: \`${phone || "—"}\`\n` +
        `Xato: ${driverRes.error || "noma'lum"}`
    );
    return;
  }

  session.driverFleetId = driverRes.driverId || null;

  await sendTelegramMessage(
    chatId,
    "✅ 1/2 bosqich tugadi: haydovchi profili Yandex tizimida yaratildi."
  );

  // ========== ЭТАП 2/2: СОЗДАНИЕ/ПРИВЯЗКА АВТОМОБИЛЯ ==========

  let carId = null;

  if (canCreateCar) {
    await sendTelegramMessage(
      chatId,
      "2/2 bosqich: avtomobilni Yandex tizimiga qo‘shmoqdaman..."
    );

    // позывной из телефона
    const pozivnoiSource = String(phone || "").replace(/[^\d]/g, "");
    const pozivnoi = pozivnoiSource.slice(-7) || null;

    const carPayload = {
      brand,                                 // марка из splitCarBrandModel
      model,                                 // модель из splitCarBrandModel
      year: d.carYear,                       // год выпуска
      color: session.carColor,               // цвет из бота (mapColorToYandex внутри createCarInFleet)
      plate_number: d.plateNumber,           // гос номер
      body_number: d.bodyNumber,             // номер кузова
      call_sign: pozivnoi,                   // позывной
      tariffs: session.assignedTariffs,      // тарифы Start/Comfort/...
      is_cargo: session.isCargo,             // грузовой или нет
      cargo_dimensions: session.cargoDimensions || null,
      tech_full: d.techFull,
      tech_number: d.techNumber,
    };

    const carRes = await createCarInFleet(carPayload, session);
    if (!carRes.ok) {
      // Машина не создалась, но водитель уже есть — фиксируем, что без авто
      session.registerWithoutCar = true;

      await sendTelegramMessage(
        chatId,
        "⚠️ Haydovchi ro‘yxatdan o‘tdi, ammo avtomobilni avtomatik qo‘shib bo‘lmadi. Operator avtomobilni qo‘lda qo‘shadi."
      );
      await sendOperatorAlert(
        "*Ошибка добавления автомобиля в Yandex Fleet (этап 2/2)*\n\n" +
          `Телефон: \`${phone || "—"}\`\n` +
          `Xato: ${carRes.error || "noma'lum"}`
      );
    } else {
      carId = carRes.carId || null;
      session.carFleetId = carId;

      await sendTelegramMessage(
        chatId,
        "✅ 2/2 bosqich tugadi: avtomobil Yandex tizimiga qo‘shildi."
      );
    }
  } else {
    // По тарифным правилам / данным авто нельзя создать автоматически
    session.registerWithoutCar = true;
    await sendTelegramMessage(
      chatId,
      "⚠️ Avtomobil ma'lumotlari to‘liq emas yoki tariflarga mos emas.\n" +
        "Haydovchi profili yaratildi, avtomobilni operator qo‘lda qo‘shadi."
    );
  }

  // Привязка авто к водителю, если всё-таки есть carId
  if (session.driverFleetId && carId) {
    const bindRes = await bindCarToDriver(session.driverFleetId, carId);
    if (!bindRes.ok) {
      await sendOperatorAlert(
        "*Ошибка привязки автомобиля к водителю в Yandex Fleet*\n\n" +
          `Телефон: \`${phone || "—"}\`\n` +
          `Xato: ${bindRes.error || "noma'lum"}`
      );
    }
  }

  // ===== ЛОГИ ДЛЯ ОПЕРАТОРОВ (КАК БЫЛО) =====

  await sendDocsToOperators(chatId, session, {
    note: session.registerWithoutCar
      ? "Регистрация ВОДИТЕЛЯ *БЕЗ АВТОМОБИЛЯ* (недостаточно данных по авто или модель не найдена в тарифной базе, либо авто не удалось создать автоматически)."
      : "Новый водитель автоматически зарегистрирован в Yandex Fleet (водитель + авто).",
  });
  // ===== ЗАПИСЬ В GOOGLE SHEETS =====
  const nowIso = new Date().toISOString();
  const fio =
    [d.lastName, d.firstName, d.middleName].filter(Boolean).join(" ") || null;
  const carLabel =
    session.carModelLabel ||
    [session.carBrandLabel, d.carModelLabel].filter(Boolean).join(" ") ||
    null;

  const baseRowNormal = {
    driverId: session.driverFleetId || null,       // ID водителя в Флите
    phone: phone || null,                          // телефон водителя
    fio,
    license: d.licenseFull || null,                // серия + номер В/У
    pinfl: d.driverPinfl || d.pinfl || null,       // ПИНФЛ водителя
    plateNumber: d.plateNumber || null,            // госномер
    carLabel,                                      // марка/модель
    carYear: d.carYear || null,
    carColor: session.carColor || d.carColor || null,
    vin: d.vin || null,
    registeredAt: nowIso,
    bonusStatus: "Не выдан",
    fleetLink: null, // сюда позже можно подставить ссылку на карточку водителя
  };

  if (session.isFriendRegistration && session.inviterDriverId) {
    await recordFriendDriverToSheets({
      inviterDriverId: session.inviterDriverId,
      inviterPhone: session.inviterPhone || null,
      friendDriverId: baseRowNormal.driverId,
      friendPhone: baseRowNormal.phone,
      friendFio: baseRowNormal.fio,
      friendPlate: baseRowNormal.plateNumber,
      friendCarLabel: baseRowNormal.carLabel,
      registeredAt: baseRowNormal.registeredAt,
      bonusStatus: baseRowNormal.bonusStatus,
      operatorComment: "",
    });
  } else {
    await recordNormalDriverToSheets(baseRowNormal);
  }

  const tariffStr = (session.assignedTariffs || []).join(", ") || "—";

  let finishText =
    "🎉 *Рўйхатдан ўтиш муваффақиятли якунланди.*\n\n" +
    `Ulanilgan tariflar: *${tariffStr}*.\n\n` +
    "Endi sizga faqat *@AsrPulBot* orqali samozanyatlikdan o‘tish qoladi.";

  if (session.wantsDelivery) {
    finishText +=
      "\n\n📦 Sizga qo‘shimcha ravishda *Delivery (yetkazib berish)* buyurtmalari ham yoqilgan bo‘lishi mumkin (park siyosatiga qarab).";
  }

  if (session.registerWithoutCar) {
    finishText +=
      "\n\n⚠️ Avtomobilingiz ma'lumotlari to‘liq aniqlanmadi yoki avtomatik qo‘shib bo‘lmadi, siz hozircha *avtomobilsiz* ro‘yxatdan o‘tdingiz.\n" +
      "Operator tez orada siz bilan bog‘lanib, avtomobilni qo‘lda qo‘shadi.";
  }

  await sendTelegramMessage(chatId, finishText, {
    parse_mode: "Markdown",
    reply_markup: {
      keyboard: [
        [{ text: "Меню" }, { text: "50 000 бонус олиш" }],
      ],
      resize_keyboard: true,
    },
  });

  // дальше пользователь может открыть меню или взять бонус
  session.step = "driver_menu";

}

// ===== ОБРАБОТКА ФОТО ДОКУМЕНТОВ =====

async function handleDocumentPhoto(update, session, docType) {
  const msg =
    update.message ||
    update.edited_message ||
    update.channel_post ||
    update.edited_channel_post;

  const chatId = msg.chat.id;

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

  const meta = {
    tg_id: chatId,
    phone: session.phone,
    carModel: session.carModelLabel,
    carModelCode: session.carModelCode,
    carColor: session.carColor,
    docType,
  };

  await sendTelegramMessage(
    chatId,
    "✅ Foto qabul qilindi. Ma'lumotlarni o‘qiyapman, bir necha soniya kuting..."
  );

  const resp = await forwardDocToUploadDoc(update, meta);

  if (!resp || resp.ok === false) {
    await sendTelegramMessage(
      chatId,
      "❗️ Hujjatni o‘qishda xatolik yuz berdi. Iltimos, suratni yana bir bor yuboring."
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
      "Ma'lumotlarni to‘g‘ri o‘qishning imkoni bo‘lmadi. Iltimos, hujjatni yorug‘ joyda, ravshan va xirasiz suratga olib, qayta yuboring."
    );
    return;
  }

  const fields = parsedDoc.result.parsed.fields || {};

  session.docs = session.docs || {};
  session.docs[docType] = {
    fileId,
    doc: {
      docType,
      docTitle: humanDocTitle(docType),
      result: parsedDoc.result,
    },
  };

  updateSessionDataFromFields(session, docType, fields);
  recomputeDerived(session);

  if (docType === "vu_front") {
    const d = session.data || {};
    const countryCode = (FLEET_DEFAULT_LICENSE_COUNTRY || "UZB").toUpperCase();

    const cleanNumber = normalizeDriverLicenseNumber(
      countryCode,
      d.licenseSeries,
      d.licenseNumber,
      d.licenseFull
    );

    if (!cleanNumber) {
      await sendTelegramMessage(
        chatId,
        "Haydovchilik guvohnomasi seriya/raqamini aniqlashning imkoni bo‘lmadi. Iltimos, hujjatni qayta, aniqroq suratga oling."
      );
      return;
    }

    let series = d.licenseSeries || null;
    let num = d.licenseNumber || null;

    const m = cleanNumber.match(/^([A-Z]{2,3})(\d{5,})$/);
    if (m) {
      series = m[1];
      num = m[2];
    }

    d.licenseSeries = series;
    d.licenseNumber = num;
    d.licenseFull = cleanNumber;

    session.data = d;
    recomputeDerived(session);

    const checkRes = await findDriverByLicense(
      [cleanNumber, d.licenseFull, `${series || ""}${num || ""}`].filter(Boolean)
    );

    if (!checkRes.ok) {
      await sendTelegramMessage(
        chatId,
        "Yandex tizimida V/U bo‘yicha tekshirishda xatolik yuz berdi. Operator bilan bog‘laning yoki qaytadan urinib ko‘ring."
      );
      return;
    }

    if (checkRes.found && checkRes.driver) {
      const driverPhone = checkRes.driver.phone || "noma'lum";
      await sendTelegramMessage(
        chatId,
        "❗️ Bu haydovchilik guvohnomasi Yandex tizimida *allaqachon ro‘yxatdan o‘tgan*.\n\n" +
          `Ulanilgan telefon raqami: *${driverPhone}*\n\n` +
          "Iltimos, shu raqam orqali tizimga kiring yoki operator bilan bog‘laning.",
        { parse_mode: "Markdown" }
      );

      await sendDocsToOperators(chatId, session, {
        note:
          "❗️ Повторная попытка регистрации по В/У. Документы отправлены оператору для проверки.",
      });

      session.step = "idle";
      return;
    }

    await sendTelegramMessage(
      chatId,
      "✅ Haydovchilik guvohnomasi bo‘yicha Yandex tizimida ro‘yxatdan o‘tmagan.\nEndi avtomobil ma'lumotlarini kiritamiz."
    );

    // 🔴 Сначала просим госномер, как в ТЗ
    await askPlateNumber(chatId, session);

  } else if (docType === "tech_front") {
    await askDocTechBack(chatId, session);
  } else if (docType === "tech_back") {
    if (session.isCargo) {
      await askCargoSize(chatId, session);
    } else {
      if (session.carBrandCode && !session.isCargo) {
        const d = session.data || {};
        const shortModel =
          (session.carModelLabel || "")
            .replace(`${session.carBrandLabel} `, "")
            .trim();
        const tariffsInfo = getTariffsForCar(
          session.carBrandCode,
          shortModel,
          d.carYear
        );
        session.assignedTariffs = tariffsInfo.tariffs || [];
      }
      await sendTelegramMessage(
        chatId,
        "✅ Barcha kerakli hujjatlar qabul qilindi."
      );

      await askDeliveryOption(chatId, session);
    }
  }
}
/**
 * Получение баланса и заблокированного баланса водителя
 * GET /v1/parks/contractors/blocked-balance
 * contractor_id — это id профиля водителя (driverId из Fleet).
 */
async function getDriverBalanceInfo(driverId) {
  const cfg = ensureFleetConfigured();
  if (!cfg.ok) {
    return { ok: false, error: cfg.message };
  }

  if (!driverId) {
    return { ok: false, error: "driverId не передан" };
  }

const res = await callFleetGet(
  "/v1/parks/contractors/blocked-balance",
  { contractor_id: driverId, park_id: FLEET_PARK_ID }
);


  if (!res.ok) {
    console.error("getDriverBalanceInfo fleet error:", res);
    return {
      ok: false,
      error: res.message || "fleet balance error",
      raw: res.raw,
    };
  }

  const data = res.data || {};

  const parseNumber = (v) => {
    if (v === null || v === undefined) return null;
    const n = parseFloat(String(v).replace(",", "."));
    return Number.isNaN(n) ? null : n;
  };

  const balance = parseNumber(data.balance);
  const blocked = parseNumber(data.blocked_balance);

  const detailsRaw = data.details || {};
  const details = {
    blockedTips: parseNumber(detailsRaw.blocked_tips),
    blockedCashless: parseNumber(detailsRaw.blocked_cashless),
    blockedBonuses: parseNumber(detailsRaw.blocked_bonuses),
    blockedFinancialStatements: parseNumber(
      detailsRaw.blocked_financial_statements
    ),
    blockedClosingDocuments: parseNumber(
      detailsRaw.blocked_closing_documents
    ),
  };

  return {
    ok: true,
    balance,
    blocked,
    details,
    raw: data,
  };
}

// ====== GOOGLE SHEETS: отправка данных через вебхук ======

async function appendRowToGoogleSheet(payload) {
  if (!GSHEETS_WEBHOOK_URL) {
    console.log(
      "GSHEETS_WEBHOOK_URL is not set, skip Google Sheets append",
      payload
    );
    return { ok: false, skipped: true };
  }

  try {
    const res = await fetch(GSHEETS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    if (!res.ok) {
      console.error("appendRowToGoogleSheet error:", res.status, text);
      return { ok: false, status: res.status, raw: text };
    }

    return { ok: true };
  } catch (e) {
    console.error("appendRowToGoogleSheet exception:", e);
    return { ok: false, error: String(e) };
  }
}

/**
 * Запись обычного водителя (лист «Обычные водители»)
 */
async function recordNormalDriverToSheets(row) {
  return appendRowToGoogleSheet({
    sheet: "Обычные водители",
    type: "normal_driver",
    row,
  });
}

/**
 * Запись друга (лист «Друзья»)
 */
async function recordFriendDriverToSheets(row) {
  return appendRowToGoogleSheet({
    sheet: "Друзья",
    type: "friend_driver",
    row,
  });
}

/**
 * Обновление статуса бонуса в Google Sheets
 */
async function markBonusGivenInSheets(driverId, isFriend) {
  if (!GSHEETS_WEBHOOK_URL || !driverId) return { ok: false, skipped: true };

  try {
    const res = await fetch(GSHEETS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "markBonusGiven",
        sheet: isFriend ? "Друзья" : "Обычные водители",
        driverId,
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error("markBonusGivenInSheets error:", res.status, txt);
      return { ok: false, status: res.status, raw: txt };
    }
    return { ok: true };
  } catch (e) {
    console.error("markBonusGivenInSheets exception:", e);
    return { ok: false, error: String(e) };
  }
}
/**
 * Начисление одноразового бонуса водителю (реальный вызов Yandex Fleet).
 */
async function creditBonusToDriver(driverId, amount) {
  if (!driverId) {
    return { ok: false, error: "driverId is missing for bonus" };
  }

  const description = `Bonus for registration via ASR TAXI bot (+${amount} UZS)`;

  const tx = await createDriverTransaction(driverId, amount, description);
  if (!tx.ok) {
    console.error("[bonus] creditBonusToDriver failed:", tx);
    return {
      ok: false,
      error: tx.error || "transaction error",
      raw: tx.raw,
    };
  }

  console.log(
    "[bonus] transaction created for driverId=",
    driverId,
    "amount=",
    amount,
    "txId=",
    tx.data && (tx.data.transaction_id || tx.data.id)
  );

  return { ok: true };
}

async function handleBonusRequest(chatId, session) {
  if (!session.driverFleetId) {
    await sendTelegramMessage(
      chatId,
      "Avval Yandex tizimida ro‘yxatdan o‘tishingiz kerak. Ro‘yxatdan o‘tish jarayonini yakunlang, shundan so‘ng bonusni olishingiz mumkin bo‘ladi."
    );
    return;
  }

  if (session.bonusGiven) {
    await sendTelegramMessage(chatId, "Бонус аллақачон берилган.");
    return;
  }

  const driverId = session.driverFleetId;
  const res = await creditBonusToDriver(driverId, BONUS_AMOUNT);

  if (!res.ok) {
    await sendTelegramMessage(
      chatId,
      "❗️ Бонусни ҳисобга ўтказишда хатолик юз берди. Иложи борича тез орада қайта уриниб кўринг ёки операторга мурожаат қилинг."
    );
    return;
  }

  session.bonusGiven = true;

  // помечаем бонус как выданный в Google Sheets (если настроено)
  await markBonusGivenInSheets(driverId, !!session.isFriendRegistration);

  await sendTelegramMessage(
    chatId,
    "💰 50 000 сум бонус шахсий ҳисобингизга ўтказилди.\n\nРаҳмат, ASR TAXI билан ишлаётганингиз учун!",
    {
      reply_markup: {
        keyboard: [[{ text: "Меню" }]],
        resize_keyboard: true,
      },
    }
  );
}

/**
 * Человечное описание статуса водителя (узбекский + оригинальный код)
 */
function humanizeDriverStatusUz(status) {
  const s = String(status || "").toLowerCase();

  if (s === "working") return "ishlayapti (working)";
  if (s === "not_on_line" || s === "offline") return "oflayn (onlayn emas)";
  if (s === "fired" || s === "blocked") return "bloklangan (fired)";
  if (s === "on_pause") return "pauza (on_pause)";

  if (!status) return "noma'lum holat";

  return status;
}


// ===== ОБРАБОТКА НОМЕРА ТЕЛЕФОНА =====

async function handlePhoneCaptured(chatId, session, phoneRaw) {
  const phone = String(phoneRaw || "").trim();
  session.phone = phone;
  session.data = session.data || {};
  session.data.phone = phone;

  await sendTelegramMessage(chatId, `📞 Telefon qabul qilindi: *${phone}*`, {
    parse_mode: "Markdown",
  });

  await sendTelegramMessage(
    chatId,
    "🔍 Yandex tizimida mazkur telefon raqami bo‘yicha haydovchi mavjudligini tekshiryapman..."
  );

  const found = await findDriverByPhone(phone);

  if (!found.ok) {
    await sendTelegramMessage(
      chatId,
      "❗️ Yandex tizimi bilan bog‘lanishda xatolik yuz berdi.\n" +
        "Hozircha ro‘yxatdan o‘tishni yangi haydovchi sifatida davom ettiramiz."
    );
    session.isExistingDriver = false;
    await askDocVuFront(chatId, session);
    return;
  }

  if (found.found && found.driver) {
    // сохраним данные водителя
    session.isExistingDriver = true;
    session.driverFleetId = found.driver.id || null;
    session.driverName = found.driver.name || null;

    await sendTelegramMessage(
      chatId,
      "Бу рақам билан Яндекс тизимида аллақачон рўйхатдан ўтилган.\n" +
        "Агар пароль ёки киришда муаммо бўлса, операторга мурожаат қилинг.",
      {
        reply_markup: {
          keyboard: [
            [{ text: "Меню" }, { text: "❓ Савол бериш (оператор)" }],
          ],
          resize_keyboard: true,
        },
      }
    );
  } else {
    await sendTelegramMessage(
      chatId,
      "ℹ️ Bu telefon raqami bo‘yicha Yandex tizimida haydovchi topilmadi.\n" +
        "Endi yangi haydovchi sifatida ro‘yxatdan o‘tamiz."
    );
    session.isExistingDriver = false;
    await askDocVuFront(chatId, session);
  }
}

// ===== MAIN HANDLER =====

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 200,
      body: "OK",
    };
  }

  let update;
  try {
    update = JSON.parse(event.body || "{}");
  } catch (e) {
    console.error("telegram-asr-bot: invalid JSON", e);
    return { statusCode: 200, body: "OK" };
  }

  // ===== CALLBACK_QUERY =====
  if (update.callback_query) {
    const cq = update.callback_query;
    const data = cq.data || "";
    const chatId = cq.message?.chat?.id;

    if (!chatId) {
      await answerCallbackQuery(cq.id);
      return { statusCode: 200, body: "OK" };
    }

    const session = getSession(chatId);

    // выбор бренда
    if (data.startsWith("car_brand:")) {
      const brandCode = data.split(":")[1];
      const brand = CAR_BRANDS.find((b) => b.code === brandCode);
      if (!brand) {
        await sendTelegramMessage(
          chatId,
          "Bu marka topilmadi. Iltimos, qayta urinib ko‘ring."
        );
        await answerCallbackQuery(cq.id);
        return { statusCode: 200, body: "OK" };
      }

      session.carBrandCode = brand.code;
      session.carBrandLabel = brand.label;
      session.isCargo = brand.code === "CARGO";

      await sendTelegramMessage(
        chatId,
        `🚗 Siz tanlagan marka: *${brand.label}*`,
        { parse_mode: "Markdown" }
      );

      await askCarModelForBrand(chatId, session);
      await answerCallbackQuery(cq.id);
      return { statusCode: 200, body: "OK" };
    }

    // выбор модели
    if (data.startsWith("car_model:")) {
      const parts = data.split(":");
      const brandCode = parts[1];
      const modelCode = parts[2];

      const brand = CAR_BRANDS.find((b) => b.code === brandCode);
      const models = CAR_MODELS_INDEX[brandCode] || [];
      const model = models.find((m) => m.code === modelCode);

      if (!brand || !model) {
        await sendTelegramMessage(
          chatId,
          "Modelni aniqlashning imkoni bo‘lmadi. Iltimos, qayta tanlab ko‘ring."
        );
        await answerCallbackQuery(cq.id);
        return { statusCode: 200, body: "OK" };
      }

      session.carBrandCode = brand.code;
      session.carBrandLabel = brand.label;
      session.carModelCode = model.code;
      session.carModelLabel = model.fullLabel;
      session.data = session.data || {};
      session.data.carModelLabel = session.carModelLabel;

      await sendTelegramMessage(
        chatId,
        `🚗 Tanlangan model: *${session.carModelLabel}*`,
        { parse_mode: "Markdown" }
      );

      await askCarColor(chatId, session);

      await answerCallbackQuery(cq.id);
      return { statusCode: 200, body: "OK" };
    }

    // выбор цвета
    if (data.startsWith("car_color:")) {
      const code = data.split(":")[1];
      const color = CAR_COLORS.find((c) => c.code === code);
      if (color) {
        session.carColor = color.label;
        session.carColorCode = color.code;
        session.data = session.data || {};
        session.data.carColor = session.carColor;
        await sendTelegramMessage(
          chatId,
          `🎨 Rang tanlandi: *${session.carColor}*`,
          { parse_mode: "Markdown" }
        );
        await askDocTechFront(chatId, session);
      } else {
        await sendTelegramMessage(
          chatId,
          "Bu rang topilmadi. Iltimos, qaytadan tanlab ko‘ring."
        );
      }
      await answerCallbackQuery(cq.id);
      return { statusCode: 200, body: "OK" };
    }

    // выбор грузового размера
    if (data.startsWith("cargo_size:")) {
      const code = data.split(":")[1];
      const size = CARGO_SIZES[code];
      if (!size) {
        await sendTelegramMessage(
          chatId,
          "Kuzov o‘lchamini aniqlashning imkoni bo‘lmadi. Iltimos, qaytadan tanlang."
        );
      } else {
        session.cargoSizeCode = size.code;
        session.cargoDimensions = {
          length: size.length,
          width: size.width,
          height: size.height,
        };

        await sendTelegramMessage(
          chatId,
          `🚚 Tanlangan kuzov: *${size.label}*`,
          { parse_mode: "Markdown" }
        );

        session.assignedTariffs = ["Cargo"];

        await sendTelegramMessage(
          chatId,
          "✅ Barcha kerakli hujjatlar qabul qilindi."
        );
        await askDeliveryOption(chatId, session);
      }
      await answerCallbackQuery(cq.id);
      return { statusCode: 200, body: "OK" };
    }

    // выбор Delivery
    if (data === "delivery_yes") {
      session.wantsDelivery = true;
      await sendTelegramMessage(
        chatId,
        "📦 Delivery ulashga rozilik berdingiz. Yetkazib berish buyurtmalari park siyosatiga qarab sizga ochiladi.",
        { parse_mode: "Markdown" }
      );
      await startFirstConfirmation(chatId, session);
      await answerCallbackQuery(cq.id);
      return { statusCode: 200, body: "OK" };
    }
    if (data === "delivery_no") {
      session.wantsDelivery = false;
      await sendTelegramMessage(
        chatId,
        "🚕 Siz faqat taksi buyurtmalarini qabul qilasiz.",
        { parse_mode: "Markdown" }
      );
      await startFirstConfirmation(chatId, session);
      await answerCallbackQuery(cq.id);
      return { statusCode: 200, body: "OK" };
    }

    // первая сводка
    if (data === "confirm1_yes") {
      session.confirmStage = "first";
      await startSecondConfirmation(chatId, session);
      await answerCallbackQuery(cq.id);
      return { statusCode: 200, body: "OK" };
    }
    if (data === "confirm1_edit") {
      session.confirmStage = "first";
      session.editIndex = 0;
      await askNextEditField(chatId, session);
      await answerCallbackQuery(cq.id);
      return { statusCode: 200, body: "OK" };
    }

    // вторая сводка
    if (data === "confirm2_yes") {
      session.confirmStage = "second";
      session.step = "finished";

      await autoRegisterInYandexFleet(chatId, session);
      await answerCallbackQuery(cq.id);
      return { statusCode: 200, body: "OK" };
    }
    if (data === "confirm2_edit") {
      session.confirmStage = "second";
      session.editIndex = 0;
      await askNextEditField(chatId, session);
      await answerCallbackQuery(cq.id);
      return { statusCode: 200, body: "OK" };
    }

    // редактирование полей
    if (data === "edit_field_confirm") {
      session.editAwaitingValue = false;
      session.editIndex = (session.editIndex || 0) + 1;
      await askNextEditField(chatId, session);
      await answerCallbackQuery(cq.id);
      return { statusCode: 200, body: "OK" };
    }

    if (data === "edit_field_change") {
      session.editAwaitingValue = true;
      const field = EDIT_FIELDS[session.editIndex] || null;
      const label = field ? field.label : "maydon";
      await sendTelegramMessage(
        chatId,
        `Iltimos, *${label}* maydoni uchun yangi qiymatni bitta xabar bilan yuboring.`,
        { parse_mode: "Markdown" }
      );
      await answerCallbackQuery(cq.id);
      return { statusCode: 200, body: "OK" };
    }

    // меню водителя
    if (data.startsWith("menu:")) {
      const action = data.split(":")[1];
      await handleMenuAction(chatId, session, action);
      await answerCallbackQuery(cq.id);
      return { statusCode: 200, body: "OK" };
    }

    if (data === "check_status") {
      await handleMenuAction(chatId, session, "status");
      await answerCallbackQuery(cq.id);
      return { statusCode: 200, body: "OK" };
    }

    await answerCallbackQuery(cq.id);
    return { statusCode: 200, body: "OK" };
  }

  // ===== MESSAGE =====
  const msg =
    update.message ||
    update.edited_message ||
    update.channel_post ||
    update.edited_channel_post;

  if (!msg) {
    return { statusCode: 200, body: "OK" };
  }

 const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  let session = getSession(chatId);


    // ⛔ Глобальная остановка регистрации
  if (text === STOP_REGISTRATION_TEXT) {
    resetSession(chatId);
    await sendTelegramMessage(
      chatId,
      "Ro‘yxatdan o‘tish jarayoni to‘xtatildi.\n\n" +
        "Qaytadan boshlamoqchi bo‘lsangiz, /start yuboring."
    );
    return {
      statusCode: 200,
      body: "OK",
    };
  }
  // Ввод госномера авто текстом (ТЗ: сначала берём госномер)
  if (session.step === "waiting_plate" && text) {
    const raw = text.replace(/\s+/g, "").toUpperCase();

    // Простая валидация формата, при желании можно ослабить
    if (raw.length < 7 || raw.length > 10) {
      await sendTelegramMessage(
        chatId,
        "Davlat raqamini to‘g‘ri formatda yuboring, masalan: 01A123BC."
      );
      return { statusCode: 200, body: "OK" };
    }

    session.data = session.data || {};
    session.data.plateNumber = raw;

    await sendTelegramMessage(
      chatId,
      `🚘 Davlat raqami qabul qilindi: *${raw}*`,
      { parse_mode: "Markdown" }
    );

    await askCarBrand(chatId, session);
    return { statusCode: 200, body: "OK" };
  }



  // /start с payload
  if (text && text.startsWith("/start")) {
    resetSession(chatId);
    session = getSession(chatId);

    const parts = text.split(" ");
    if (parts[1]) {
      applyStartPayloadToSession(session, parts[1]);
    }

    await handleStart(chatId, session);
    return { statusCode: 200, body: "OK" };
  }

  // Кнопка "Проверить статус регистрации"
// Кнопка диагностики "vse li v poryadke"
if (
  text === "🩺 Hisob diagnostikasi" ||
  text === "🩺 Диагностика" ||
  // поддерживаем старые подписи, если они ещё остались в клавиатуре
  text === "🔄 Ro‘yxatdan o‘tish holatini tekshirish" ||
  text === "🔄 Проверить статус регистрации" ||
  text.toLowerCase().includes("status") ||
  text.toLowerCase().includes("diag")
) {
  await handleMenuAction(chatId, session, "status");
  return { statusCode: 200, body: "OK" };
}
  // Кнопка "Меню" после проверки номера / регистрации
  if (text === "Меню") {
    await openDriverCabinet(chatId, session, {
      id: session.driverFleetId || null,
      name: session.driverName || null,
    });
    return { statusCode: 200, body: "OK" };
  }

  // Кнопка "Савол бериш (оператор)" по ТЗ
  if (text === "❓ Савол бериш (оператор)") {
    await handleMenuAction(chatId, session, "operator");
    return { statusCode: 200, body: "OK" };
  }

  if (text === "50 000 бонус олиш") {
    await handleBonusRequest(chatId, session);
    return { statusCode: 200, body: "OK" };
  }

  // Кнопки меню личного кабинета водителя
  if (session.step === "driver_menu") {
    switch (text) {
     
         case "📊 Hisob va balans":
      await sendTelegramMessage(
        chatId,
        "📊 *Hisob va balans* bo‘limi:\n\n" +
          "Bu yerda balans bo‘yicha barcha funksiyalar joylashgan:\n" +
          "• 🩺 Hisob diagnostikasi\n" +
          "• 💳 Balansni to‘ldirish\n" +
          "• 💸 Mablag‘ni yechib olish\n\n" +
          "Kerakli funksiyani pastdagi tugmalardan tanlang.",
        { parse_mode: "Markdown" }
      );
      return { statusCode: 200, body: "OK" };

    case "🚕 Buyurtmalar va ish":
      await sendTelegramMessage(
        chatId,
        "🚕 *Buyurtmalar va ish* bo‘limi:\n\n" +
          "Bu yerda ish jarayoni bo‘yicha yordam bor:\n" +
          "• 📸 Fotokontrol bo‘yicha yordam\n" +
          "• 📍 GPS xatoliklari\n" +
          "• 🎯 Maqsadlar va bonuslar\n\n" +
          "Kerakli tugmani pastdan tanlang.",
        { parse_mode: "Markdown" }
      );
      return { statusCode: 200, body: "OK" };

    case "📄 Hujjatlar":
      await sendTelegramMessage(
        chatId,
        "📄 *Hujjatlar* bo‘limi:\n\n" +
          "Bu yerda Litsenziya va OSAGO bo‘yicha ma'lumot olasiz.\n\n" +
          "👉 \"📄 Litsenziya va OSAGO\" tugmasini bosing.",
        { parse_mode: "Markdown" }
      );
      return { statusCode: 200, body: "OK" };

    case "🤝 Aloqa va bonuslar":
      await sendTelegramMessage(
        chatId,
        "🤝 *Aloqa va bonuslar* bo‘limi:\n\n" +
          "Bu yerda quyidagilar mavjud:\n" +
          "• 🤝 Do‘stni taklif qilish\n" +
          "• 🎥 Video qo‘llanma\n" +
          "• 👨‍💼 Operator bilan aloqa\n\n" +
          "Kerakli bo‘limni pastdagi tugmalardan tanlang.",
        { parse_mode: "Markdown" }
      );
      return { statusCode: 200, body: "OK" };

      case "📸 Fotokontrol bo‘yicha yordam":
        await handleMenuAction(chatId, session, "photocontrol");
        return { statusCode: 200, body: "OK" };

      case "📍 GPS xatoliklari":
        await handleMenuAction(chatId, session, "gps");
        return { statusCode: 200, body: "OK" };

      case "🎯 Maqsadlar va bonuslar":
        await handleMenuAction(chatId, session, "goals");
        return { statusCode: 200, body: "OK" };

      case "💳 Balansni to‘ldirish":
        await handleMenuAction(chatId, session, "topup");
        return { statusCode: 200, body: "OK" };

      case "💸 Mablag‘ni yechib olish":
        await handleMenuAction(chatId, session, "withdraw");
        return { statusCode: 200, body: "OK" };

      case "📄 Litsenziya va OSAGO":
        await handleMenuAction(chatId, session, "license");
        return { statusCode: 200, body: "OK" };

      case "🤝 Do‘stni taklif qilish":
        await handleMenuAction(chatId, session, "invite");
        return { statusCode: 200, body: "OK" };

      case "🎥 Video qo‘llanma":
        await handleMenuAction(chatId, session, "video");
        return { statusCode: 200, body: "OK" };

      case "👨‍💼 Operator bilan aloqa":
        await handleMenuAction(chatId, session, "operator");
        return { statusCode: 200, body: "OK" };

      // Кнопка "Шaxsiy kabinetni ochish" после успешной регистрации
      case "🚕 Shaxsiy kabinetni ochish":
        await openDriverCabinet(chatId, session, {
          id: session.driverFleetId || null,
          name: session.driverName || null,
        });
        return { statusCode: 200, body: "OK" };

      default:
        break;
    }
  }

  // 1) Сначала — если ждём телефон и пришёл текст
// 1) Если бот ждёт телефон, а пользователь прислал текст — просим отправить контакт
if (
  (session.step === "waiting_phone" ||
    session.step === "waiting_phone_for_status") &&
  text
) {
  await sendTelegramMessage(
    chatId,
    "Iltimos, telefon raqamingizni matn bilan emas, *«📲 Telefon raqamni yuborish»* tugmasi orqali yuboring.",
    { parse_mode: "Markdown" }
  );
  return { statusCode: 200, body: "OK" };
}


// 2) Отдельно — контакт (номер телефона)
if (msg.contact) {
  const contactPhone = msg.contact.phone_number;

  // 1) Просили телефон только для проверки статуса
  if (session.step === "waiting_phone_for_status") {
    session.phone = contactPhone;
    session.data = session.data || {};
    session.data.phone = contactPhone;

    await sendTelegramMessage(
      chatId,
      `📞 Telefon qabul qilindi: *${contactPhone}*`,
      { parse_mode: "Markdown" }
    );

    await handleMenuAction(chatId, session, "status");
    session.step = "driver_menu";

    return { statusCode: 200, body: "OK" };
  }

  // 2) Нормальный сценарий регистрации
  if (session.step === "waiting_phone") {
    await handlePhoneCaptured(chatId, session, contactPhone);
    return { statusCode: 200, body: "OK" };
  }

  // 3) Номер пришёл «не по сценарию» → кейс 8.1 ТЗ
  await sendOperatorAlert(
    "*Haydovchi telefon raqamini kutilmagan vaqtda yubordi*\n\n" +
      `Chat ID: \`${chatId}\`\n` +
      `Telefon: \`${contactPhone}\``
  );
  await sendTelegramMessage(
    chatId,
    "📞 Telefon raqamingiz operatorga yuborildi.\n" +
      "Tezkor aloqa uchun operatorga yozing: @AsrTaxiAdmin"
  );
  return { statusCode: 200, body: "OK" };
}


// Режим редактирования отдельного поля
if (
  session.step === "editing_field" &&
  session.editAwaitingValue &&
  text
) {
  const value = text.trim();
  const key = session.currentFieldKey;

  if (key) {
    // сохраняем новое значение
    setFieldValue(session, key, value);
    recomputeDerived(session);
    applySessionDataToDocs(session);
  }

  session.editAwaitingValue = false;
  session.editIndex = (session.editIndex || 0) + 1;

  await sendTelegramMessage(
    chatId,
    "✅ Qiymat saqlandi. Keyingi maydonni tekshiramiz."
  );

  await askNextEditField(chatId, session);
  return { statusCode: 200, body: "OK" };
}


  // фото документов
  if (
    (session.step === "waiting_vu_front" ||
      session.step === "waiting_tech_front" ||
      session.step === "waiting_tech_back") &&
    (Array.isArray(msg.photo) ||
      (msg.document &&
        msg.document.mime_type &&
        msg.document.mime_type.startsWith("image/")))
  ) {
    if (session.step === "waiting_vu_front") {
      await handleDocumentPhoto(update, session, "vu_front");
    } else if (session.step === "waiting_tech_front") {
      await handleDocumentPhoto(update, session, "tech_front");
    } else if (session.step === "waiting_tech_back") {
      await handleDocumentPhoto(update, session, "tech_back");
    }
    return { statusCode: 200, body: "OK" };
  }

  // если сессия idle — повторно показываем старт
  if (session.step === "idle") {
    await handleStart(chatId, session);
    return { statusCode: 200, body: "OK" };
  }

  // подсказки по шагам, если пользователь пишет "не туда"
  if (session.step === "waiting_vu_front") {
    await sendTelegramMessage(
      chatId,
      "Hozir *haydovchilik guvohnomangizning old tomoni* suratini yuborishingiz kerak.",
      { parse_mode: "Markdown" }
    );
  } else if (session.step === "waiting_tech_front") {
    await sendTelegramMessage(
      chatId,
      "Hozir *texpasportning old tomoni* suratini yuborishingiz kerak.",
      { parse_mode: "Markdown" }
    );
  } else if (session.step === "waiting_tech_back") {
    await sendTelegramMessage(
      chatId,
      "Hozir *texpasportning orqa tomoni* suratini yuborishingiz kerak.",
      { parse_mode: "Markdown" }
    );
  } else if (session.step === "waiting_delivery_choice") {
    await sendTelegramMessage(
      chatId,
      "Delivery bo‘yicha savolga javob berish uchun tugmalardan foydalaning.",
      { parse_mode: "Markdown" }
    );
  }

  return { statusCode: 200, body: "OK" };
};
