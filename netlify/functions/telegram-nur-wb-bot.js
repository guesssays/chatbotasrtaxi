// netlify/functions/telegram-nur-wb-bot.js
//
// Бот для набора водителей в парк NUR TAXI (WB Taxi)

const TELEGRAM_TOKEN =
  process.env.NUR_WB_BOT_TOKEN || process.env.TG_NUR_WB_BOT_TOKEN || "";
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const NUR_WB_SHEETS_WEBHOOK_URL =
  process.env.NUR_WB_SHEETS_WEBHOOK_URL || "";
const NUR_WB_STAFF_CHAT_ID = process.env.NUR_WB_STAFF_CHAT_ID || "";

const ADMIN_IDS_RAW = process.env.NUR_WB_ADMIN_CHAT_IDS || "";
const ADMIN_IDS = new Set(
  ADMIN_IDS_RAW.split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
);

// простая проверка, чтобы не забыть токен
if (!TELEGRAM_TOKEN) {
  console.error("NUR_WB_BOT_TOKEN is not set (telegram-nur-wb-bot.js)");
}

// ===== Netlify Blobs storage (общий store.js уже есть в проекте) =====
const { initBlobStore, getStore } = require("./bot/store");

const NUR_STORE_NAME = "nur-wb-drivers";

function getNurStore() {
  try {
    return getStore(NUR_STORE_NAME);
  } catch (e) {
    console.error("getNurStore error:", e);
    return null;
  }
}

// ===== Сессии в памяти =====

/**
 * session = {
 *   lang: "uz_cy" | "uz_lat" | "ru",
 *   step: "idle" | ...,
 *   data: {...},       // анкета водителя
 *   isAdmin: boolean,  // для рассылок
 * }
 */
const sessions = new Map(); // chatId -> session

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      lang: null,
      step: "idle",
      data: {},
      isAdmin: false,
    });
  }
  return sessions.get(chatId);
}

function resetSession(session) {
  session.lang = null;
  session.step = "idle";
  session.data = {};
}

// ===== Локализация =====

