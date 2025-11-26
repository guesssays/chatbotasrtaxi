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
      cargoSizeCode: null, // S/M/L/XL/XXL label
      cargoDimensions: null, // {length,width,height}

      assignedTariffs: [], // ['Start','Comfort',...]
      registerWithoutCar: false,

      // AI-распознанные документы
      docs: {
        vu_front: null,
        tech_front: null,
        tech_back: null,
      },

      // агрегированные данные для редактирования
      data: {},

      // подтверждения / редактирование
      confirmStage: "none", // none | first | second
      editIndex: 0,
      editAwaitingValue: false,
      currentFieldKey: null,

      // hunter / delivery (из ТЗ)
      isHunterReferral: false,
      hunterCode: null,
      wantsDelivery: false,
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

// парсинг /start payload для hunter и других меток
function applyStartPayloadToSession(session, payloadRaw) {
  if (!payloadRaw) return;
  const payload = String(payloadRaw).trim();

  // пример: /start hunter_12345
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

  // другие варианты реферальных меток можно обработать здесь
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
  { code: "CARGO", label: "Грузовые" },
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

  RAVON: {
    "Nexia R3": {
      start: true,
      comfort: { minYear: 2019 },
    },
    R4: {
      start: true,
      comfort: { minYear: 2019 },
    },
    Gentra: {
      start: true,
      comfort: { minYear: 2015 },
    },
  },

  DAEWOO: {
    Matiz: {
      start: true,
    },
    Tico: {
      // только Delivery по ТЗ, но здесь это только Start
      start: true,
    },
    Damas: {
      // Delivery / Cargo по ТЗ
      start: true,
    },
    Labo: {
      // Delivery / Cargo по ТЗ
      start: true,
    },
    "Gentra (доузб.)": {
      start: true,
    },
    Kalos: {
      start: true,
    },
    "Lacetti (старый)": {
      start: true,
    },
    Lanos: {
      start: true,
    },
    Leganza: {
      start: true,
      comfort: { minYear: 2004 },
    },
    Magnus: {
      start: true,
      comfort: { minYear: 2006 },
    },
    Nubira: {
      start: true,
    },
    Tacuma: {
      start: true,
      comfort: { minYear: 2012 },
    },
    Winstorm: {
      start: true,
      comfort: { minYear: 2006 },
    },
    Sens: {
      start: true,
    },
  },

  BYD: {
    E2: {
      start: true,
      comfort: { minYear: 2019 },
      comfortPlus: { minYear: 0 },
      electro: true,
    },
    Chazor: {
      start: true,
      comfort: { minYear: 2022 },
      comfortPlus: { minYear: 0 },
      electro: true,
    },
    "Qin Plus": {
      start: true,
      comfort: { minYear: 2018 },
      comfortPlus: { minYear: 0 },
    },
    "Qin Pro": {
      start: true,
    },
    Han: {
      start: true,
      comfort: { minYear: 2020 },
      comfortPlus: { minYear: 0 },
      business: { minYear: 2020 },
      electro: true,
    },
    Seagull: {
      start: true,
      electro: true,
    },
    "Song Plus": {
      start: true,
      comfort: { minYear: 2020 },
      comfortPlus: { minYear: 0 },
      // EV-версия — электро; в рамках одной модели считаем как Electro
      electro: true,
    },
    Tang: {
      start: true,
      comfort: { minYear: 2015 },
      comfortPlus: { minYear: 0 },
    },
    Yuan: {
      start: true,
      comfort: { minYear: 2019 },
      comfortPlus: { minYear: 0 },
      electro: true,
    },
  },

  CHERY: {
    "Arrizo 6 Pro": {
      start: true,
      comfort: { minYear: 2023 },
    },
    "Arrizo 7": {
      start: true,
      comfort: { minYear: 2013 },
    },
    "Tiggo 2": {
      start: true,
    },
    "Tiggo 3": {
      start: true,
    },
    "Tiggo 4": {
      start: true,
      comfort: { minYear: 2019 },
    },
    "Tiggo 4 Pro": {
      start: true,
      comfort: { minYear: 2020 },
    },
    "Tiggo 7": {
      start: true,
      comfort: { minYear: 2016 },
    },
    "Tiggo 7 Pro": {
      start: true,
      comfortPlus: { minYear: 2020 },
    },
    "Tiggo 7 Pro Max": {
      start: true,
      comfortPlus: { minYear: 2022 },
    },
    "Tiggo 8": {
      start: true,
      comfort: { minYear: 2018 },
    },
    "Tiggo 8 Pro": {
      start: true,
      comfort: { minYear: 2021 },
      comfortPlus: { minYear: 2021 },
      business: { minYear: 2021 },
    },
    "Tiggo 8 Pro Max": {
      start: true,
      comfortPlus: { minYear: 2022 },
    },
    EQ5: {
      start: true,
      comfort: { minYear: 2020 },
      comfortPlus: { minYear: 2020 },
      electro: true,
    },
    eQ7: {
      start: true,
      comfortPlus: { minYear: 2023 },
      business: { minYear: 2023 }, // "частично" в ТЗ
      electro: true,
    },
  },

  CHANGAN: {
    Alsvin: {
      start: true,
      comfort: { minYear: 2019 },
    },
    CS35: {
      start: true,
      comfort: { minYear: 2019 },
    },
    "CS35 Plus": {
      start: true,
    },
    CS55: {
      start: true,
      comfort: { minYear: 2017 },
      comfortPlus: { minYear: 2018 },
    },
    CS75: {
      start: true,
      comfort: { minYear: 2014 },
      business: { minYear: 2021 },
    },
    Eado: {
      start: true,
      comfort: { minYear: 2013 },
      comfortPlus: { minYear: 2018 },
    },
    "UNI-T": {
      start: true,
      comfortPlus: { minYear: 2020 },
    },
    "New Van": {
      start: true,
    },
    "A600 EV": {
      start: true,
      electro: true,
    },
  },

  JAC: {
    J5: {
      start: true,
      comfort: { minYear: 2014 },
    },
    J7: {
      start: true,
      comfortPlus: { minYear: 2020 },
    },
    JS4: {
      start: true,
    },
    S3: {
      start: true,
      comfort: { minYear: 2014 },
    },
    S5: {
      start: true,
      comfort: { minYear: 2013 },
    },
    iEV7S: {
      start: true,
      electro: true,
    },
  },

  GEELY: {
    Atlas: {
      start: true,
      comfort: { minYear: 2016 },
    },
    "Atlas Pro": {
      start: true,
      comfort: { minYear: 2021 },
    },
    Coolray: {
      start: true,
      comfort: { minYear: 2019 },
    },
    "Emgrand 7": {
      start: true,
      comfort: { minYear: 2016 },
    },
    "Emgrand EC7": {
      start: true,
      comfort: { minYear: 2009 },
    },
    "Emgrand GT": {
      start: true,
      comfort: { minYear: 2015 },
      business: { minYear: 2015 }, // частично
    },
    "Geometry C": {
      start: true,
      comfort: { minYear: 2020 },
      comfortPlus: { minYear: 0 },
      electro: true,
    },
    Tugella: {
      start: true,
      comfort: { minYear: 2019 },
      comfortPlus: { minYear: 0 },
      business: { minYear: 2019 },
    },
    TX4: {
      start: true,
    },
  },

  HYUNDAI: {
    Accent: {
      start: true,
      comfort: { minYear: 2019 },
    },
    "Accent Blue": {
      start: true,
    },
    Avante: {
      start: true,
      comfort: { minYear: 2012 },
    },
    Elantra: {
      start: true,
      comfort: { minYear: 2012 },
      comfortPlus: { minYear: 2018 },
    },
    Sonata: {
      start: true,
      comfort: { minYear: 2006 },
      comfortPlus: { minYear: 2012 },
      business: { minYear: 2021 },
    },
    "Sonata Turbo": {
      start: true,
      comfort: { minYear: 2006 },
      comfortPlus: { minYear: 2012 },
      business: { minYear: 2021 },
    },
    i30: {
      start: true,
      comfort: { minYear: 2012 },
      comfortPlus: { minYear: 2018 },
    },
    i40: {
      start: true,
      comfort: { minYear: 2011 },
      comfortPlus: { minYear: 2012 },
    },
    Tucson: {
      start: true,
      comfort: { minYear: 2012 },
      comfortPlus: { minYear: 2018 },
    },
    "Santa Fe": {
      start: true,
      comfort: { minYear: 2006 },
      comfortPlus: { minYear: 2012 },
      business: { minYear: 2021 },
    },
    Creta: {
      start: true,
      comfort: { minYear: 2019 },
    },
    Venue: {
      start: true,
    },
    Getz: {
      start: true,
    },
    Grandeur: {
      start: true,
      comfort: { minYear: 2010 },
      comfortPlus: { minYear: 2010 },
      business: { minYear: 2019 },
    },
    Equus: {
      start: true,
      comfortPlus: { minYear: 2010 },
      business: { minYear: 2015 },
    },
    Ioniq: {
      start: true,
      comfortPlus: { minYear: 0 },
      electro: true,
    },
    "Ioniq 5": {
      start: true,
      comfortPlus: { minYear: 0 },
      electro: true,
    },
    Staria: {
      start: true,
    },
  },

  KIA: {
    Rio: {
      start: true,
      comfort: { minYear: 2019 },
    },
    Optima: {
      start: true,
      comfort: { minYear: 2006 },
      comfortPlus: { minYear: 2012 },
    },
    K5: {
      start: true,
      comfort: { minYear: 2010 },
      comfortPlus: { minYear: 2012 },
      business: { minYear: 2021 },
    },
    K3: {
      start: true,
      comfort: { minYear: 2012 },
    },
    Cerato: {
      start: true,
      comfort: { minYear: 2012 },
      comfortPlus: { minYear: 2018 },
    },
    Forte: {
      start: true,
      comfort: { minYear: 2012 },
      comfortPlus: { minYear: 2018 },
    },
    Cadenza: {
      start: true,
    },
    K7: {
      start: true,
    },
    K8: {
      start: true,
      comfortPlus: { minYear: 2021 },
    },
    Sorento: {
      start: true,
      comfort: { minYear: 2006 },
      comfortPlus: { minYear: 2012 },
      business: { minYear: 2021 },
    },
    Sportage: {
      start: true,
      comfort: { minYear: 2012 },
      comfortPlus: { minYear: 2018 },
    },
    Soul: {
      start: true,
      comfort: { minYear: 2019 },
    },
    "Soul EV": {
      start: true,
      electro: true,
    },
    Seltos: {
      start: true,
      comfort: { minYear: 2019 },
    },
    Stinger: {
      start: true,
      comfortPlus: { minYear: 2017 },
      business: { minYear: 2021 },
    },
    Carnival: {
      start: true,
      comfort: { minYear: 2012 },
      business: { minYear: 2021 },
    },
    Carens: {
      start: true,
    },
    Bongo: {
      start: true,
    },
  },

  LEAPMOTOR: {
    C01: {
      start: true,
      comfort: { minYear: 2022 },
      comfortPlus: { minYear: 2022 },
      business: { minYear: 2022 },
      electro: true,
    },
    C10: {
      start: true,
      electro: true,
    },
    C11: {
      start: true,
      comfort: { minYear: 2021 },
      comfortPlus: { minYear: 2021 },
      business: { minYear: 2021 },
      electro: true,
    },
    T03: {
      start: true,
      electro: true,
    },
  },
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
    // БЕЗ parse_mode — чтобы не падать на подчёркиваниях в error-кодах
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
  const { phone, tg_id, carModel, carColor, tariffs, isCargo, cargoSize } =
    commonMeta;
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

  const pinfl = fTf.pinfl || "—";

  const plateNumber = fTf.plate_number || "—";
  const carModelSource = fTf.car_model_text || carModel || "";
  const { brand, model } = splitCarBrandModel(carModelSource);
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
  lines.push(`ПИНФЛ: ${pinfl}`);
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
  lines.push(`8. PINFL (agar ko‘rsatilgan bo‘lsa): ${fTf.pinfl || "—"}`);

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
    if (!media.length) {
      item.caption = "Набор документов от водителя ASR TAXI";
    }
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
  } else if (docType === "tech_front") {
    if (f.plate_number && !d.plateNumber) d.plateNumber = f.plate_number;
    if (f.owner_name && !d.ownerName) d.ownerName = f.owner_name;
    if (f.owner_address && !d.ownerAddress) d.ownerAddress = f.owner_address;
    if (f.pinfl && !d.pinfl) d.pinfl = f.pinfl;
  } else if (docType === "tech_back") {
    if (f.tech_series && !d.techSeries) d.techSeries = f.tech_series;
    if (f.tech_number && !d.techNumber) d.techNumber = f.tech_number;
    if (f.tech_full && !d.techFull) d.techFull = f.tech_full;

    if (f.car_year && !d.carYear) d.carYear = f.car_year;
    if (f.body_number && !d.bodyNumber) d.bodyNumber = f.body_number;
    if (f.engine_volume && !d.engineVolume) d.engineVolume = f.engine_volume;
    if (f.fuel_type && !d.fuelType) d.fuelType = f.fuel_type;
    if (f.vin && !d.vin) d.vin = f.vin;
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
  }

  if (map.tech_front && map.tech_front.doc && map.tech_front.doc.result?.parsed) {
    const f = map.tech_front.doc.result.parsed.fields || {};
    if (d.plateNumber) f.plate_number = d.plateNumber;
    if (d.ownerName) f.owner_name = d.ownerName;
    if (d.ownerAddress) f.owner_address = d.ownerAddress;
    if (d.pinfl) f.pinfl = d.pinfl;
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
 * Привязка авто к водителю через /v1/parks/driver-profiles/car-bindings (PUT)
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

  // уже в формате YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return s;
  }

  // форматы вида DD.MM.YYYY, DD/MM/YYYY, DD-MM-YYYY
  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) {
    const d = m[1].padStart(2, "0");
    const mo = m[2].padStart(2, "0");
    const y = m[3];
    return `${y}-${mo}-${d}`;
  }

  // если не смогли распарсить — лучше вообще не отправлять
  return undefined;
}
function normalizeDriverLicenseNumber(countryCode, licenseSeries, licenseNumber, licenseFull) {
  // 1) берём готовое поле licenseFull, если есть
  let raw = (licenseFull && String(licenseFull).trim()) || "";
  // 2) иначе склеиваем серию + номер
  if (!raw) {
    raw = `${licenseSeries || ""}${licenseNumber || ""}`.trim();
  }
  if (!raw) return null;

  let v = raw.toUpperCase();

  // оставляем только латиницу и цифры
  v = v.replace(/[^0-9A-Z]/g, "");

  const country = (countryCode || "").toUpperCase();

  // Для Узбекистана часто в серию попадает "UZ" или "UZB" — убираем этот префикс
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

  // нормализуем даты к YYYY-MM-DD
  const issuedISO = normalizeDateToISO(driverPayload.issuedDate);
  const expiryISO = normalizeDateToISO(driverPayload.expiryDate);
  const birthISO = normalizeDateToISO(driverPayload.birthDate);

  // нормализуем номер В/У
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

  // 🔧 тип занятости: park env решает, но для selfemployed мы теперь ОТПРАВЛЯЕМ любой PINFL
  let employmentType =
    (FLEET_DEFAULT_EMPLOYMENT_TYPE || "individual").toLowerCase();

  // сырое значение налогового идентификатора (у вас это PINFL)
  let taxIdRaw =
    (driverPayload.taxId && String(driverPayload.taxId).trim()) ||
    (driverPayload.pinfl && String(driverPayload.pinfl).trim()) ||
    null;

  let taxId = null;

  if (employmentType === "selfemployed") {
    const digits = (taxIdRaw || "").replace(/\D/g, "");
    if (digits.length > 0) {
      // ВАЖНО: для Узбекистана PINFL 14 цифр — используем как есть
      taxId = digits;
    } else {
      console.warn(
        "createDriverInFleet: taxId отсутствует, переключаю employment_type на 'individual'. taxIdRaw=",
        taxIdRaw
      );
      employmentType = "individual";
      taxId = null;
    }
  }

  const account = {
    balance_limit: "0",
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
  };

  // 🔧 теперь tax_identification_number отправляем для selfemployed с ЛЮБЫМ валидным набором цифр (PINFL)
  if (employmentType === "selfemployed" && taxId) {
    person.tax_identification_number = taxId;
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
  const profile = data.profile || data.contractor_profile || {};
  const driverId = data.id || profile.id || null;

  if (!driverId) {
    return { ok: false, error: "Yandex Fleet не вернул id водителя", raw: data };
  }

  return { ok: true, driverId, raw: data };
}






/**
 * Создание автомобиля через /v2/parks/vehicles/car
 */
async function createCarInFleet(carPayload, session) {
  const cfg = ensureFleetConfigured();
  if (!cfg.ok) return { ok: false, error: cfg.message };

  const yandexColor = mapColorToYandex(session);

  // категоризации по тарифам + Delivery
  const baseTariffs = Array.isArray(carPayload.tariffs)
    ? carPayload.tariffs
    : [];
  const categories = baseTariffs
    .map((t) => TARIFF_CATEGORY_MAP[t])
    .filter(Boolean);

  if (session.wantsDelivery) {
    if (!categories.includes("express")) {
      categories.push("express");
    }
  }

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

  const vehicle = {
    brand: carPayload.brand || "",
    model: carPayload.model || "",
    color: yandexColor,
    year: yearInt,
    vin: carPayload.body_number || undefined,
    transmission: FLEET_DEFAULT_TRANSMISSION,
  };

  const parkProfile = {
    callsign: carPayload.call_sign || undefined,
    status: "working",
    categories: categories.length ? categories : undefined,
    fuel_type: carPayload.fuel_type || FLEET_DEFAULT_FUEL_TYPE,
    ownership_type: "park",
    is_park_property: false,
  };

  if (carPayload.is_cargo && carPayload.cargo_dimensions) {
    let carrying = 500;
    if (session.cargoSizeCode && session.cargoSizeCode.startsWith("M")) carrying = 800;
    if (session.cargoSizeCode && session.cargoSizeCode.startsWith("L")) carrying = 1500;
    if (session.cargoSizeCode === "XL") carrying = 2000;
    if (session.cargoSizeCode === "XXL") carrying = 2500;

    parkProfile.cargo = {
      carrying_capacity: carrying,
      cargo_hold_dimensions: {
        x: carPayload.cargo_dimensions.length,
        y: carPayload.cargo_dimensions.width,
        z: carPayload.cargo_dimensions.height,
      },
      allow_passengers: false,
    };
  }

  if (session.wantsDelivery) {
    parkProfile.amenities = ["delivery"];
  }

  const vehicleLicenses = {
    licence_plate_number: carPayload.plate_number,
    registration_certificate: carPayload.tech_full || carPayload.tech_number || "",
  };

  const idempotencyKey = `car-${FLEET_PARK_ID}-${carPayload.plate_number || ""}`;

  const body = {
    vehicle,
    park_profile: parkProfile,
    vehicle_licenses: vehicleLicenses,
  };

  const res = await callFleetPostIdempotent(
    "/v2/parks/vehicles/car",
    body,
    idempotencyKey
  );

  if (!res.ok) {
    return { ok: false, error: res.message || "car create error", raw: res.raw };
  }

  const data = res.data || {};
  const carId = data.vehicle_id || data.id || null;

  if (!carId) {
    return { ok: false, error: "Yandex Fleet не вернул id автомобиля", raw: data };
  }

  return { ok: true, carId, raw: data };
}

/**
 * Поиск водителя по телефону
 */
async function findDriverByPhone(phoneRaw) {
  const normalizedPhone = normalizePhoneForYandex(phoneRaw);
  const cfg = ensureFleetConfigured();
  if (!cfg.ok) {
    return { ok: false, found: false, error: cfg.message };
  }

  // ВАЖНО: убрали fields.*, чтобы не ловить 400 по неизвестным полям
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
          [dp.last_name, dp.first_name, dp.middle_name].filter(Boolean).join(" ") ||
          null;
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
 * Поиск водителя по номеру В/У (двойная проверка после загрузки ВУ)
 */
async function findDriverByLicense(licenseVariants) {
  const cfg = ensureFleetConfigured();
  if (!cfg.ok) {
    return { ok: false, found: false, error: cfg.message };
  }

  // ВАЖНО: убрали fields.*, чтобы не ловить 400 из-за неизвестных полей
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
    console.error("findDriverByLicense: fleet error:", res);
    return { ok: false, found: false, error: res.message };
  }

  const profiles = (res.data && res.data.driver_profiles) || [];
  if (!profiles.length) {
    return { ok: true, found: false };
  }

  const norm = (s) => {
    const country = (FLEET_DEFAULT_LICENSE_COUNTRY || "UZB").toUpperCase();
    return normalizeDriverLicenseNumber(country, null, null, s);
  };


  const wanted = (licenseVariants || []).map(norm).filter(Boolean);
  if (!wanted.length) return { ok: true, found: false };

  for (const item of profiles) {
    const dp = (item && item.driver_profile) || {};

    const rawLicenses = [];

    // 1) Наиболее типичный вариант: одиночный объект license
    if (dp.license && typeof dp.license.number === "string") {
      rawLicenses.push(dp.license.number);
    }

    // 2) На всякий случай — если API вернет массив licenses
    if (Array.isArray(dp.licenses)) {
      for (const l of dp.licenses) {
        if (l && typeof l.number === "string") {
          rawLicenses.push(l.number);
        }
      }
    }

    const normalizedFromApi = rawLicenses.map(norm).filter(Boolean);
    if (!normalizedFromApi.length) continue;

    for (const target of wanted) {
      if (normalizedFromApi.includes(target)) {
        const fullName =
          [dp.last_name, dp.first_name, dp.middle_name].filter(Boolean).join(" ") ||
          null;
        const phones = Array.isArray(dp.phones) ? dp.phones : [];
        const phoneFromApi =
          (phones[0] && (phones[0].number || phones[0].phone)) || null;
        const status =
          (item.current_status && item.current_status.status) || null;

        return {
          ok: true,
          found: true,
          driver: {
            id: dp.id || null,
            name: fullName,
            phone: phoneFromApi,
            status,
            license: target,
          },
        };
      }
    }
  }

  return { ok: true, found: false };
}


/**
 * Проверка статуса для кнопки "Проверить статус"
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

  return {
    ok: true,
    status: (found.driver && found.driver.status) || "registered",
    driver: found.driver,
  };
}

// ===== ЛОГИКА МЕНЮ ВОДИТЕЛЯ =====

function buildDriverMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "1️⃣ Проверить статус", callback_data: "menu:status" }],
      [{ text: "2️⃣ Фотоконтроль", callback_data: "menu:photocontrol" }],
      [{ text: "3️⃣ GPS ошибки", callback_data: "menu:gps" }],
      [{ text: "4️⃣ Активные цели (бонусы)", callback_data: "menu:goals" }],
      [{ text: "5️⃣ Пополнить баланс", callback_data: "menu:topup" }],
      [{ text: "6️⃣ Вывод средств", callback_data: "menu:withdraw" }],
      [{ text: "7️⃣ Лицензия / ОСГОП", callback_data: "menu:license" }],
      [{ text: "8️⃣ Пригласить друга", callback_data: "menu:invite" }],
      [{ text: "9️⃣ Видео-инструкция", callback_data: "menu:video" }],
      [{ text: "🔟 Связаться с оператором", callback_data: "menu:operator" }],
    ],
  };
}

async function openDriverCabinet(chatId, session, driverInfo) {
  if (driverInfo) {
    session.isExistingDriver = true;
    session.driverFleetId = driverInfo.id || null;
    session.driverName = driverInfo.name || null;
  }
  session.step = "driver_menu";

  const name = session.driverName || "haydovchi";

  const text =
    `👋 Добро пожаловать, *${name}*!\n\n` +
    "Это ваш личный кабинет ASR TAXI.\n" +
    "Выберите нужный раздел из меню ниже.";

  await sendTelegramMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: buildDriverMenuKeyboard(),
  });
}

async function handleMenuAction(chatId, session, action) {
  switch (action) {
    case "status": {
      const phone = session.phone || (session.data && session.data.phone);
      if (!phone) {
        await sendTelegramMessage(
          chatId,
          "Telefon raqamingiz ma'lumotlar bazasida topilmadi. Iltimos, ro‘yxatdan o‘tishdan boshlang."
        );
        return;
      }
      await sendTelegramMessage(
        chatId,
        "⏳ Yandex tizimida holatingizni tekshiryapman..."
      );
      const res = await checkYandexStatus(phone);
      if (!res.ok) {
        await sendTelegramMessage(
          chatId,
          `Holatni olishda xatolik: ${res.message || ""}`
        );
        return;
      }
      if (res.status === "working" || res.status === "registered") {
        await sendTelegramMessage(
          chatId,
          "✅ Sizning hisobingiz Yandex tizimida *faol*.\nYo‘llarda omad! 🚕",
          { parse_mode: "Markdown" }
        );
      } else if (res.status === "pending") {
        await sendTelegramMessage(
          chatId,
          "Sizning ro‘yxatdan o‘tishingiz hali yakunlanmagan. Birozdan keyin yana tekshirib ko‘ring."
        );
      } else if (res.status === "fired") {
        await sendTelegramMessage(
          chatId,
          "❗️ Hisobingiz holati: *Uvol qilingan* (fired).\nBatafsil ma'lumot uchun operator bilan bog‘laning.",
          { parse_mode: "Markdown" }
        );
      } else {
        await sendTelegramMessage(
          chatId,
          `Holatingiz bo‘yicha ma'lumot: *${res.status}*. Batafsil ma'lumot uchun operator bilan bog‘laning.`,
          { parse_mode: "Markdown" }
        );
      }
      break;
    }

    case "photocontrol": {
      await sendTelegramMessage(
        chatId,
        "📸 *Фотоконтроль*\n\n" +
          "• Делайте фото при хорошем освещении, без бликов.\n" +
          "• Лицо полностью видно, без очков и головных уборов.\n" +
          "• Номер автомобиля должен быть читаемым.\n" +
          "Если фотоконтроль не проходит — напишите оператору: @AsrTaxiAdmin",
        { parse_mode: "Markdown" }
      );
      break;
    }

    case "gps": {
      await sendTelegramMessage(
        chatId,
        "📍 *GPS ошибки*\n\n" +
          "1. Включите геолокацию на телефоне.\n" +
          "2. Разрешите доступ к геоданным для приложения Yandex Pro.\n" +
          "3. Включите режим высокой точности.\n" +
          "4. Перезапустите приложение.\n\n" +
          "Если проблема не решилась — напишите оператору: @AsrTaxiAdmin",
        { parse_mode: "Markdown" }
      );
      break;
    }

    case "goals": {
      await sendTelegramMessage(
        chatId,
        "🎯 *Активные цели и бонусы*\n\n" +
          "• В приложении Yandex Pro в разделе *«Цели»* вы видите персональные бонусы.\n" +
          "• Выполняйте нужное количество поездок и зарабатывайте дополнительные выплаты.\n" +
          "• По всем вопросам по целям и бонусам можно обратиться к оператору: @AsrTaxiAdmin.",
        { parse_mode: "Markdown" }
      );
      break;
    }

    case "topup": {
      await sendTelegramMessage(
        chatId,
        "💳 *Пополнение баланса*\n\n" +
          "Вы можете пополнить баланс следующими способами:\n\n" +
          "• PayMe\n" +
          "• PayNet\n" +
          "• @AsrPulBot — через бот самозанятости и карты.\n\n" +
          "Точный способ и реквизиты уточняйте у оператора: @AsrTaxiAdmin.",
        { parse_mode: "Markdown" }
      );
      break;
    }

    case "withdraw": {
      await sendTelegramMessage(
        chatId,
        "💸 *Вывод средств*\n\n" +
          "Вывод денег осуществляется *только через* @AsrPulBot.\n" +
          "Перейдите в бота и следуйте инструкции по выводу средств.\n\n" +
          "Если возникнут вопросы — напишите оператору: @AsrTaxiAdmin.",
        { parse_mode: "Markdown" }
      );
      break;
    }

    case "license": {
      await sendTelegramMessage(
        chatId,
        "📄 *Лицензия и ОСГОП*\n\n" +
          "Для работы в парке вам требуется действующая лицензия и ОСГОП.\n\n" +
          "Общий порядок:\n" +
          "1. Оформляете самозанятость через @AsrPulBot.\n" +
          "2. Получаете лицензию и ОСГОП по инструкции от парка.\n" +
          "3. Передаёте документы оператору для проверки и загрузки в систему.\n\n" +
          "Подробную персональную инструкцию уточните у оператора: @AsrTaxiAdmin.",
        { parse_mode: "Markdown" }
      );
      break;
    }

    case "invite": {
      await sendTelegramMessage(
        chatId,
        "🤝 *Пригласить друга*\n\n" +
          "Акция: *100 000 сум за 50 заказов* приглашённого водителя.\n\n" +
          "1. Пригласите друга зарегистрироваться через этот бот.\n" +
          "2. Сообщите оператору его номер телефона.\n" +
          "3. После того как он выполнит 50 заказов — вы получите бонус.\n\n" +
          "Детали уточняйте у оператора: @AsrTaxiAdmin.",
        { parse_mode: "Markdown" }
      );
      break;
    }

    case "video": {
      await sendTelegramMessage(
        chatId,
        "🎥 *Видео-инструкция*\n\n" +
          "Основные шаги регистрации и подключения описаны в этом боте.\n" +
          "Как только будет готово отдельное видео с подробной инструкцией, оператор отправит вам ссылку.\n\n" +
          "Если нужна помощь уже сейчас — напишите оператору: @AsrTaxiAdmin.",
        { parse_mode: "Markdown" }
      );
      break;
    }

    case "operator": {
      await sendTelegramMessage(
        chatId,
        "👨‍💼 *Связаться с оператором*\n\n" +
          "Для быстрой связи напишите оператору в Telegram: @AsrTaxiAdmin",
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
            text: "📲 Отправить номер телефона",
            request_contact: true,
          },
        ],
      ],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
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
    "🚗 Выберите *марку автомобиля* из списка ниже.\n\n" +
    "Если у вас грузовой автомобиль — выберите пункт «Грузовые».";

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
    `🚗 Марка: *${brandLabel}*\n\n` +
    "Теперь выберите *модель автомобиля*:";

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
    "🚚 Выбор размера кузова\n\n" +
    "Если указать кузов больше реального — *Yandex аккаунтni blok qilishi mumkin*.\n\n" +
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
    reply_markup: { remove_keyboard: true },
    parse_mode: "Markdown",
  });
}

async function askDocTechFront(chatId, session) {
  session.step = "waiting_tech_front";
  const text =
    "📄 Endi avtomobil *texpasportining old tomonini* yuboring.\n\n" +
    "Foto aniq va to‘liq hujjat ko‘rinadigan bo‘lsin.";
  await sendTelegramMessage(chatId, text, { parse_mode: "Markdown" });
}

async function askDocTechBack(chatId, session) {
  session.step = "waiting_tech_back";
  const text =
    "📄 Va nihoyat, texpasportning *orqa tomonini* yuboring.\n\n" +
    "Bu yerdan avtomobil yili, kuzov raqami va boshqa ma'lumotlar olinadi.";
  await sendTelegramMessage(chatId, text, { parse_mode: "Markdown" });
}

// Вопрос про Delivery (включение только по желанию водителя)
async function askDeliveryOption(chatId, session) {
  session.step = "waiting_delivery_choice";

  const text =
    "📦 *Delivery (dostavka) opsiyasi*\n\n" +
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
    "Agar ishonchingiz komil bo‘lsa — *«Ha, tasdiqlayman»* tugmasini bosing.\n" +
    "Agar nimanidir o‘zgartirmoqchi bo‘lsangiz — *«O‘zgartirish»* tugmasini bosing.";

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

async function autoRegisterInYandexFleet(chatId, session) {
  const d = session.data || {};
  const brandCode = session.carBrandCode;
  const brandLabel = session.carBrandLabel;
  const phone = session.phone || d.phone;

  // Тарифы
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

  if (!tariffsInfo.hasRules) {
    session.registerWithoutCar = true;
  }

  const { brand, model } = splitCarBrandModel(session.carModelLabel || "");
  const nowYear = new Date().getFullYear();
  const carYearInt = parseInt(d.carYear, 10);

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

  // Создание водителя
  const driverPayload = {
    phone,
    full_name: d.driverName,
    last_name: d.lastName,
    first_name: d.firstName,
    middle_name: d.middleName,
    licenseFull: d.licenseFull,
    licenseSeries: d.licenseSeries,
    licenseNumber: d.licenseNumber,
    pinfl: d.pinfl,
    issuedDate: d.issuedDate,
    expiryDate: d.expiryDate,
    birthDate: d.birthDate,
    isHunter: session.isHunterReferral,
  };

  const driverRes = await createDriverInFleet(driverPayload);
  if (!driverRes.ok) {
    await sendTelegramMessage(
      chatId,
      "❗️ Yandex tizimida haydovchi ro‘yxatdan o‘tkazishda xatolik yuz berdi. Operator bilan bog‘laning."
    );
    await sendOperatorAlert(
      "*Ошибка авто-регистрации водителя в Yandex Fleet*\n\n" +
        `Телефон: \`${phone || "—"}\`\n` +
        `Xato: ${driverRes.error || "noma'lum"}`
    );
    return;
  }

  session.driverFleetId = driverRes.driverId || null;

  let carId = null;

  if (canCreateCar) {
    const pozivnoiSource = String(phone || "").replace(/[^\d]/g, "");
    const pozivnoi = pozivnoiSource.slice(-7) || null;

    const carPayload = {
      brand,
      model,
      year: d.carYear,
      color: session.carColor,
      plate_number: d.plateNumber,
      body_number: d.bodyNumber,
      call_sign: pozivnoi,
      tariffs: session.assignedTariffs,
      is_cargo: session.isCargo,
      cargo_dimensions: session.cargoDimensions || null,
      tech_full: d.techFull,
      tech_number: d.techNumber,
    };

    const carRes = await createCarInFleet(carPayload, session);
    if (!carRes.ok) {
      await sendTelegramMessage(
        chatId,
        "⚠️ Haydovchi ro‘yxatdan o‘tdi, ammo avtomobilni avtomatik qo‘shib bo‘lmadi. Operator avtomobilni qo‘lda qo‘shadi."
      );
      await sendOperatorAlert(
        "*Ошибка добавления автомобиля в Yandex Fleet*\n\n" +
          `Телефон: \`${phone || "—"}\`\n` +
          `Xato: ${carRes.error || "noma'lum"}`
      );
      session.registerWithoutCar = true;
    } else {
      carId = carRes.carId || null;
      session.carFleetId = carId;
    }
  }

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

  await sendDocsToOperators(chatId, session, {
    note: session.registerWithoutCar
      ? "Регистрация ВОДИТЕЛЯ *БЕЗ АВТОМОБИЛЯ* (недостаточно данных по авто или модель не найдена в тарифной базе)."
      : "Новый водитель автоматически зарегистрирован в Yandex Fleet (водитель + авто).",
  });

  const tariffStr = (session.assignedTariffs || []).join(", ") || "—";

  let finishText =
    "🎉 Siz Yandex tizimida muvaffaqiyatli ro‘yxatdan o‘tdingiz!\n\n" +
    `Ulanilgan tariflar: *${tariffStr}*.\n\n` +
    "Endi sizga faqat *@AsrPulBot* orqali samozanyatlikdan o‘tish qoladi.";

  if (session.wantsDelivery) {
    finishText +=
      "\n\n📦 Sizga qo‘shimcha ravishda *Delivery (yetkazib berish)* buyurtmalari ham yoqilgan bo‘lishi mumkin (park siyosatiga qarab).";
  }

  if (session.registerWithoutCar) {
    finishText +=
      "\n\n⚠️ Avtomobilingiz ma'lumotlari to‘liq aniqlanmadi, siz hozircha *avtomobilsiz* ro‘yxatdan o‘tdingiz.\n" +
      "Operator tez orada siz bilan bog‘lanib, avtomobilni qo‘lda qo‘shadi.";
  }

  await sendTelegramMessage(chatId, finishText, {
    parse_mode: "Markdown",
    reply_markup: {
      keyboard: [
        [{ text: "🔄 Ro‘yxatdan o‘tish holatini tekshirish" }],
        [{ text: "🚕 Открыть личный кабинет" }],
      ],
      resize_keyboard: true,
    },
  });

  scheduleStatusReminders(chatId);
  session.step = "driver_menu";
}

// ===== ОБРАБОТКА ФОТО ДОКУМЕНТОВ =====

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

  // ===== тут как раз нужная правка В/У =====
  // ===== обработка водительского удостоверения (ВУ) =====
  if (docType === "vu_front") {
    const d = session.data || {};
    const countryCode = (FLEET_DEFAULT_LICENSE_COUNTRY || "UZB").toUpperCase();

    // Нормализуем полный код ВУ (серия+номер), убираем мусор, UZ/UZB и т.д.
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

    // Аккуратно раскладываем cleanNumber на серию и номер:
    // пример: AF000488684 -> серия: AF, номер: 000488684
    let series = d.licenseSeries || null;
    let num = d.licenseNumber || null;

    const m = cleanNumber.match(/^([A-Z]{2,3})(\d{5,})$/);
    if (m) {
      series = m[1];     // только буквы
      num = m[2];        // только цифры
    }

    d.licenseSeries = series;
    d.licenseNumber = num;
    d.licenseFull = cleanNumber; // чистый без UZ/UZB и мусора

    session.data = d;
    recomputeDerived(session); // чтобы всё красиво пересчиталось

    // Ищем водителя в Яндексе по нормализованному номеру ВУ
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

    await askCarBrand(chatId, session);
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

      // перед подтверждением спрашиваем про Delivery
      await askDeliveryOption(chatId, session);
    }
  }
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
    await sendTelegramMessage(
      chatId,
      "✅ Siz Yandex tizimida allaqachon ro‘yxatdan o‘tgan ekansiz.\n" +
        "Endi shaxsiy kabinetni ochamiz."
    );
    await openDriverCabinet(chatId, session, found.driver);
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

    // первая сводка: "всё верно / изменить"
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
  const text = msg.text || "";
  let session = getSession(chatId);

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
  if (
    text === "🔄 Ro‘yxatdan o‘tish holatini tekshirish" ||
    text === "🔄 Проверить статус регистрации" ||
    text.toLowerCase().includes("status")
  ) {
    await handleMenuAction(chatId, session, "status");
    return { statusCode: 200, body: "OK" };
  }

  // Кнопка "Открыть личный кабинет"
  if (text === "🚕 Открыть личный кабинет") {
    await openDriverCabinet(chatId, session, {
      id: session.driverFleetId,
      name: session.driverName,
    });
    return { statusCode: 200, body: "OK" };
  }

  // Контакт (номер телефона)
  if (msg.contact) {
    if (session.step === "waiting_phone" || session.step === "idle") {
      await handlePhoneCaptured(chatId, session, msg.contact.phone_number);
      return { statusCode: 200, body: "OK" };
    } else {
      await sendOperatorAlert(
        "*Номер телефона отправлен водителем вне сценария*\n\n" +
          `Chat ID: \`${chatId}\`\n` +
          `Telefon: \`${msg.contact.phone_number}\``
      );
      await sendTelegramMessage(
        chatId,
        "Телефон успешно передан оператору.\n" +
          "Для быстрой связи напишите оператору: @AsrTaxiAdmin"
      );
      return { statusCode: 200, body: "OK" };
    }
  }

  // Если ждём телефон и пришёл текст
  if (session.step === "waiting_phone" && text) {
    await handlePhoneCaptured(chatId, session, text.trim());
    return { statusCode: 200, body: "OK" };
  }

  // выбор цвета текстом
  if (session.step === "waiting_car_color" && text) {
    session.carColor = text.trim();
    session.carColorCode = null;
    session.data = session.data || {};
    session.data.carColor = session.carColor;
    await sendTelegramMessage(
      chatId,
      `🎨 Rang qabul qilindi: *${session.carColor}*`,
      { parse_mode: "Markdown" }
    );
    await askDocTechFront(chatId, session);
    return { statusCode: 200, body: "OK" };
  }

  // ввод значения при редактировании поля
  if (session.step === "editing_field" && session.editAwaitingValue && text) {
    const idx = session.editIndex || 0;
    const field = EDIT_FIELDS[idx];
    if (!field) {
      session.editAwaitingValue = false;
      await askNextEditField(chatId, session);
      return { statusCode: 200, body: "OK" };
    }

    const value = text.trim();
    setFieldValue(session, field.key, value);
    recomputeDerived(session);

    const msgText =
      `*${field.label}* maydoni uchun yangi qiymat: \`${value}\`.\n\n` +
      "Endi bu qiymat to‘g‘rimi?";

    session.editAwaitingValue = false;

    await sendTelegramMessage(chatId, msgText, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Tasdiqlash", callback_data: "edit_field_confirm" },
            { text: "✏️ Yana o‘zgartirish", callback_data: "edit_field_change" },
          ],
        ],
      },
    });

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