const TEXTS = {
  ru: {
    chooseLang:
      "Выберите язык анкеты:\n\n1️⃣ Узбекский (кириллица)\n2️⃣ Узбекский (латиница)\n3️⃣ Русский",
    btnUzCy: "Ўзбекча (кириллица)",
    btnUzLat: "Oʻzbekcha (lotincha)",
    btnRu: "Русский",
    askFullName: "Укажите, пожалуйста, *ФИО* полностью:",
    askPhone:
      "Укажите, пожалуйста, номер телефона для связи.\n\nМожно отправить контакт кнопкой ниже или написать текстом.",
    btnSendPhone: "📲 Отправить контакт",
    askPlatforms:
      "В каких платформах вы работали?\n\nОтметьте все варианты, затем нажмите «Готово».",
    plYandex: "Яндекс Про",
    plMyTaxi: "MyTaxi",
    plInDrive: "inDrive",
    plOther: "Другая",
    plNone: "Не работал",
    plDone: "✅ Готово",
    askExperience: "Общий стаж работы в такси:",
    exp1: "< 6 месяцев",
    exp2: "6–12 месяцев",
    exp3: "1–3 года",
    exp4: "> 3 лет",
    askYandexRating:
      "Укажите рейтинг в Яндекс Про (например, 4.92) или напишите «не работал»:",
    askCarModel: "Напишите марку и модель автомобиля (например, \"Cobalt\", \"Nexia 3\"):",
    askCarYear:
      "Выберите диапазон года выпуска авто:",
    year1: "до 2010",
    year2: "2010–2014",
    year3: "2015–2018",
    year4: "2019–2021",
    year5: "2022+",
    askVuPhoto:
      "Сейчас нужно отправить *фото водительского удостоверения* (лицевая сторона). Отправьте одно фото.",
    askTechFront:
      "Теперь отправьте *фото техпаспорта (лицевая сторона)*.",
    askTechBack:
      "И ещё одно фото: *техпаспорт (обратная сторона)*.",
    askLicense:
      "Лицензия на такси:\nВыберите один вариант.",
    askOsgop: "ОСГОП (страховка):",
    askMed083: "Мед. форма 083:",
    askBranding:
      "Готовы к брендированию авто WB Taxi?",
    stHas: "Есть",
    stNo: "Нет",
    stInProgress: "В процессе",
    stUnknown: "Не знаю",
    brandYes: "Да",
    brandThink: "Нужно подумать",
    brandNo: "Нет",
    confirmText:
      "Проверьте, пожалуйста, корректность данных и подтвердите отправку.\n\n",
    btnConfirmYes: "✅ Всё верно, отправить",
    btnConfirmNo: "❌ Изменить / отменить",
    registered:
      "Спасибо! Ваша анкета отправлена в парк NUR TAXI (WB Taxi). С вами свяжется оператор.",
    staffNewDriverTitle: "Новый водитель NUR TAXI (WB Taxi)",
    statusNew: "новый",
    adminOnly:
      "Эта команда доступна только администраторам.",
    broadcastStartQuestion:
      "Запустить рассылку «Готовы выйти на линию WB Taxi завтра?» всем водителям в базе?",
    btnBroadcastYes: "🚀 Запустить рассылку",
    btnBroadcastNo: "Отмена",
    broadcastStarted: "Рассылка запущена. Сообщения отправляются…",
    readyQuestion:
      "Готовы выйти на линию WB Taxi завтра? (смена от 6 часов, соблюдение правил парка)",
    readyYes: "Да",
    readyNo: "Нет",
    readyThanksYes:
      "Спасибо! Зафиксировали, что вы готовы выйти на линию.",
    readyThanksNo:
      "Спасибо за ответ! Если планы изменятся, свяжитесь с оператором.",
  },

  // Узбекский кириллица
  uz_cy: {
    chooseLang:
      "Анкета тилини танланг:\n\n1️⃣ Ўзбекча (кириллица)\n2️⃣ Ўзбекча (лотин)\n3️⃣ Русча",
    btnUzCy: "Ўзбекча (кириллица)",
    btnUzLat: "Oʻzbekcha (lotincha)",
    btnRu: "Русский",
    askFullName:
      "Илтимос, тўлиқ *ФИО* ни ёзинг:",
    askPhone:
      "Боғланиш учун телефон рақамингизни юборинг.\n\nКонтактни тугма орқали юборишингиз ёки матн билан ёзишингиз мумкин.",
    btnSendPhone: "📲 Телефон рақамни юбориш",
    askPlatforms:
      "Қайси платформаларда ишлагансиз?\n\nБарча мос вариантларни танланг, сўнг «Тайёр» тугмасини босинг.",
    plYandex: "Yandex Pro",
    plMyTaxi: "MyTaxi",
    plInDrive: "inDrive",
    plOther: "Бошқа",
    plNone: "Ишламаганман",
    plDone: "✅ Тайёр",
    askExperience: "Таксида умумий тажрибангиз:",
    exp1: "< 6 ой",
    exp2: "6–12 ой",
    exp3: "1–3 йил",
    exp4: "> 3 йил",
    askYandexRating:
      "Yandex Pro'даги рейтингингизни ёзинг (масалан, 4.92) ёки «ишламаганман» деб ёзинг:",
    askCarModel:
      "Автомобил бренди ва моделини ёзинг (масалан, \"Cobalt\", \"Nexia 3\"):",
    askCarYear: "Автомобил ишлаб чиқарилган йил диапазонини танланг:",
    year1: "2010 гача",
    year2: "2010–2014",
    year3: "2015–2018",
    year4: "2019–2021",
    year5: "2022+",
    askVuPhoto:
      "Энди *ҳайдовчилик гувоҳномаси олд томони* расмини юборинг. Бирта фото етарли.",
    askTechFront:
      "Эндиликда *техпаспорт олд томони* расмини юборинг.",
    askTechBack:
      "Яна бир фото: *техпаспорт орқа томони*.",
    askLicense:
      "Такси лицензияси:\nБир вариантни танланг.",
    askOsgop: "OSGOP (суғурта):",
    askMed083: "083 тиббий форма:",
    askBranding:
      "Автомобилни WB Taxi брендингига тайёрлашга тайёрмисиз?",
    stHas: "Бор",
    stNo: "Йўқ",
    stInProgress: "Жараёнда",
    stUnknown: "Билмайман",
    brandYes: "Ҳа",
    brandThink: "Ўйлаб кўраман",
    brandNo: "Йўқ",
    confirmText:
      "Илтимос, маълумотларни текширинг ва тасдиқланг.\n\n",
    btnConfirmYes: "✅ Ҳаммаси тўғри, юбориш",
    btnConfirmNo: "❌ Таҳрирлаш / бекор қилиш",
    registered:
      "Рахмат! Анкетангиз NUR TAXI (WB Taxi) паркига юборилди. Оператор сиз билан боғланади.",
    staffNewDriverTitle: "Yangi haydovchi NUR TAXI (WB Taxi)",
    statusNew: "yangi",
    adminOnly: "Бу команда фақат админлар учун.",
    broadcastStartQuestion:
      "«Ertaga WB Taxi liniyasiga chiqishga tayyormisiz?» саволи билан барча базага хабар жўнатамизми?",
    btnBroadcastYes: "🚀 Jo'natishni boshlash",
    btnBroadcastNo: "Bekor qilish",
    broadcastStarted: "Рассылка бошланди. Хабарлар жўнатилмоқда…",
    readyQuestion:
      "Ertaga WB Taxi liniyasiga chiqishga tayyormisiz? (смена камида 6 соат, парк қоидаларига амал қилиш шарт)",
    readyYes: "Ha",
    readyNo: "Yo'q",
    readyThanksYes:
      "Rahmat! Liniyaga chiqishga tayyorligingiz qayd etildi.",
    readyThanksNo:
      "Javobingiz uchun rahmat! Rejalar o'zgarsa, operator bilan bog'ланинг.",
  },

  // Узбекский латиница
  uz_lat: {
    chooseLang:
      "Anketa tilini tanlang:\n\n1️⃣ Oʻzbekcha (kirill)\n2️⃣ Oʻzbekcha (lotin)\n3️⃣ Ruscha",
    btnUzCy: "Oʻzbekcha (kirill)",
    btnUzLat: "Oʻzbekcha (lotincha)",
    btnRu: "Русский",
    askFullName: "Iltimos, toʻliq *FIO* ni yozing:",
    askPhone:
      "Bogʻlanish uchun telefon raqamingizni yuboring.\n\nKontaktni tugma orqali yuborishingiz yoki matn bilan yozishingiz mumkin.",
    btnSendPhone: "📲 Telefon raqamni yuborish",
    askPlatforms:
      "Qaysi platformalarda ishlagansiz?\n\nMos variantlarni barchasini tanlab chiqing, soʻng «Tayyor» tugmasini bosing.",
    plYandex: "Yandex Pro",
    plMyTaxi: "MyTaxi",
    plInDrive: "inDrive",
    plOther: "Boshqa",
    plNone: "Ishlamaganman",
    plDone: "✅ Tayyor",
    askExperience: "Taksida umumiy tajribangiz:",
    exp1: "< 6 oy",
    exp2: "6–12 oy",
    exp3: "1–3 yil",
    exp4: "> 3 yil",
    askYandexRating:
      "Yandex Pro dagi reytingingizni yozing (masalan, 4.92) yoki «ishlamaganman» deb yozing:",
    askCarModel:
      "Avtomobil brendi va modelini yozing (masalan, \"Cobalt\", \"Nexia 3\"):",
    askCarYear:
      "Avtomobil ishlab chiqarilgan yil diapazonini tanlang:",
    year1: "2010 gacha",
    year2: "2010–2014",
    year3: "2015–2018",
    year4: "2019–2021",
    year5: "2022+",
    askVuPhoto:
      "Endi *haydovchilik guvohnomasi old tomoni* suratini yuboring. Bitta foto yetarli.",
    askTechFront:
      "Keyingi qadam: *texpasport old tomoni* suratini yuboring.",
    askTechBack:
      "Yana bitta foto: *texpasport orqa tomoni*.",
    askLicense:
      "Taksi litsenziyasi:\nBitta variantni tanlang.",
    askOsgop: "OSGOP (sug'urta):",
    askMed083: "083 tibbiy forma:",
    askBranding:
      "Avtomobilni WB Taxi brendiga tayyorlashga tayyormisiz?",
    stHas: "B bor",
    stNo: "Yo'q",
    stInProgress: "Jarayonda",
    stUnknown: "Bilmayman",
    brandYes: "Ha",
    brandThink: "O'ylab ko'raman",
    brandNo: "Yo'q",
    confirmText:
      "Iltimos, ma'lumotlarni tekshirib ko'ring va tasdiqlang.\n\n",
    btnConfirmYes: "✅ Hammasi toʻgʻri, yuborish",
    btnConfirmNo: "❌ Tahrirlash / bekor qilish",
    registered:
      "Rahmat! Anketangiz NUR TAXI (WB Taxi) parkiga yuborildi. Operator siz bilan bogʻlanadi.",
    staffNewDriverTitle: "Yangi haydovchi NUR TAXI (WB Taxi)",
    statusNew: "yangi",
    adminOnly: "Bu buyruq faqat administratorlar uchun.",
    broadcastStartQuestion:
      "«Ertaga WB Taxi liniyasiga chiqishga tayyormisiz?» savoli bilan barcha bazaga xabar yuboramizmi?",
    btnBroadcastYes: "🚀 Jo'natishni boshlash",
    btnBroadcastNo: "Bekor qilish",
    broadcastStarted: "Tarqatish boshlandi. Xabarlar yuborilmoqda…",
    readyQuestion:
      "Ertaga WB Taxi liniyasiga chiqishga tayyormisiz? (smena kamida 6 soat, park qoidalariga rioya qilish shart)",
    readyYes: "Ha",
    readyNo: "Yo'q",
    readyThanksYes:
      "Rahmat! Liniyaga chiqishga tayyorligingiz qayd etildi.",
    readyThanksNo:
      "Javobingiz uchun rahmat! Rejalar o'zgarsa, operator bilan bog'laning.",
  },
};

function tr(lang, key) {
  const dict = TEXTS[lang] || TEXTS["ru"];
  return dict[key] || TEXTS["ru"][key] || key;
}

// ===== Телеграм-хелперы =====

async function callTelegram(method, body) {
  const res = await fetch(`${TELEGRAM_API_URL}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { ok: false, raw: text };
  }
  if (!res.ok || !json.ok) {
    console.error("Telegram API error:", method, res.status, text);
  }
  return json;
}

function sendTelegramMessage(chatId, text, extra) {
  return callTelegram("sendMessage", {
    chat_id: chatId,
    text,
    ...extra,
  });
}

function sendTelegramPhoto(chatId, fileId, extra) {
  return callTelegram("sendPhoto", {
    chat_id: chatId,
    photo: fileId,
    ...extra,
  });
}

function answerCallbackQuery(callbackQueryId, extra) {
  return callTelegram("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...extra,
  });
}

function editMessageReplyMarkup(chatId, messageId, replyMarkup) {
  return callTelegram("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup || undefined,
  });
}

// ===== Генерация внутреннего ID (NUR-0001, NUR-0002, ...) =====

async function getNextDriverId() {
  const store = getNurStore();
  if (!store) {
    console.error("No NUR store, cannot generate driverId");
    return null;
  }

  let meta =
    (await store.get("meta", {
      type: "json",
    })) || { lastId: 0 };

  const next = Number(meta.lastId || 0) + 1;
  meta.lastId = next;
  await store.setJSON("meta", meta);

  const numStr = String(next).padStart(4, "0");
  return `NUR-${numStr}`;
}

/**
 * индекс в blobs для рассылок:
 * key "index" -> { drivers: [ { driverId, chatId, lang, status } ] }
 */
async function updateDriverIndex(driver) {
  const store = getNurStore();
  if (!store) return;

  let idx =
    (await store.get("index", {
      type: "json",
    })) || { drivers: [] };

  const existing = idx.drivers.find((d) => d.driverId === driver.driverId);
  if (existing) {
    existing.chatId = driver.chatId;
    existing.lang = driver.lang;
    existing.status = driver.status || existing.status || "new";
  } else {
    idx.drivers.push({
      driverId: driver.driverId,
      chatId: driver.chatId,
      lang: driver.lang,
      status: driver.status || "new",
    });
  }

  await store.setJSON("index", idx);
}

async function saveDriver(driver) {
  const store = getNurStore();
  if (!store) return;
  await store.setJSON(`driver:${driver.driverId}`, driver);
  await updateDriverIndex(driver);
}

async function loadDriver(driverId) {
  const store = getNurStore();
  if (!store) return null;
  const d = await store.get(`driver:${driverId}`, { type: "json" });
  return d || null;
}

// ===== Google Sheets интеграция =====

async function sendRegistrationToSheets(driver) {
  if (!NUR_WB_SHEETS_WEBHOOK_URL) {
    console.log(
      "NUR_WB_SHEETS_WEBHOOK_URL is not set; skipping Sheets append."
    );
    return;
  }

  const payload = {
    eventType: "registration",
    driverId: driver.driverId,
    registeredAt: driver.registeredAt,
    language: driver.lang,

    fullName: driver.fullName,
    phone: driver.phone,

    platforms: driver.platformsText,
    experience: driver.experienceCategory,
    yandexRating: driver.yandexRating,

    carModel: driver.carModel,
    carYearCategory: driver.carYearCategory,

    vuPhotoFileId: driver.vuPhotoFileId,
    techFrontFileId: driver.techFrontFileId,
    techBackFileId: driver.techBackFileId,

    licenseStatus: driver.licenseStatus,
    osgopStatus: driver.osgopStatus,
    med083Status: driver.med083Status,
    brandingStatus: driver.brandingStatus,

    status: driver.status || "new",
    operatorComment: driver.operatorComment || "",
    lastReadyAnswer: driver.lastReadyAnswer || "",
    lastReadyAt: driver.lastReadyAt || "",
    telegramChatId: driver.chatId || "",
  };

  try {
    const res = await fetch(NUR_WB_SHEETS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error("sendRegistrationToSheets error:", res.status, txt);
    }
  } catch (e) {
    console.error("sendRegistrationToSheets exception:", e);
  }
}

async function sendReadyAnswerToSheets(driver, answer) {
  if (!NUR_WB_SHEETS_WEBHOOK_URL) return;

  const payload = {
    eventType: "ready_poll",
    driverId: driver.driverId,
    fullName: driver.fullName,
    phone: driver.phone,
    answer: answer, // "yes" | "no"
    answerLabel: answer === "yes" ? "Да" : "Нет",
    timestamp: driver.lastReadyAt,
  };

  try {
    const res = await fetch(NUR_WB_SHEETS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error("sendReadyAnswerToSheets error:", res.status, txt);
    }
  } catch (e) {
    console.error("sendReadyAnswerToSheets exception:", e);
  }
}

// ===== Анкета: вопросы по шагам =====

function languageKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: TEXTS.ru.btnUzCy }],
        [{ text: TEXTS.ru.btnUzLat }],
        [{ text: TEXTS.ru.btnRu }],
      ],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
    parse_mode: "Markdown",
  };
}

async function askLanguage(chatId, session) {
  session.step = "choose_language";
  await sendTelegramMessage(chatId, TEXTS.ru.chooseLang, languageKeyboard());
}

async function askFullName(chatId, session) {
  session.step = "waiting_full_name";
  await sendTelegramMessage(chatId, tr(session.lang, "askFullName"), {
    parse_mode: "Markdown",
    reply_markup: { remove_keyboard: true },
  });
}

async function askPhone(chatId, session) {
  session.step = "waiting_phone";
  await sendTelegramMessage(chatId, tr(session.lang, "askPhone"), {
    parse_mode: "Markdown",
    reply_markup: {
      keyboard: [
        [
          {
            text: tr(session.lang, "btnSendPhone"),
            request_contact: true,
          },
        ],
      ],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

function platformsKeyboard(session) {
  const lang = session.lang;
  const chosen = new Set(session.data.platforms || []);
  const row = (code, key) => {
    const text = tr(lang, key);
    const mark = chosen.has(code) ? "✅ " : "";
    return {
      text: mark + text,
      callback_data: `pl:${code}`,
    };
  };

  return {
    inline_keyboard: [
      [row("yandex", "plYandex"), row("mytaxi", "plMyTaxi")],
      [row("indrive", "plInDrive"), row("other", "plOther")],
      [row("none", "plNone")],
      [
        {
          text: tr(lang, "plDone"),
          callback_data: "pl_done",
        },
      ],
    ],
  };
}

async function askPlatforms(chatId, session) {
  session.step = "waiting_platforms";
  if (!Array.isArray(session.data.platforms)) {
    session.data.platforms = [];
  }
  await sendTelegramMessage(chatId, tr(session.lang, "askPlatforms"), {
    reply_markup: platformsKeyboard(session),
  });
}

function experienceKeyboard(lang) {
  return {
    inline_keyboard: [
      [
        { text: tr(lang, "exp1"), callback_data: "exp:<6" },
        { text: tr(lang, "exp2"), callback_data: "exp:6-12" },
      ],
      [
        { text: tr(lang, "exp3"), callback_data: "exp:1-3" },
        { text: tr(lang, "exp4"), callback_data: "exp:>3" },
      ],
    ],
  };
}

async function askExperience(chatId, session) {
  session.step = "waiting_experience";
  await sendTelegramMessage(chatId, tr(session.lang, "askExperience"), {
    reply_markup: experienceKeyboard(session.lang),
  });
}

async function askYandexRating(chatId, session) {
  session.step = "waiting_yandex_rating";
  await sendTelegramMessage(chatId, tr(session.lang, "askYandexRating"), {
    parse_mode: "Markdown",
  });
}

async function askCarModel(chatId, session) {
  session.step = "waiting_car_model";
  await sendTelegramMessage(chatId, tr(session.lang, "askCarModel"));
}

function carYearKeyboard(lang) {
  return {
    inline_keyboard: [
      [
        { text: tr(lang, "year1"), callback_data: "year:<=2010" },
        { text: tr(lang, "year2"), callback_data: "year:2010-2014" },
      ],
      [
        { text: tr(lang, "year3"), callback_data: "year:2015-2018" },
        { text: tr(lang, "year4"), callback_data: "year:2019-2021" },
      ],
      [{ text: tr(lang, "year5"), callback_data: "year:2022+" }],
    ],
  };
}

async function askCarYear(chatId, session) {
  session.step = "waiting_car_year";
  await sendTelegramMessage(chatId, tr(session.lang, "askCarYear"), {
    reply_markup: carYearKeyboard(session.lang),
  });
}

async function askVuPhoto(chatId, session) {
  session.step = "waiting_vu_photo";
  await sendTelegramMessage(chatId, tr(session.lang, "askVuPhoto"), {
    parse_mode: "Markdown",
  });
}

async function askTechFront(chatId, session) {
  session.step = "waiting_tech_front";
  await sendTelegramMessage(chatId, tr(session.lang, "askTechFront"), {
    parse_mode: "Markdown",
  });
}

async function askTechBack(chatId, session) {
  session.step = "waiting_tech_back";
  await sendTelegramMessage(chatId, tr(session.lang, "askTechBack"), {
    parse_mode: "Markdown",
  });
}

function statusKeyboard(lang, prefix) {
  return {
    inline_keyboard: [
      [
        {
          text: tr(lang, "stHas"),
          callback_data: `${prefix}:has`,
        },
        {
          text: tr(lang, "stNo"),
          callback_data: `${prefix}:no`,
        },
      ],
      [
        {
          text: tr(lang, "stInProgress"),
          callback_data: `${prefix}:progress`,
        },
        {
          text: tr(lang, "stUnknown"),
          callback_data: `${prefix}:unknown`,
        },
      ],
    ],
  };
}

async function askLicenseStatus(chatId, session) {
  session.step = "waiting_license_status";
  await sendTelegramMessage(chatId, tr(session.lang, "askLicense"), {
    reply_markup: statusKeyboard(session.lang, "st_license"),
    parse_mode: "Markdown",
  });
}

async function askOsgopStatus(chatId, session) {
  session.step = "waiting_osgop_status";
  await sendTelegramMessage(chatId, tr(session.lang, "askOsgop"), {
    reply_markup: statusKeyboard(session.lang, "st_osgop"),
    parse_mode: "Markdown",
  });
}

async function askMed083Status(chatId, session) {
  session.step = "waiting_med_status";
  await sendTelegramMessage(chatId, tr(session.lang, "askMed083"), {
    reply_markup: statusKeyboard(session.lang, "st_med"),
    parse_mode: "Markdown",
  });
}

function brandingKeyboard(lang) {
  return {
    inline_keyboard: [
      [
        {
          text: tr(lang, "brandYes"),
          callback_data: "brand:yes",
        },
        {
          text: tr(lang, "brandThink"),
          callback_data: "brand:think",
        },
      ],
      [
        {
          text: tr(lang, "brandNo"),
          callback_data: "brand:no",
        },
      ],
    ],
  };
}

async function askBranding(chatId, session) {
  session.step = "waiting_branding";
  await sendTelegramMessage(chatId, tr(session.lang, "askBranding"), {
    reply_markup: brandingKeyboard(session.lang),
    parse_mode: "Markdown",
  });
}

function confirmKeyboard(lang) {
  return {
    inline_keyboard: [
      [
        {
          text: tr(lang, "btnConfirmYes"),
          callback_data: "confirm:yes",
        },
      ],
      [
        {
          text: tr(lang, "btnConfirmNo"),
          callback_data: "confirm:no",
        },
      ],
    ],
  };
}

function formatPlatforms(lang, codes) {
  const map = {
    yandex: tr(lang, "plYandex"),
    mytaxi: tr(lang, "plMyTaxi"),
    indrive: tr(lang, "plInDrive"),
    other: tr(lang, "plOther"),
    none: tr(lang, "plNone"),
  };
  if (!codes || !codes.length) return "";
  return codes.map((c) => map[c] || c).join(" / ");
}

function formatStatusLabel(lang, code) {
  if (code === "has") return tr(lang, "stHas");
  if (code === "no") return tr(lang, "stNo");
  if (code === "progress") return tr(lang, "stInProgress");
  if (code === "unknown") return tr(lang, "stUnknown");
  return code || "";
}

function formatBranding(lang, code) {
  if (code === "yes") return tr(lang, "brandYes");
  if (code === "think") return tr(lang, "brandThink");
  if (code === "no") return tr(lang, "brandNo");
  return code || "";
}

async function showConfirmation(chatId, session) {
  session.step = "confirm";

  const lang = session.lang;
  const d = session.data;

  const lines = [];
  lines.push(tr(lang, "confirmText"));
  lines.push(`👤 *ФИО:* ${d.fullName || "—"}`);
  lines.push(`📞 *Телефон:* ${d.phone || "—"}`);
  lines.push("");
  lines.push(
    `🧭 *Платформы:* ${formatPlatforms(lang, d.platforms) || "—"}`
  );
  lines.push(
    `⏱ *Стаж:* ${d.experienceCategory || "—"}`
  );
  lines.push(
    `⭐ *Рейтинг Яндекс:* ${d.yandexRating || "—"}`
  );
  lines.push("");
  lines.push(
    `🚗 *Авто:* ${d.carModel || "—"} (${d.carYearCategory || "—"})`
  );
  lines.push("");
  lines.push(
    `📄 *Лицензия:* ${formatStatusLabel(lang, d.licenseStatus)}`
  );
  lines.push(
    `📄 *ОСГОП:* ${formatStatusLabel(lang, d.osgopStatus)}`
  );
  lines.push(
    `📄 *Мед. 083:* ${formatStatusLabel(lang, d.med083Status)}`
  );
  lines.push(
    `🎨 *Брендирование WB:* ${formatBranding(lang, d.brandingStatus)}`
  );

  await sendTelegramMessage(chatId, lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: confirmKeyboard(lang),
  });
}

// ===== Регистрация водителя (создание объекта, ID, Sheets, staff-чат) =====

async function finalizeRegistration(chatId, session) {
  const data = session.data;

  const driverId = await getNextDriverId();
  if (!driverId) {
    await sendTelegramMessage(
      chatId,
      "Техническая ошибка при сохранении анкеты. Попробуйте чуть позже или обратитесь к оператору."
    );
    return;
  }

  const lang = session.lang || "ru";
  const nowIso = new Date().toISOString();

  const driver = {
    driverId,
    chatId,
    lang,
    registeredAt: nowIso,

    fullName: data.fullName || "",
    phone: data.phone || "",

    platforms: data.platforms || [],
    platformsText: formatPlatforms(lang, data.platforms || []),
    experienceCategory: data.experienceCategory || "",
    yandexRating: data.yandexRating || "",

    carModel: data.carModel || "",
    carYearCategory: data.carYearCategory || "",

    vuPhotoFileId: data.vuPhotoFileId || "",
    techFrontFileId: data.techFrontFileId || "",
    techBackFileId: data.techBackFileId || "",

    licenseStatus: data.licenseStatus || "",
    osgopStatus: data.osgopStatus || "",
    med083Status: data.med083Status || "",
    brandingStatus: data.brandingStatus || "",

    status: "new",
    operatorComment: "",
    lastReadyAnswer: "",
    lastReadyAt: "",
  };

  await saveDriver(driver);
  await sendRegistrationToSheets(driver);

  // сообщение в служебный чат
  if (NUR_WB_STAFF_CHAT_ID) {
    const staffLines = [];
    staffLines.push(`🆕 *${tr(lang, "staffNewDriverTitle")}*`);
    staffLines.push("");
    staffLines.push(`ID: \`${driver.driverId}\``);
    staffLines.push(`ФИО: ${driver.fullName || "—"}`);
    staffLines.push(`Телефон: ${driver.phone || "—"}`);
    staffLines.push(`Платформы: ${driver.platformsText || "—"}`);
    staffLines.push(
      `Стаж: ${driver.experienceCategory || "—"}`
    );
    staffLines.push(
      `Рейтинг Яндекс: ${driver.yandexRating || "—"}`
    );
    staffLines.push(
      `Авто: ${driver.carModel || "—"} (${driver.carYearCategory || "—"})`
    );
    staffLines.push("");
    staffLines.push(
      `Лицензия: ${formatStatusLabel(lang, driver.licenseStatus)}`
    );
    staffLines.push(
      `ОСГОП: ${formatStatusLabel(lang, driver.osgopStatus)}`
    );
    staffLines.push(
      `Мед. 083: ${formatStatusLabel(lang, driver.med083Status)}`
    );
    staffLines.push(
      `Брендинг WB: ${formatBranding(lang, driver.brandingStatus)}`
    );
    staffLines.push("");
    staffLines.push(`Статус: ${tr(lang, "statusNew")}`);

    await sendTelegramMessage(NUR_WB_STAFF_CHAT_ID, staffLines.join("\n"), {
      parse_mode: "Markdown",
    });
  }

  // сообщение водителю
  await sendTelegramMessage(chatId, tr(lang, "registered"), {
    parse_mode: "Markdown",
    reply_markup: { remove_keyboard: true },
  });

  resetSession(session);
}

// ===== Рассылка "Готовы выйти на линию?" =====

async function startBroadcastReady(chatId, session) {
  if (!ADMIN_IDS.has(chatId)) {
    await sendTelegramMessage(chatId, tr("ru", "adminOnly"));
    return;
  }
  session.step = "broadcast_confirm";
  await sendTelegramMessage(chatId, tr("ru", "broadcastStartQuestion"), {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: tr("ru", "btnBroadcastYes"),
            callback_data: "broadcast_ready:start",
          },
        ],
        [
          {
            text: tr("ru", "btnBroadcastNo"),
            callback_data: "broadcast_ready:cancel",
          },
        ],
      ],
    },
  });
}

async function runBroadcastReady(chatId) {
  const store = getNurStore();
  if (!store) return;

  let idx =
    (await store.get("index", {
      type: "json",
    })) || { drivers: [] };

  const drivers = idx.drivers || [];
  console.log("Broadcasting ready-question to drivers count:", drivers.length);

  for (const d of drivers) {
    if (!d.chatId) continue;
    const lang = d.lang || "ru";
    await sendTelegramMessage(
      d.chatId,
      tr(lang, "readyQuestion"),
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: tr(lang, "readyYes"),
                callback_data: `ready_answer:yes:${d.driverId}`,
              },
              {
                text: tr(lang, "readyNo"),
                callback_data: `ready_answer:no:${d.driverId}`,
              },
            ],
          ],
        },
      }
    );
  }

  await sendTelegramMessage(chatId, tr("ru", "broadcastStarted"));
}

async function handleReadyAnswer(chatId, data, callback) {
  const [, answer, driverId] = data.split(":"); // ready_answer:yes:NUR-0001

  const driver = await loadDriver(driverId);
  if (!driver) {
    await answerCallbackQuery(callback.id, {
      text: "Driver not found",
      show_alert: true,
    });
    return;
  }

  const lang = driver.lang || "ru";
  const ansCode = answer === "yes" ? "yes" : "no";

  driver.lastReadyAnswer = ansCode;
  driver.lastReadyAt = new Date().toISOString();

  await saveDriver(driver);
  await sendReadyAnswerToSheets(driver, ansCode);

  await answerCallbackQuery(callback.id);

  await sendTelegramMessage(
    chatId,
    ansCode === "yes"
      ? tr(lang, "readyThanksYes")
      : tr(lang, "readyThanksNo")
  );
}

// ===== Основной handler Netlify =====

exports.handler = async function (event) {
  try {
    initBlobStore(event); // общий init из store.js

    if (event.httpMethod !== "POST") {
      return { statusCode: 200, body: "OK" };
    }

    const update = JSON.parse(event.body || "{}");

    // callback_query
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message && cq.message.chat && cq.message.chat.id;
      if (!chatId) {
        await answerCallbackQuery(cq.id);
        return { statusCode: 200, body: "OK" };
      }
      const session = getSession(chatId);
      await handleCallback(chatId, session, cq);
      return { statusCode: 200, body: "OK" };
    }

    // обычные сообщения
    if (update.message) {
      const msg = update.message;
      const chat = msg.chat || {};
      const chatId = chat.id;
      if (!chatId) return { statusCode: 200, body: "OK" };

      const session = getSession(chatId);
      if (ADMIN_IDS.has(chatId)) session.isAdmin = true;

      await handleMessage(chatId, session, msg);
      return { statusCode: 200, body: "OK" };
    }

    return { statusCode: 200, body: "OK" };
  } catch (e) {
    console.error("telegram-nur-wb-bot handler error:", e);
    return { statusCode: 200, body: "OK" };
  }
};

// ===== Обработка сообщений =====

async function handleMessage(chatId, session, msg) {
  // если это команда
  if (msg.text) {
    const text = msg.text.trim();

    if (text === "/start") {
      resetSession(session);
      await askLanguage(chatId, session);
      return;
    }

    if (text === "/broadcast_ready") {
      await startBroadcastReady(chatId, session);
      return;
    }

    // выбор языка по текстовой кнопке
    if (session.step === "choose_language") {
      if (text === TEXTS.ru.btnUzCy) {
        session.lang = "uz_cy";
      } else if (text === TEXTS.ru.btnUzLat) {
        session.lang = "uz_lat";
      } else if (text === TEXTS.ru.btnRu) {
        session.lang = "ru";
      }

      if (!session.lang) {
        await askLanguage(chatId, session);
        return;
      }

      await askFullName(chatId, session);
      return;
    }

    // если язык ещё не выбран — форсим выбор
    if (!session.lang) {
      await askLanguage(chatId, session);
      return;
    }

    // шаги, где нужен текст
    if (session.step === "waiting_full_name") {
      session.data.fullName = text;
      await askPhone(chatId, session);
      return;
    }

    if (session.step === "waiting_yandex_rating") {
      session.data.yandexRating = text;
      await askCarModel(chatId, session);
      return;
    }

    if (session.step === "waiting_car_model") {
      session.data.carModel = text;
      await askCarYear(chatId, session);
      return;
    }
  }

  // контакт (телефон)
  if (msg.contact) {
    const phone = msg.contact.phone_number;
    session.data.phone = phone;
    await askPlatforms(chatId, session);
    return;
  }

  // текстом прислали телефон вместо контакта
  if (msg.text && session.step === "waiting_phone") {
    session.data.phone = msg.text.trim();
    await askPlatforms(chatId, session);
    return;
  }

  // фото документов
  const hasPhoto =
    Array.isArray(msg.photo) ||
    (msg.document &&
      msg.document.mime_type &&
      msg.document.mime_type.startsWith("image/"));

  if (hasPhoto) {
    let fileId = null;
    if (Array.isArray(msg.photo) && msg.photo.length) {
      fileId = msg.photo[msg.photo.length - 1].file_id;
    } else if (msg.document) {
      fileId = msg.document.file_id;
    }

    if (session.step === "waiting_vu_photo") {
      session.data.vuPhotoFileId = fileId;
      await askTechFront(chatId, session);
      return;
    }
    if (session.step === "waiting_tech_front") {
      session.data.techFrontFileId = fileId;
      await askTechBack(chatId, session);
      return;
    }
    if (session.step === "waiting_tech_back") {
      session.data.techBackFileId = fileId;
      await askLicenseStatus(chatId, session);
      return;
    }
  }
}

// ===== Обработка callback-кнопок =====

async function handleCallback(chatId, session, cq) {
  const data = cq.data || "";

  // мультивыбор платформ
  if (data.startsWith("pl:") || data === "pl_done") {
    if (!Array.isArray(session.data.platforms)) {
      session.data.platforms = [];
    }
    const set = new Set(session.data.platforms);

    if (data === "pl_done") {
      await answerCallbackQuery(cq.id);
      await askExperience(chatId, session);
      return;
    }

    const code = data.split(":")[1];
    if (set.has(code)) set.delete(code);
    else set.add(code);

    session.data.platforms = Array.from(set);

    await answerCallbackQuery(cq.id);
    await editMessageReplyMarkup(
      chatId,
      cq.message.message_id,
      platformsKeyboard(session)
    );
    return;
  }

  // стаж
  if (data.startsWith("exp:")) {
    const code = data.split(":")[1];
    const lang = session.lang;
    let label = "";
    if (code === "<6") label = tr(lang, "exp1");
    else if (code === "6-12") label = tr(lang, "exp2");
    else if (code === "1-3") label = tr(lang, "exp3");
    else if (code === ">3") label = tr(lang, "exp4");
    else label = code;

    session.data.experienceCategory = label;
    await answerCallbackQuery(cq.id);
    await askYandexRating(chatId, session);
    return;
  }

  // год авто
  if (data.startsWith("year:")) {
    const code = data.split(":")[1];
    const lang = session.lang;
    let label = "";
    switch (code) {
      case "<=2010":
        label = tr(lang, "year1");
        break;
      case "2010-2014":
        label = tr(lang, "year2");
        break;
      case "2015-2018":
        label = tr(lang, "year3");
        break;
      case "2019-2021":
        label = tr(lang, "year4");
        break;
      case "2022+":
        label = tr(lang, "year5");
        break;
      default:
        label = code;
    }
    session.data.carYearCategory = label;

    await answerCallbackQuery(cq.id);
    await askVuPhoto(chatId, session);
    return;
  }

  // статусы
  if (data.startsWith("st_license:")) {
    const code = data.split(":")[1];
    session.data.licenseStatus = code;
    await answerCallbackQuery(cq.id);
    await askOsgopStatus(chatId, session);
    return;
  }

  if (data.startsWith("st_osgop:")) {
    const code = data.split(":")[1];
    session.data.osgopStatus = code;
    await answerCallbackQuery(cq.id);
    await askMed083Status(chatId, session);
    return;
  }

  if (data.startsWith("st_med:")) {
    const code = data.split(":")[1];
    session.data.med083Status = code;
    await answerCallbackQuery(cq.id);
    await askBranding(chatId, session);
    return;
  }

  if (data.startsWith("brand:")) {
    const code = data.split(":")[1];
    session.data.brandingStatus = code;
    await answerCallbackQuery(cq.id);
    await showConfirmation(chatId, session);
    return;
  }

  // подтверждение анкеты
  if (data === "confirm:yes") {
    await answerCallbackQuery(cq.id);
    await finalizeRegistration(chatId, session);
    return;
  }

  if (data === "confirm:no") {
    await answerCallbackQuery(cq.id, {
      text: "Анкета не отправлена. При необходимости начните заново командой /start.",
      show_alert: true,
    });
    resetSession(session);
    return;
  }

  // рассылка
  if (data === "broadcast_ready:start") {
    await answerCallbackQuery(cq.id);
    await runBroadcastReady(chatId);
    return;
  }

  if (data === "broadcast_ready:cancel") {
    await answerCallbackQuery(cq.id, { text: "Отменено." });
    session.step = "idle";
    return;
  }

  // ответы водителей "готов выйти?"
  if (data.startsWith("ready_answer:")) {
    await handleReadyAnswer(chatId, data, cq);
    return;
  }

  await answerCallbackQuery(cq.id);
}
