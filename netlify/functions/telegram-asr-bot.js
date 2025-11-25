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

// ===== Yandex Fleet API (Park) для проверки статуса =====
const FLEET_API_URL = process.env.FLEET_API_URL || null;
const FLEET_API_KEY = process.env.FLEET_API_KEY || null;
const FLEET_CLIENT_ID = process.env.FLEET_CLIENT_ID || null;
const FLEET_PARK_ID = process.env.FLEET_PARK_ID || null;

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
  // очищаем старые таймеры для этого чата
  cancelStatusReminders(chatId);

  const delaysMinutes = [5, 10, 15]; // можно менять (5/10/15 минут)
  const text =
    "ℹ️ Eslatma: agar hali ro‘yxatdan o‘tish holatini tekshirmagan bo‘lsangiz, " +
    "\"🔄 Ro‘yxatdan o‘tish holatini tekshirish\" tugmasini bosib ko‘rishingiz mumkin.";

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
      carModelCode: null,
      carModelLabel: null,
      carColor: null,

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
    });
  }
  return sessions.get(chatId);
}

function resetSession(chatId) {
  sessions.delete(chatId);
  cancelStatusReminders(chatId);
}

// ===== СПИСОК МОДЕЛЕЙ И ЦВЕТОВ =====

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

const EXTRA_POPULAR_MODELS = [
  "Chevrolet Cobalt",
  "Chevrolet Gentra",
  "Nexia 3",
  "Chevrolet Lacetti",
  "Chevrolet Spark",
  "Chevrolet Malibu",
  "Chevrolet Tracker",
  "Damas",
  "Chevrolet Captiva",
  "Chevrolet Onix",
];

// Сюда ВСТАВЬ весь твой большой список, как в сообщении:
// «Acura MDX    от 2004» и т.д. — прям строка в строку.
const CAR_MODELS_SOURCE = `
Acura MDX	от 2004
Acura RDX	от 2006
Acura TLX	от 2014
Acura TSX	от 2006
Audi A1	от 2019
Audi A2	не допускается
Audi A3	от 2012
Audi A4	от 2006
Audi A5	от 2007
Audi A6	от 2004
Audi A7	от 2010
Audi A8	от 2004
Audi Q3	от 2012
Audi Q5	от 2008
Audi Q7	от 2005
Audi S3	от 2012
Audi S4	от 2006
Audi S8	от 2004
BAIC EU5	от 2015
BAIC EX5	от 2019
BAIC U5	от 2014
Beijing EU7	от 2019
BMW 1er	от 2012
BMW 2er Active Tourer	от 2014
BMW 2er Grand Tourer	от 2015
BMW 3er	от 2006
BMW 5er	от 2004
BMW 7er	от 2004
BMW i3	от 2019
BMW X1	от 2012
BMW X3	от 2006
BMW X4	от 2014
BMW X5	от 2004
BMW X6	от 2007
Brilliance H230	не допускается
Brilliance H530	от 2011
Brilliance M2 (BS4)	от 2006
Brilliance V3	от 2019
Brilliance V5	от 2012
Buick Electra E5	от 2022
Buick Excelle	от 2012
Buick Velite 6	от 2019
BYD Chazor	от 2022
BYD E2	от 2019
BYD Han	от 2020
BYD Qin Plus	от 2018
BYD Qin Pro	от 2018
BYD Seagull	от 2023
BYD Song Plus	от 2020
BYD Tang	от 2015
BYD Yuan	от 2019
Cadillac SRX	от 2006
Changan Alsvin	от 2019
Changan Auchan A600 EV	от 2018
Changan CS35	от 2019
Changan CS35 Plus	от 2019
Changan CS55	от 2017
Changan CS75	от 2014
Changan Eado	от 2013
Changan New Van	от 2022
Chery Amulet (A15)	от 2012
Chery Arrizo 6 Pro	от 2023
Chery Arrizo 7	от 2013
Chery Bonus (A13)	не допускается
Chery Bonus 3 (E3/A19)	не допускается
Chery CrossEastar (B14)	от 2006
Chery E5	от 2012
Chery EQ5	от 2020
Chery Fora (A21)	не допускается
Chery IndiS (S18D)	не допускается
Chery M11 (A3)	от 2012
Chery QQ6 (S21)	не допускается
Chery Tiggo (T11)	от 2012
Chery Tiggo 2	от 2019
Chery Tiggo 3	от 2014
Chery Tiggo 4	от 2019
Chery Tiggo 4 Pro	от 2020
Chery Tiggo 5	от 2014
Chery Tiggo 7	от 2016
Chery Tiggo 7 Pro	от 2020
Chery Tiggo 7 Pro Max	от 2022
Chery Tiggo 8	от 2018
Chery Tiggo 8 Pro	от 2021
Chery Tiggo 8 Pro Max	от 2022
Chery Very (A13)	не допускается
Chevrolet Aveo	от 2019
Chevrolet Blazer	от 2004
Chevrolet Bolt	от 2019
Chevrolet Captiva	от 2006
Chevrolet Cobalt	от 2019
Chevrolet Colorado	от 2012
Chevrolet Cruze	от 2012
Chevrolet Epica	от 2006
Chevrolet Equinox	от 2006
Chevrolet Evanda	от 2006
Chevrolet Impala	от 2004
Chevrolet Kalos	не допускается
Chevrolet Lacetti	от 2012
Chevrolet Lanos	не допускается
Chevrolet Malibu	от 2006
Chevrolet MATIZ	не допускается
Chevrolet Menlo	от 2020
Chevrolet Monza	от 2012
Chevrolet Nexia	от 2019
Chevrolet Nubira	не допускается
Chevrolet Onix	от 2019
Chevrolet Orlando	от 2012
Chevrolet Sonic	от 2019
Chevrolet Tahoe	от 2012
Chevrolet Tracker	от 2019
Chevrolet TrailBlazer	от 2012
Chevrolet Traverse	от 2008
Chevrolet Volt	от 2012
Chrysler 300C	от 2004
Chrysler Sebring	от 2006
Chrysler Voyager	от 2012
Citroen Berlingo	от 2012
Citroen C3	от 2019
Citroen C3 Picasso	от 2012
Citroen C4	от 2012
Citroen C4 Aircross	от 2012
Citroen C4 Picasso	от 2012
Citroen C5	от 2006
Citroen C8	от 2012
Citroen C-Crosser	от 2007
Citroen C-Elysee	от 2019
Citroen DS4	от 2012
Citroen DS5	от 2012
Citroen Jumpy	от 2012
Citroen Nemo	от 2012
Citroen SpaceTourer	от 2016
Citroen Xantia	не допускается
Citroen Xsara	не допускается
Dacia Duster	от 2019
Dacia Lodgy	от 2012
Dacia Logan	от 2019
Dacia Sandero	от 2019
Daewoo Gentra	от 2015
Daewoo Kalos	не допускается
Daewoo Lacetti	не допускается
Daewoo Lanos	не допускается
Daewoo Leganza	от 2004
Daewoo Magnus	от 2006
Daewoo Nexia	не допускается
Daewoo Nubira	не допускается
Daewoo Sens	не допускается
Daewoo Tacuma	от 2012
Daewoo Winstorm	от 2006
Daihatsu Boon	от 2019
Daihatsu Materia	не допускается
Daihatsu Move	от 2012
Daihatsu Sirion	не допускается
Datsun mi-DO	от 2019
Datsun on-DO	от 2019
Dodge Caliber	от 2006
Dodge Caravan	от 2012
Dodge Charger	от 2004
Dodge Journey	от 2007
Dodge Neon	от 2012
Dodge Stratus	от 2006
DongFeng 580	от 2017
DongFeng A30	от 2014
DongFeng Aeolus E70	от 2019
DongFeng AX7	от 2015
DongFeng E1	от 2020
DongFeng H30 Cross	не допускается
DongFeng S30	от 2013
DongFeng S50 EV	от 2014
Enovate ME7	от 2019
Evolute I-joy	от 2022
Evolute I-pro	от 2022
EXEED LX	от 2019
EXEED TXL	от 2019
EXEED VX	от 2021
FAW Bestune T55	от 2021
FAW Bestune T77	от 2018
FAW Besturn B50	от 2012
FAW Besturn B70	от 2006
FAW Besturn X40	от 2019
FAW CA5041	не допускается
FAW Oley	не допускается
FAW V2	не допускается
FAW V5	не допускается
FAW Vita	не допускается
FAW X80	от 2013
Fiat Albea	не допускается
Fiat Bravo	от 2012
Fiat Croma	не допускается
Fiat Doblo	от 2012
Fiat Fiorino	от 2012
Fiat Freemont	от 2012
Fiat Linea	от 2012
Fiat Multipla	не допускается
Fiat Palio	не допускается
Fiat Punto	не допускается
Fiat Qubo	от 2012
Fiat Scudo	от 2012
Fiat Stilo	не допускается
Fiat Tipo	от 2012
Ford C-MAX	от 2012
Ford EcoSport	от 2019
Ford Escape	от 2012
Ford Escort	не допускается
Ford Explorer	от 2004
Ford Festiva	не допускается
Ford Fiesta	от 2019
Ford Focus	от 2012
Ford Focus (North America)	не допускается
Ford Focus RS	от 2012
Ford Fusion	не допускается
Ford Fusion (North America)	от 2006
Ford Galaxy	от 2012
Ford Kuga	от 2012
Ford Mondeo	от 2006
Ford S-MAX	от 2012
Ford Territory	от 2012
GAC Aion S	от 2019
GAC Aion V	от 2020
GAC Aion Y	от 2021
GAC GN8	от 2020
Geely Atlas	от 2016
Geely Atlas Pro	от 2021
Geely CK (Otaka)	не допускается
Geely Coolray	от 2019
Geely Emgrand 7	от 2016
Geely Emgrand EC7	от 2009
Geely Emgrand EC8	от 2012
Geely Emgrand GT	от 2015
Geely Emgrand X7	от 2012
Geely FC (Vision)	от 2006
Geely GC6	не допускается
Geely Geometry C	от 2020
Geely LC (Panda) Cross	не допускается
Geely MK	от 2012
Geely MK Cross	не допускается
Geely SC7	от 2012
Geely Tugella	от 2019
Geely TX4	от 2012
Genesis G70	от 2017
Genesis G80	от 2016
Great Wall Coolbear	не допускается
Great Wall Florid	не допускается
Great Wall Hover	не допускается
Great Wall Hover H3	от 2012
Great Wall Hover H5	от 2012
Great Wall Hover H6	от 2012
Great Wall Hover M2	не допускается
Great Wall Hover M4	не допускается
Great Wall Safe	не допускается
Great Wall Voleex C30	от 2012
Haval F7	от 2019
Haval F7x	от 2019
Haval H2	от 2019
Haval H6	от 2014
Haval H8	от 2014
Haval Jolion	от 2021
Hawtai B21	от 2013
Honda Accord	от 2006
Honda Airwave	не допускается
Honda Avancier	от 2006
Honda Civic	от 2012
Honda Crosstour	от 2009
Honda CR-V	от 2012
Honda Domani	не допускается
Honda Elysion	от 2012
Honda Fit	от 2019
Honda Fit Aria	не допускается
Honda Fit Shuttle	не допускается
Honda Freed	от 2012
Honda Grace	от 2019
Honda HR-V	от 2018
Honda Insight	от 2012
Honda Inspire	от 2006
Honda Integra	не допускается
Honda Integra SJ	не допускается
Honda Jazz	от 2019
Honda Legend	от 2006
Honda Logo	не допускается
Honda M-NV	от 2020
Honda Mobilio	от 2012
Honda Odyssey	от 2012
Honda Odyssey (North America)	от 2012
Honda Orthia	не допускается
Honda Partner	не допускается
Honda Pilot	от 2004
Honda Saber	не допускается
Honda Shuttle	от 2019
Honda Stepwgn	от 2012
Honda Stream	от 2012
Honda Torneo	не допускается
Honda Vamos	от 2012
Honda Vezel	от 2019
Honda X-NV	от 2019
Hongqi E-HS3	от 2018
Hongqi E-QM5	от 2021
Hongqi H5	от 2017
Hyundai Accent	от 2019
Hyundai Avante	от 2012
Hyundai Click	не допускается
Hyundai Creta	от 2019
Hyundai Elantra	от 2012
Hyundai Equus	от 2004
Hyundai Genesis	от 2008
Hyundai Getz	не допускается
Hyundai Grand Starex	от 2012
Hyundai Grandeur	от 2004
Hyundai H-1	от 2012
Hyundai i20	от 2019
Hyundai i30	от 2012
Hyundai i40	от 2011
Hyundai IONIQ	от 2016
Hyundai ix35	от 2012
Hyundai ix55	от 2008
Hyundai Lafesta	от 2018
Hyundai Matrix	не допускается
Hyundai Santa Fe	от 2006
Hyundai Solaris	от 2019
Hyundai Sonata	от 2006
Hyundai Terracan	не допускается
Hyundai Tucson	от 2012
Hyundai Veloster	от 2019
Hyundai Verna	от 2019
Hyundai XG	от 2004
Infiniti EX	от 2007
Infiniti FX	от 2004
Infiniti G	от 2006
Infiniti Q30	от 2015
Infiniti Q50	от 2013
Infiniti Q70	от 2013
Infiniti QX30	от 2015
Infiniti QX50	от 2013
Infiniti QX60	от 2013
Infiniti QX70	от 2013
Infiniti QX80	от 2013
JAC iEV7S	от 2019
JAC J5 (Heyue)	от 2014
JAC J7	от 2020
JAC J7 (Binyue)	от 2007
JAC JS4	от 2020
JAC S3	от 2014
JAC S5 (Eagle)	от 2013
Jaguar F-Pace	от 2016
Jaguar S-Type	от 2004
Jaguar XE	от 2015
Jaguar XF	от 2007
Jaguar XJ	от 2004
Jaguar X-Type	от 2006
Jeep Cherokee	от 2012
Jeep Compass	от 2012
Jeep Grand Cherokee	от 2012
Jeep Liberty (Patriot)	от 2012
Jetour Dashing	от 2022
Jetour X70	от 2018
Jetour X70 PLUS	от 2020
Jetour X90 PLUS	от 2021
Jetour X95	от 2019
Jetour Х70	от 2018
Kaiyi E5	от 2021
Karry K60 EV	от 2016
Kia Cadenza	от 2009
Kia Carens	от 2012
Kia Carnival	от 2012
Kia Cee'd	от 2012
Kia Cee'd SW	от 2012
Kia Cerato	от 2012
Kia Clarus	не допускается
Kia Forte	от 2012
Kia K3	от 2012
Kia K5	от 2010
Kia K7	от 2009
Kia K8	от 2021
Kia K900	от 2014
Kia Lotze	от 2006
Kia Magentis	от 2004
Kia Mohave (Borrego)	от 2008
Kia Niro	от 2016
Kia Opirus	от 2004
Kia Optima	от 2006
Kia Pride	не допускается
Kia ProCeed	от 2018
Kia Quoris	от 2012
Kia Ray	
не допускается

Kia Rio	от 2019
Kia Sedona	от 2012
Kia Seltos	от 2019
Kia Sephia	не допускается
Kia Shuma	не допускается
Kia Sorento	от 2006
Kia Soul	от 2019
Kia Soul EV	от 2019
Kia Spectra	не допускается
Kia Sportage	от 2012
Kia Stinger	от 2017
Kia Venga	от 2012
LADA (ВАЗ) Granta	от 2019
LADA (ВАЗ) Largus	от 2012
LADA (ВАЗ) Vesta	
от 2019

LADA (ВАЗ) XRAY	от 2019
LADA (кроме указанных моделей)	не допускается
Land Rover Discovery	от 2012
Land Rover Discovery Sport	от 2014
Land Rover Freelander	от 2012
Land Rover Range Rover	от 2012
Land Rover Range Rover Evoque	от 2012
Land Rover Range Rover Sport	от 2012
Land Rover Range Rover Velar	от 2017
Leapmotor C11	от 2021
Leapmotor T03	от 2020
Levdeo i3	не допускается
Lexus CT	от 2012
Lexus ES	от 2004
Lexus GS	от 2004
Lexus GX	от 2012
Lexus HS	от 2009
Lexus IS	от 2006
Lexus LS	от 2004
Lexus LX	от 2012
Lexus NX	от 2014
Lexus RX	от 2004
Lifan 620	от 2012
Lifan Breez (520)	от 2012
Lifan Cebrium (720)	от 2014
Lifan Celliya (530)	не допускается
Lifan Murman	от 2015
Lifan Myway	от 2016
Lifan Solano	от 2012
Lifan X50	от 2019
Lifan X60	от 2012
Lifan X70	от 2017
Mazda 2	от 2019
Mazda 3	от 2012
Mazda 3 MPS	от 2012
Mazda 323	не допускается
Mazda 5	от 2012
Mazda 6	от 2006
Mazda 6 MPS	от 2006
Mazda 626	не допускается
Mazda Atenza	от 2006
Mazda Axela	от 2012
Mazda Biante	от 2012
Mazda Bongo	от 2012
Mazda Capella	не допускается
Mazda CX-5	от 2012
Mazda CX-7	от 2006
Mazda CX-9	от 2006
Mazda Demio	от 2019
Mazda Familia	от 2012
Mazda Millenia	не допускается
Mazda MPV	от 2012
Mazda MX-6	не допускается
Mazda Premacy	от 2012
Mazda Protege	не допускается
Mazda Tribute	не допускается
Mazda Verisa	не допускается
Mercedes-Benz A-klasse	от 2012
Mercedes-Benz B-klasse	от 2012
Mercedes-Benz Citan	от 2012
Mercedes-Benz C-klasse	от 2006
Mercedes-Benz C-klasse AMG	от 2006
Mercedes-Benz CLA-klasse	от 2013
Mercedes-Benz CLA-klasse AMG	от 2013
Mercedes-Benz CLS-klasse	от 2004
Mercedes-Benz CLS-klasse AMG	от 2005
Mercedes-Benz E-klasse	от 2004
Mercedes-Benz E-klasse AMG	от 2004
Mercedes-Benz G-klasse	от 2012
Mercedes-Benz G-klasse AMG	от 2012
Mercedes-Benz GLA-klasse	от 2013
Mercedes-Benz GLC	от 2015
Mercedes-Benz GLC Coupe	от 2016
Mercedes-Benz GLE	от 2015
Mercedes-Benz GLK-klasse	от 2008
Mercedes-Benz GL-klasse	от 2006
Mercedes-Benz GLS-klasse	от 2015
Mercedes-Benz Maybach S-klasse	от 2014
Mercedes-Benz M-klasse	от 2004
Mercedes-Benz M-klasse AMG	от 2004
Mercedes-Benz R-klasse	от 2012
Mercedes-Benz S-klasse	от 2004
Mercedes-Benz S-klasse AMG	от 2004
Mercedes-Benz SL-klasse	не допускается
Mercedes-Benz Viano	от 2012
Mercedes-Benz Vito	от 2012
Mercedes-Benz V-klasse	от 2012
MINI Countryman	от 2019
Mitsubishi Airtrek	от 2006
Mitsubishi ASX	от 2012
Mitsubishi Attrage	от 2014
Mitsubishi Carisma	не допускается
Mitsubishi Colt	не допускается
Mitsubishi Delica	от 2012
Mitsubishi Delica D:2	от 2012
Mitsubishi Diamante	от 2004
Mitsubishi Eclipse Cross	от 2017
Mitsubishi Galant	от 2006
Mitsubishi Grandis	не допускается
Mitsubishi Lancer	от 2012
Mitsubishi Lancer Cargo	не допускается
Mitsubishi Lancer Evolution	от 2012
Mitsubishi Legnum	не допускается
Mitsubishi Libero	не допускается
Mitsubishi Mirage	от 2019
Mitsubishi Montero	от 2012
Mitsubishi Montero Sport	от 2012
Mitsubishi Outlander	от 2006
Mitsubishi Pajero	от 2012
Mitsubishi Pajero Sport	от 2012
Mitsubishi RVR	от 2012
Mitsubishi Space Star	от 2019
Mobilize Limo	от 2022
Neta U Pro	от 2020
Neta V	от 2020
Nio EC6	от 2020
Nissan AD	от 2012
Nissan Almera	не допускается
Nissan Almera Classic	от 2012
Nissan Altima	от 2006
Nissan Armada	от 2012
Nissan Avenir	не допускается
Nissan Bluebird Sylphy	от 2012
Nissan Cefiro	от 2006
Nissan Cube	от 2012
Nissan Dualis	от 2012
Nissan Elgrand	от 2012
Nissan Expert	от 2006
Nissan Fuga	от 2004
Nissan Gloria	не допускается
Nissan Juke	от 2019
Nissan Lafesta	от 2012
Nissan Latio	от 2012
Nissan Laurel	не допускается
Nissan Leaf	от 2019
Nissan March	от 2019
Nissan Maxima	от 2006
Nissan Micra	от 2019
Nissan Murano	от 2004
Nissan Note	от 2019
Nissan Pathfinder	от 2004
Nissan Patrol	от 2012
Nissan Presea	не допускается
Nissan Primera	от 2006
Nissan Pulsar	от 2012
Nissan Qashqai	от 2012
Nissan Qashqai+2	от 2012
Nissan Quest	от 2012
Nissan R'nessa	не допускается
Nissan Rogue	от 2007
Nissan Safari	от 2012
Nissan Sentra	от 2012
Nissan Serena	от 2012
Nissan Skyline	от 2006
Nissan Sunny	от 2012
Nissan Teana	от 2006
Nissan Terrano	от 2019
Nissan Tiida	от 2012
Nissan Vanette	от 2012
Nissan Versa	от 2012
Nissan Wingroad	от 2012
Nissan X-Trail	от 2006
Omoda C5	от 2022
Omoda S5	от 2022
Opel Antara	от 2012
Opel Astra	от 2012
Opel Astra OPC	от 2012
Opel Combo	от 2012
Opel Corsa	от 2019
Opel Frontera	не допускается
Opel Insignia	от 2008
Opel Meriva	от 2012
Opel Mokka	от 2019
Opel Omega	от 2004
Opel Signum	от 2004
Opel Vectra	от 2006
Opel Vectra OPC	от 2006
Opel Vita	не допускается
Opel Vivaro	от 2012
Opel Zafira	от 2012
Opel Zafira OPC	не допускается
Peugeot 2008	от 2019
Peugeot 206	не допускается
Peugeot 207	не допускается
Peugeot 208	от 2019
Peugeot 3008	от 2012
Peugeot 301	от 2019
Peugeot 306	не допускается
Peugeot 307	не допускается
Peugeot 308	от 2012
Peugeot 4007	от 2007
Peugeot 4008	от 2012
Peugeot 405	от 2012
Peugeot 406	не допускается
Peugeot 407	от 2006
Peugeot 408	от 2012
Peugeot 5008	от 2012
Peugeot 508	от 2011
Peugeot 607	от 2004
Peugeot 807	от 2012
Peugeot Expert	от 2012
Peugeot Partner	от 2012
Peugeot Traveller	от 2016
Porsche Taycan	от 2019
Ravon Gentra	от 2015
Ravon Nexia R3	от 2019
Ravon R4	от 2019
Renault 19	не допускается
Renault Arkana	от 2019
Renault Clio	от 2019
Renault Clio RS	от 2019
Renault Dokker	от 2012
Renault Duster	от 2019
Renault Espace	от 2010
Renault Fluence	от 2012
Renault Kadjar	от 2015
Renault Kangoo	от 2012
Renault Kaptur	от 2019
Renault Koleos	от 2008
Renault Laguna	от 2006
Renault Latitude	от 2010
Renault Lodgy	от 2012
Renault Logan	от 2019
Renault Logan Stepway	от 2019
Renault Megane	от 2012
Renault Megane RS	от 2012
Renault Modus	от 2012
Renault Sandero	от 2019
Renault Sandero RS	от 2019
Renault Scenic	от 2012
Renault Symbol	не допускается
Renault Talisman	от 2015
Renault Trafic	от 2012
Renault Vel Satis	от 2004
Rover 45	не допускается
Saab 9-3	от 2006
SEAT Alhambra	от 2012
SEAT Altea	от 2012
SEAT Cordoba	не допускается
SEAT Ibiza	от 2019
SEAT Leon	от 2012
SEAT Toledo	от 2019
Skoda Fabia	от 2019
Skoda Karoq	от 2017
Skoda Kodiaq	от 2016
Skoda Octavia	от 2012
Skoda Octavia RS	от 2012
Skoda Rapid	от 2019
Skoda Roomster	от 2012
Skoda Superb	от 2006
Skoda Yeti	не допускается
Skywell ET5	от 2021
SsangYong Actyon	от 2012
SsangYong Kyron	от 2012
SsangYong Nomad	от 2013
SsangYong Rexton	от 2012
SsangYong Rodius	от 2012
SsangYong Stavic	от 2013
SsangYong Tivoli	от 2019
Subaru Forester	от 2006
Subaru Impreza	от 2012
Subaru Justy	от 2012
Subaru Legacy	от 2006
Subaru Outback	от 2006
Subaru Stella	от 2012
Subaru Trezia	не допускается
Subaru Tribeca	от 2004
Subaru XV	от 2012
Suzuki Aerio	не допускается
Suzuki Baleno	от 2012
Suzuki Escudo	от 2019
Suzuki Grand Vitara	от 2010
Suzuki Ignis	от 2019
Suzuki Kizashi	от 2009
Suzuki Liana	не допускается
Suzuki Solio	от 2012
Suzuki Swift	от 2019
Suzuki SX4	от 2019
Suzuki Vitara	от 2019
Suzuki XL7	от 2004
SWM G01	от 2019
Tesla Model 3	от 2017
Tesla Model S	от 2012
Tesla Model X	от 2015
Tesla Model Y	от 2020
Toyota 4Runner	от 2012
Toyota Allion	от 2006
Toyota Alphard	от 2012
Toyota Aqua	от 2019
Toyota Aurion	от 2006
Toyota Auris	от 2012
Toyota Avalon	от 2004
Toyota Avensis	от 2006
Toyota Belta	не допускается
Toyota Brevis	от 2006
Toyota Caldina	от 2006
Toyota Camry	от 2006
Toyota C-HR	от 2016
Toyota Corolla	от 2008
Toyota Corolla Axio	от 2008
Toyota Corolla Fielder	от 2012
Toyota Corolla Rumion	от 2012
Toyota Crown	от 2006
Toyota Crown Majesta	от 2004
Toyota Duet	не допускается
Toyota Echo	не допускается
Toyota Esquire	от 2014
Toyota Estima	от 2012
Toyota Fortuner	от 2012
Toyota Harrier	от 2006
Toyota HiAce	от 2012
Toyota Highlander	от 2004
Toyota Hilux Surf	не допускается
Toyota ISis	от 2012
Toyota Ist	не допускается
Toyota Kluger	от 2004
Toyota Land Cruiser	от 2004
Toyota Land Cruiser Prado	от 2004
Toyota LiteAce	от 2012
Toyota Mark X	от 2004
Toyota Matrix	от 2012
Toyota Noah	от 2012
Toyota Opa	не допускается
Toyota Platz	не допускается
Toyota Premio	от 2012
Toyota Previa	от 2012
Toyota Prius	от 2012
Toyota Prius Alpha	от 2012
Toyota Prius c	от 2012
Toyota Prius v (+)	от 2012
Toyota Probox	от 2012
Toyota Progres	от 2004
Toyota Ractis	от 2012
Toyota Raum	не допускается
Toyota RAV 4	от 2012
Toyota Rush	от 2019
Toyota Sai	от 2009
Toyota Sequoia	от 2012
Toyota Sienna	от 2012
Toyota Sienta	от 2012
Toyota Succeed	от 2012
Toyota TownAce	от 2012
Toyota Urban Cruiser	от 2012
Toyota Vanguard	от 2012
Toyota Venza	от 2008
Toyota Verso	от 2012
Toyota Vios	от 2012
Toyota Vitz	от 2019
Toyota Voltz	не допускается
Toyota Voxy	от 2012
Toyota Wish	от 2012
Toyota Yaris	от 2019
Venucia D60	от 2017
Venucia D60 EV	от 2017
Volkswagen Bora	от 2012
Volkswagen Caddy	от 2012
Volkswagen Caravelle	от 2012
Volkswagen e-Bora	от 2012
Volkswagen Golf	от 2012
Volkswagen Golf Plus	от 2012
Volkswagen ID.3	от 2019
Volkswagen ID.4	от 2020
Volkswagen ID.6	от 2021
Volkswagen Jetta	от 2012
Volkswagen Lavida	от 2012
Volkswagen Multivan	от 2012
Volkswagen Parati	от 2012
Volkswagen Passat	от 2006
Volkswagen Passat CC	от 2008
Volkswagen Phaeton	от 2004
Volkswagen Pointer	не допускается
Volkswagen Polo	от 2019
Volkswagen Polo GTI	от 2019
Volkswagen Sharan	от 2012
Volkswagen Teramont	от 2017
Volkswagen Tiguan	от 2007
Volkswagen Touareg	от 2004
Volkswagen Touran	от 2012
Volkswagen Transporter	от 2012
Volvo S40	от 2012
Volvo S60	от 2006
Volvo S60 Cross Country	от 2015
Volvo S70	не допускается
Volvo S80	от 2004
Volvo S90	от 2004
Volvo V40	от 2012
Volvo V50	от 2006
Volvo V60	от 2010
Volvo V60 Cross Country	от 2015
Volvo V70	от 2004
Volvo V90	от 2004
Volvo XC60	от 2008
Volvo XC70	от 2006
Volvo XC90	от 2004
Voyah Free	от 2021
Weltmeister E5	от 2021
Weltmeister EX5	от 2018
Xpeng G3	от 2018
Xpeng P5	от 2021
Xpeng P7	от 2020
Zotye T600	от 2013
Москвич 3	от 2022
BAIC EU260	не допускается
BAIC EU5	от 2018
BAIC EX5	от 2019
BYD Chazor	от 2022
BYD Dolphin	от 2021
BYD e2	от 2019
BYD E6	от 2018
BYD Han	от 2020
Changan Shenlan SL03	от 2022
Chery eQ5	от 2020
Chevrolet Bolt	не допускается
Chevrolet Bolt EUV	не допускается
Chevrolet Volt	от 2018
Everus VE-1	от 2018
FAW Bestune NAT	от 2021
GAC Aion S	от 2019
GAC Aion S Plus	от 2021
GAC GE3	от 2019
Geely Geometry C	от 2020
Honda e:NP1	от 2022
Honda e:NS1	от 2022
Hongqi E-HS9	от 2020
Hozon Neta U	от 2020
Hyundai IONIQ	от 2018
Hyundai IONIQ 5	от 2021
JAC iEV7S	не допускается
JAC iEVS4	от 2019
Kia EV6	от 2021
Kia Soul EV	от 2019
Livan 9	от 2022
Nio ES8	от 2018
Nissan Ariya	от 2020
Nissan Leaf	не допускается
Opel Ampera	не допускается
Renault Samsung SM3	от 2018
Renault ZOE	не допускается
Roewe Ei5	от 2018
Skoda Enyaq	от 2020
Skywell ET5	от 2021
Tesla Model 3	от 2017
Tesla Model S	от 2012
Tesla Model X	от 2015
Tesla Model Y	от 2020
Volkswagen ID.3	от 2019
Volkswagen ID.4	от 2020
Volkswagen ID.5	от 2021
Volkswagen ID.6	от 2021
Voyah Free	от 2021
Weltmeister EX5	от 2018
Weltmeister W6	от 2021
Xpeng G3	от 2018
Xpeng P7	от 2020
BYD Qin Plus	от 2018
BYD Song Plus	от 2020
BYD Yuan	от 2021
Audi A6	от 2010
BAIC EU5	от 2018
BAIC EX5	от 2019
Beijing EU7	от 2019
BMW X3	от 2012
Buick Velite 6	не допускается
BYD Chazor	от 2022
BYD Dolphin	от 2021
BYD E2	от 2019
BYD E3	не допускается
BYD F5	от 2018
BYD Han	от 2020
BYD Qin	от 2018
BYD Qin Plus	от 2018
BYD Qin Pro	от 2018
BYD Seagull	не допускается
BYD Song Plus	от 2020
BYD Tang	от 2015
BYD Yuan	от 2021
Changan Alsvin	не допускается
Changan Auchan A600 EV	не допускается
Changan CS35	не допускается
Changan CS55	от 2018
Changan CS75	от 2014
Changan Eado	от 2018
Changan Eado Plus	от 2020
Changan UNI-T	от 2020
ChangFeng Leopaard CS9	не допускается
Chery Arrizo 5	не допускается
Chery Arrizo 6 Pro	от 2023
Chery Arrizo 7	не допускается
Chery eQ5	от 2020
Chery eQ7	от 2023
Chery Tiggo (T11)	не допускается
Chery Tiggo 4 Pro	от 2020
Chery Tiggo 7	от 2018
Chery Tiggo 7 Plus	от 2021
Chery Tiggo 7 Pro	от 2020
Chery Tiggo 7 Pro Max	от 2022
Chery Tiggo 8 Pro	от 2021
Chery Tiggo 8 Pro Max	от 2022
Chevrolet Aveo	не допускается
Chevrolet Bolt	не допускается
Chevrolet Captiva	
от 2011

Chevrolet Cobalt	не допускается
Chevrolet Colorado	не допускается
Chevrolet Cruze	от 2018
Chevrolet Epica	не допускается
Chevrolet Equinox	от 2012
Chevrolet Impala	от 2010
Chevrolet Lacetti	не допускается
Chevrolet Malibu	от 2012
Chevrolet Menlo	от 2020
Chevrolet Monza	от 2018
Chevrolet Nexia	не допускается
Chevrolet Onix	не допускается
Chevrolet Optra	не допускается
Chevrolet Orlando	от 2018
Chevrolet Tracker	от 2021
Chevrolet TrailBlazer	не допускается
Chevrolet Traverse	от 2010
Daewoo Gentra	не допускается
Daewoo Magnus	не допускается
Daihatsu Boon	не допускается
DFSK Seres 3	от 2020
DongFeng 580	от 2017
DongFeng A30	от 2018
DongFeng A9	от 2016
DongFeng Aeolus E70	не допускается
DongFeng Aeolus Yixuan GS	от 2020
DongFeng E1	не допускается
DongFeng S50 EV	от 2018
DongFeng Shine	от 2019
DongFeng Shine Max	от 2023
DongFeng T5 EVO	от 2020
Enovate ME7	от 2020
Everus VE-1	не допускается
EXEED LX	от 2019
FAW Bestune B70	от 2020
FAW Bestune T55	от 2021
FAW Bestune T77	от 2018
FAW Besturn B70	от 2012
Ford Focus	от 2018
Ford Territory	от 2018
GAC Aion S	от 2019
GAC Aion V	от 2020
GAC Aion Y	не допускается
GAC GS5	от 2020
Geely Emgrand EC7	не допускается
Geely Emgrand GT	не допускается
Geely Geometry C	от 2020
Geely Geometry E	не допускается
Haval H6	от 2018
Haval Jolion	от 2021
Haval M6	от 2018
Honda Accord	от 2012
Honda Crider	от 2018
Honda CR-V	от 2018
Honda e:NP1	от 2022
Honda e:NS1	от 2022
Honda M-NV	не допускается
Honda Pilot	от 2010
Honda X-NV	не допускается
Hongqi E-HS3	от 2018
Hongqi E-QM5	от 2021
Hongqi H5	от 2017
Hongqi HS5	от 2019
Hycan A06	от 2022
Hyundai Accent	не допускается
Hyundai Avante	от 2018
Hyundai Creta	от 2018
Hyundai Elantra	от 2018
Hyundai Equus	от 2010
Hyundai Grand Starex	от 2018
Hyundai Grandeur	от 2010
Hyundai i30	от 2018
Hyundai i40	от 2012
Hyundai IONIQ	от 2018
Hyundai ix55	от 2010
Hyundai Mistra	от 2020
Hyundai Santa Fe	от 2012
Hyundai Solaris	не допускается
Hyundai Sonata	от 2012
Hyundai Tucson	от 2018
Infiniti FX	от 2010
JAC J7	от 2020
JAC S5 (Eagle)	не допускается
Jetour Dashing	от 2022
Jetour X70	от 2018
Jetour X70 PLUS	не допускается
Jetour X90 PLUS	от 2021
Jetour X95	от 2019
Jetour Х70	от 2018
Kaiyi E5	от 2021
Kaiyi X3 Pro	от 2022
Karry K60 EV	от 2018
Kia Carnival	от 2018
Kia Cerato	от 2018
Kia Forte	от 2018
Kia K3	от 2018
Kia K5	от 2012
Kia Mohave (Borrego)	от 2010
Kia Optima	от 2012
Kia Rio	не допускается
Kia Seltos	не допускается
Kia Sorento	от 2012
Kia Soul	не допускается
Kia Sportage	от 2018
LADA (ВАЗ) Granta	не допускается
LADA (ВАЗ) Largus	не допускается
LADA (ВАЗ) XRAY	не допускается
Land Rover Range Rover	от 2012
Land Rover Range Rover Sport	от 2012
Leapmotor C01	от 2022
Leapmotor C11	от 2021
Leapmotor T03	не допускается
Lexus GS	от 2010
Lexus LS	от 2010
Mazda 3	от 2018
Mazda 6	от 2012
Mazda Atenza	от 2012
Mercedes-Benz C-klasse	от 2012
Mercedes-Benz E-klasse	от 2010
Mercedes-Benz GLC	от 2015
Mercedes-Benz S-klasse	от 2010
Mitsubishi Airtrek	не допускается
Mitsubishi Lancer	не допускается
Mitsubishi Outlander	от 2012
Mobilize Limo	от 2022
Neta U Pro	от 2020
Neta V	не допускается
Nissan Almera Classic	не допускается
Nissan Altima	от 2012
Nissan Leaf	не допускается
Nissan Maxima	от 2012
Nissan Murano	от 2010
Nissan Sentra	от 2018
Nissan Sunny	не допускается
Nissan Teana	от 2012
Nissan Tiida	от 2018
Omoda C5	от 2022
Omoda S5	от 2022
Opel Omega	не допускается
Opel Zafira	не допускается
Ora iQ	не допускается
Ravon Gentra	не допускается
Ravon Nexia R3	не допускается
Ravon R4	не допускается
Renault Arkana	от 2019
Renault Duster	не допускается
Renault Kaptur	не допускается
Skoda Kodiaq	от 2016
Skoda Octavia	от 2018
Skoda Rapid	не допускается
Skywell ET5	от 2021
Skywell HT-i	от 2023
Soueast DX8S	от 2022
SsangYong Rexton	от 2018
Suda SA01	не допускается
SWM G01	от 2018
Tesla Model 3	от 2017
Tesla Model S	от 2012
Tesla Model Y	от 2020
Toyota Alphard	от 2018
Toyota Avalon	от 2010
Toyota Camry	от 2012
Toyota C-HR	не допускается
Toyota Corolla	от 2018
Toyota Land Cruiser Prado	
от 2012

Toyota Premio	не допускается
Toyota Prius	от 2018
Toyota Venza	от 2012
Toyota Vios	не допускается
Toyota Voxy	от 2018
Venucia D60	от 2018
Venucia D60 EV	от 2018
Volkswagen Bora	от 2018
Volkswagen Caddy	не допускается
Volkswagen e-Bora	от 2018
Volkswagen ID.3	от 2019
Volkswagen ID.4	от 2020
Volkswagen ID.6	от 2021
Volkswagen Lavida	от 2018
Volkswagen Passat	от 2012
Volkswagen Phaeton	от 2010
Volkswagen Teramont	от 2017
Voyah Free	от 2021
Weltmeister E5	от 2021
Weltmeister EX5	от 2018
Weltmeister W6	от 2021
Xpeng G3	от 2018
Xpeng P5	от 2021
Xpeng P7	от 2020
Zeekr 001	от 2021
Zeekr X	от 2023
Acura MDX	от 2019
Acura TLX	от 2021
Audi A4	от 2021
Audi A5	от 2021
Audi A6	от 2019
Audi A7	от 2019
Audi A8	от 2018
Audi Q5	от 2021
Audi Q7	от 2019
Audi S4	от 2021
Audi S8	от 2019
Beijing EU7	от 2021
BMW 318i	от 2021
BMW 3er	от 2021
BMW 5er	от 2019
BMW 7er	от 2015
BMW X3	от 2021
BMW X4	от 2021
BMW X5	от 2019
BMW X6	от 2019
BYD Chazor	от 2022
BYD Han	от 2020
BYD Seal	от 2022
BYD Song L	от 2023
BYD Song Plus	от 2021
BYD Song Pro	от 2021
BYD Tang	от 2021
Changan CS75	от 2021
Changan Shenlan S7	от 2023
Changan Shenlan SL03	от 2022
Chery eQ5	от 2021
Chery eQ7	от 2023
Chery Tiggo 8	от 2021
Chery Tiggo 8 Pro	от 2021
Chery Tiggo 8 Pro Max	от 2022
CheryExeed TXL	от 2021
CheryExeed VX	от 2021
Chevrolet Equinox	от 2021
Chevrolet Impala	от 2019
Chevrolet Malibu	от 2018
Chevrolet Traverse	от 2015
Chrysler 300C	от 2019
Denza X	от 2019
Dodge Journey	от 2019
DongFeng 580	от 2021
DongFeng A9	от 2019
DongFeng Aeolus Haoji	от 2022
DongFeng Shine Max	от 2023
Enovate ME7	от 2021
EXEED TXL	от 2021
EXEED VX	от 2021
FAW Bestune B70	от 2021
FAW Bestune T99	от 2021
Ford Mondeo	от 2021
Forthing Yacht	от 2022
GAC GS5	от 2021
Genesis G70	от 2021
Genesis G80	от 2019
Genesis GV80	от 2020
Haval Xiaolong Max	от 2023
Honda Accord	от 2021
Honda Avancier	от 2021
Honda Inspire	от 2021
Honda Legend	от 2021
Honda Pilot	от 2019
Hongqi E-HS9	от 2020
Hongqi E-QM5	от 2021
Hongqi H5	от 2021
Hongqi H9	от 2020
Hongqi HS5	от 2021
Hongqi HS7	от 2019
Hyundai Equus	от 2015
Hyundai Grandeur	от 2019
Hyundai Mistra	от 2021
Hyundai Santa Fe	от 2021
Hyundai Sonata	от 2021
Infiniti Q50	от 2021
Infiniti Q70	от 2019
Infiniti QX50	от 2021
Infiniti QX60	от 2019
Jaguar F-Pace	от 2021
Jaguar XE	от 2021
Jaguar XF	от 2019
Jaguar XJ	от 2015
Jetour X90	от 2021
Kia Cadenza	от 2019
Kia Carnival	от 2021
Kia K5	от 2021
Kia K7	от 2019
Kia K8	от 2021
Kia K9	от 2019
Kia K900	от 2015
Kia Mohave (Borrego)	от 2019
Kia Quoris	от 2015
Kia Sorento	от 2021
Kia Stinger	от 2021
Land Rover Discovery Sport	от 2021
Land Rover Range Rover Velar	от 2021
Leapmotor C01	от 2022
Leapmotor C10	от 2023
Leapmotor C11	от 2021
Lexus ES	от 2019
Lexus GS	от 2019
Lexus IS	от 2021
Lexus LS	от 2015
Lexus NX	от 2021
Lexus RX	от 2019
LiXiang L7	от 2023
LiXiang L9	от 2022
Mazda 6	от 2021
Mazda Atenza	от 2021
Mazda CX-9	от 2019
Mercedes-Benz C-klasse	от 2021
Mercedes-Benz C-klasse AMG	от 2021
Mercedes-Benz CLS-klasse	от 2019
Mercedes-Benz CLS-klasse AMG	от 2019
Mercedes-Benz E-klasse	от 2019
Mercedes-Benz E-klasse AMG	от 2019
Mercedes-Benz GLC	от 2021
Mercedes-Benz GLC Coupe	от 2021
Mercedes-Benz GLE	от 2019
Mercedes-Benz GL-klasse	от 2015
Mercedes-Benz GLS-klasse	от 2015
Mercedes-Benz Maybach S-klasse	от 2015
Mercedes-Benz S-klasse	от 2015
Mercedes-Benz S-klasse AMG	от 2015
Mitsubishi Outlander	от 2021
Mobilize Limo	от 2022
Neta S	от 2022
Nissan Altima	от 2021
Nissan Fuga	от 2019
Nissan Maxima	от 2021
Nissan Murano	от 2019
Nissan Rogue	от 2021
Nissan Skyline	от 2021
Nissan X-Trail	от 2021
Opel Insignia	от 2021
Peugeot 508	от 2021
Porsche Taycan	от 2019
Qiyuan A07	от 2023
Renault Koleos	от 2021
Renault Talisman	от 2021
Skoda Kodiaq	от 2021
Skoda Superb	от 2021
Skywell ET5	от 2021
Skywell HT-i	от 2023
Skyworth EV6	от 2021
Soueast DX8S	от 2022
Subaru Outback	от 2021
Tesla Model 3	от 2021
Tesla Model S	от 2015
Tesla Model X	от 2019
Tesla Model Y	от 2021
Toyota Avalon	от 2019
Toyota Camry	от 2021
Toyota Crown Majesta	от 2015
Toyota Harrier	от 2021
Toyota Highlander	от 2019
Toyota Mark X	от 2019
Toyota Venza	от 2021
Volkswagen ID.6	от 2021
Volkswagen Passat	от 2021
Volkswagen Passat CC	от 2021
Volkswagen Phaeton	от 2015
Volkswagen Teramont	от 2019
Volkswagen Touareg	от 2019
Volvo S60	от 2021
Volvo S90	от 2019
Volvo V60	от 2021
Volvo V60 Cross Country	от 2021
Volvo V90	от 2019
Volvo XC60	от 2021
Volvo XC90	от 2019
Voyah Free	от 2021
Weltmeister W6	от 2021
Wuling Xingguang	от 2023
Xpeng P5	от 2021
Xpeng P7	от 2021
Zeekr 001	от 2021
Zeekr 007	от 2023
Zeekr 009	от 2022
Zotye T600	от 2021
Audi A8	от 2018
BMW 7er	от 2019
BYD Han	от 2020
Genesis G80	от 2021
Genesis GV80	от 2020
Hongqi E-HS9	от 2020
Hongqi E-QM5	не допускается (кроме машин 2024-2025 годов, которые были зарегистрированы* в сервисе не позднее 6 мая 2025)
Hongqi H5	от 2022
Hongqi H9	от 2020
Hyundai Grandeur	от 2023
Kia K8	от 2021
Kia K9	от 2019
Leapmotor C01	от 2022
Leapmotor C16	от 2024
LiXiang L7	от 2023
LiXiang L8	от 2022
LiXiang L9	от 2022
Mercedes-Benz Maybach S-klasse	от 2017
Mercedes-Benz S-klasse	от 2017
Mercedes-Benz S-klasse AMG	от 2017
Yipai 008	от 2024
Zeekr 001	от 2021
Zeekr 007	от 2023
Zeekr 009	от 2022
`.trim();

const parsedModelLabels = CAR_MODELS_SOURCE
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !/не допускается/i.test(line))
  .map((line) => {
    const cleaned = line.replace(/\s{2,}/g, "\t");
    return cleaned.split("\t")[0].trim();
  });

const CAR_MODEL_LABELS = Array.from(
  new Set([...EXTRA_POPULAR_MODELS, ...parsedModelLabels])
);

const CAR_MODELS = CAR_MODEL_LABELS.map((label) => ({
  code: makeCarCode(label),
  label,
}));

// ВАЖНО: этот список цветов должен соответствовать цветам,
// указанным в классификаторе Яндекс (auto-list).
// При необходимости обнови labels/коды вручную под официальный список.
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
  { code: "PURPLE", label: "Binafsha" }
];

const CAR_MODELS_PAGE_SIZE = 40;

function buildCarModelsKeyboard(page = 0) {
  const total = CAR_MODELS.length;
  const pageSize = CAR_MODELS_PAGE_SIZE;
  const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  const safePage = Math.min(Math.max(0, page), maxPage);

  const start = safePage * pageSize;
  const end = Math.min(start + pageSize, total);
  const slice = CAR_MODELS.slice(start, end);

  const rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    const row = [];
    const m1 = slice[i];
    row.push({ text: m1.label, callback_data: `car_model:${m1.code}` });
    if (i + 1 < slice.length) {
      const m2 = slice[i + 1];
      row.push({ text: m2.label, callback_data: `car_model:${m2.code}` });
    }
    rows.push(row);
  }

  const navRow = [];
  if (safePage > 0) {
    navRow.push({ text: "⬅️ Oldingi", callback_data: `car_page:${safePage - 1}` });
  }
  if (safePage < maxPage) {
    navRow.push({ text: "Keyingi ➡️", callback_data: `car_page:${safePage + 1}` });
  }
  if (navRow.length) rows.push(navRow);

  return { inline_keyboard: rows };
}

function buildCarColorsKeyboard() {
  const rows = [];
  for (let i = 0; i < CAR_COLORS.length; i += 2) {
    const row = [];
    const c1 = CAR_COLORS[i];
    row.push({ text: c1.label, callback_data: `car_color:${c1.code}` });
    if (i + 1 < CAR_COLORS.length) {
      const c2 = CAR_COLORS[i + 1];
      row.push({ text: c2.label, callback_data: `car_color:${c2.code}` });
    }
    rows.push(row);
  }
  return { inline_keyboard: rows };
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

async function editReplyMarkup(chatId, messageId, replyMarkup) {
  if (!TELEGRAM_API || !chatId || !messageId) return;
  try {
    const res = await fetch(`${TELEGRAM_API}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: replyMarkup,
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error("editMessageReplyMarkup error:", res.status, txt);
    }
  } catch (e) {
    console.error("editReplyMarkup exception:", e);
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

// ===== отправка альбома документов операторам =====

function humanDocTitle(docType) {
  if (docType === "vu_front") return "Водительское удостоверение (лицевая)";
  if (docType === "tech_front") return "Техпаспорт (лицевая)";
  if (docType === "tech_back") return "Техпаспорт (оборотная)";
  return "Документ";
}

/**
 * Аккуратная сводка для ОПЕРАТОРОВ (на русском).
 * Нормальная нумерация, читабельные блоки, полные номера (серия + номер).
 */
function formatSummaryForOperators(docs, commonMeta = {}) {
  const { phone, tg_id, carModel, carColor } = commonMeta;

  const vu = docs.find((d) => d.docType === "vu_front");
  const tFront = docs.find((d) => d.docType === "tech_front");
  const tBack = docs.find((d) => d.docType === "tech_back");

  const fVu = (vu && vu.result && vu.result.parsed && vu.result.parsed.fields) || {};
  const fTf =
    (tFront && tFront.result && tFront.result.parsed && tFront.result.parsed.fields) ||
    {};
  const fTb =
    (tBack && tBack.result && tBack.result.parsed && tBack.result.parsed.fields) || {};

  // ФИО
  let fam = "";
  let name = "";
  let otch = "";
  if (fVu.driver_name) {
    const parts = String(fVu.driver_name).trim().split(/\s+/);
    fam = parts[0] || "";
    name = parts[1] || "";
    otch = parts.slice(2).join(" ");
  }

  // Полные номера ВУ и техпаспорта
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

  const carYear = fTb.car_year || null;

  const headerParts = [];
  if (phone) headerParts.push(`📞 Телефон: \`${phone}\``);
  if (tg_id) headerParts.push(`💬 Chat ID: \`${tg_id}\``);

  if (carModel || carColor || carYear) {
    const carBits = [];
    if (carModel) carBits.push(`модель: ${carModel}`);
    if (carColor) carBits.push(`цвет: ${carColor}`);
    if (carYear) carBits.push(`год: ${carYear}`);
    headerParts.push(`🚗 Авто (из формы/документов): ${carBits.join(" / ") || "—"}`);
  }

  const lines = [];
  lines.push("📄 Набор документов от водителя ASR TAXI");
  if (headerParts.length) {
    lines.push(headerParts.join("\n"));
  }

  // ===== БЛОК "ВОДИТЕЛЬ" =====
  lines.push("");
  lines.push("👤 ВОДИТЕЛЬ");
  lines.push("");
  lines.push("1. Фамилия");
  lines.push(fam || "—");
  lines.push("");
  lines.push("2. Имя");
  lines.push(name || "—");
  lines.push("");
  lines.push("3. Отчество");
  lines.push(otch || "—");
  lines.push("");
  lines.push("4. Дата рождения");
  lines.push(fVu.birth_date || "—");
  lines.push("");
  lines.push("5. Серия и номер водительского удостоверения");
  lines.push(licenseFull);
  lines.push("");
  lines.push("6. Дата выдачи ВУ");
  lines.push(fVu.issued_date || "—");
  lines.push("");
  lines.push("7. Дата окончания срока ВУ");
  lines.push(fVu.expiry_date || "—");
  lines.push("");
  lines.push("8. Кем выдано");
  lines.push(fVu.issued_by || "—");
  lines.push("");
  lines.push("9. ПИНФЛ (если есть)");
  lines.push(fTf.pinfl || "—");

  // ===== БЛОК "АВТОМОБИЛЬ" =====
  lines.push("");
  lines.push("🚗 АВТОМОБИЛЬ");
  lines.push("");
  lines.push("1. Госномер");
  lines.push(fTf.plate_number || "—");
  lines.push("");
  lines.push("2. Марка / модель по документу");
  lines.push(fTf.car_model_text || "—");
  lines.push("");
  lines.push("3. Модель (из формы бота)");
  lines.push(carModel || "—");
  lines.push("");
  lines.push("4. Цвет (по документу или форме)");
  lines.push(fTf.car_color_text || carColor || "—");
  lines.push("");
  lines.push("5. Год выпуска");
  lines.push(fTb.car_year || "—");
  lines.push("");
  lines.push("6. Номер кузова / шасси");
  lines.push(fTb.body_number || "—");
  lines.push("");
  lines.push("7. Серия и номер техпаспорта");
  lines.push(techFull);
  lines.push("");
  lines.push("8. Объём двигателя");
  lines.push(fTb.engine_volume || "—");
  lines.push("");
  lines.push("9. Тип топлива");
  lines.push(fTb.fuel_type || "—");
  lines.push("");
  lines.push("10. VIN (если указан отдельно)");
  lines.push(fTb.vin || "—");

  return lines.join("\n");
}

/**
 * Сводка для ВОДИТЕЛЯ (на узбекском, с нормальным форматированием).
 * Тоже использует полные номера (серия + номер).
 */
function formatSummaryForDriverUz(docs, commonMeta = {}) {
  const { carModel, carColor } = commonMeta;

  const vu = docs.find((d) => d.docType === "vu_front");
  const tFront = docs.find((d) => d.docType === "tech_front");
  const tBack = docs.find((d) => d.docType === "tech_back");

  const fVu = (vu && vu.result && vu.result.parsed && vu.result.parsed.fields) || {};
  const fTf =
    (tFront && tFront.result && tFront.result.parsed && tFront.result.parsed.fields) ||
    {};
  const fTb =
    (tBack && tBack.result && tBack.result.parsed && tBack.result.parsed.fields) || {};

  // FIO
  let fam = "";
  let name = "";
  let otch = "";
  if (fVu.driver_name) {
    const parts = String(fVu.driver_name).trim().split(/\s+/);
    fam = parts[0] || "";
    name = parts[1] || "";
    otch = parts.slice(2).join(" ");
  }

  // Полные номера
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

  return lines.join("\n");
}

async function sendDocsToOperators(chatId, session) {
  // теперь отправляем полный комплект и в ADMIN_CHAT_IDS, и в LOG_CHAT_ID
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
  };

  const summaryText = formatSummaryForOperators(docs, commonMeta);

  // альбом с фото: используем file_id (без перезалива)
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

// ===== upload-doc =====

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
        previewOnly: true, // ВАЖНО: сейчас только распознаём, операторам не шлём
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
    // попытка разбить ФИО
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

  // дополнительно из сессии
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

// helpers для редактирования

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

// ===== логика шагов регистрации =====

async function handleStart(chatId) {
  const text =
    "👋 Assalomu alaykum!\n\n" +
    "Ushbu bot sizga ASR TAXI parkiga ulanish uchun kerak bo‘lgan hujjatlarni to‘plashda yordam beradi.\n\n" +
    "Boshlash uchun tugmani bosing:";
  await sendTelegramMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "🚕 Ro‘yxatdan o‘tishni boshlash",
            callback_data: "start_registration",
          },
        ],
      ],
    },
  });
}

async function askPhone(chatId, session) {
  session.step = "waiting_phone";
  const text =
    "📱 Telefon raqamingizni yuboring.\n\n" +
    "Eng oson yo‘l — *kontakt* sifatida yuborish (\"Kontaktni ulashish\" tugmasi orqali).";
  await sendTelegramMessage(chatId, text, {
    reply_markup: {
      keyboard: [
        [
          {
            text: "📲 Telefonni jo‘natish",
            request_contact: true,
          },
        ],
      ],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
    parse_mode: "Markdown",
  });
}

async function askCarModel(chatId, session) {
  session.step = "waiting_car_model";
  const text =
    "Endi avtomobil modelini tanlaymiz.\n\n" +
    "Ro‘yxatdan kerakli modelni tanlang. Agar darhol ko‘rinmasa, sahifalarni o‘zgartiring:";
  await sendTelegramMessage(chatId, text, {
    reply_markup: buildCarModelsKeyboard(0),
    parse_mode: "Markdown",
  });
}

async function askCarColor(chatId, session) {
  session.step = "waiting_car_color";
  const text =
    "🎨 Avtomobil rangini tanlang.\n\n" +
    "Quyidagi tugmalardan foydalaning yoki kerak bo‘lsa rangni matn bilan yuborishingiz mumkin.";
  await sendTelegramMessage(chatId, text, {
    reply_markup: buildCarColorsKeyboard(),
    parse_mode: "Markdown",
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
    // всё отредактировали — снова показываем полный список
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

// ====== Проверка статуса через Yandex Fleet API ======

async function checkYandexStatus(phone) {
  if (!FLEET_API_URL || !FLEET_API_KEY || !FLEET_CLIENT_ID || !FLEET_PARK_ID) {
    return {
      ok: false,
      status: "unknown",
      message:
        "Yandex Fleet (park) bilan integratsiya sozlanmagan (FLEET_API_URL / FLEET_API_KEY / FLEET_CLIENT_ID / FLEET_PARK_ID).",
    };
  }

  try {
    // ⚠️ Здесь нужно подставить реальный endpoint и формат запроса по документации Fleet API
    const res = await fetch(FLEET_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-ID": FLEET_CLIENT_ID,
        "X-API-Key": FLEET_API_KEY,
      },
      body: JSON.stringify({
        phone,
        park_id: FLEET_PARK_ID,
      }),
    });

    const json = await res.json().catch(() => null);

    if (!res.ok) {
      return {
        ok: false,
        status: "error",
        message: `Yandex Fleet API xatosi: ${res.status}`,
        raw: json,
      };
    }

    // тут нужно адаптировать под реальный ответ Яндекс/Fleet API
    // примеры:
    //  - status: "active" | "onboarding" | "blocked"
    //  - либо флаг registered: true/false
    const registered = Boolean(
      json && (json.registered || json.status === "active")
    );

    return {
      ok: true,
      status: registered ? "registered" : "pending",
      raw: json,
    };
  } catch (e) {
    return {
      ok: false,
      status: "error",
      message: String(e),
    };
  }
}

async function handleStatusCheck(chatId, session) {
  const phone = session.phone || (session.data && session.data.phone);
  if (!phone) {
    await sendTelegramMessage(
      chatId,
      "Arizangiz bo‘yicha telefon raqami topilmadi. Iltimos, ro‘yxatdan o‘tish jarayonini qaytadan boshlang."
    );
    return;
  }

  await sendTelegramMessage(
    chatId,
    "⏳ Yandex tizimida ro‘yxatdan o‘tish holatini tekshiryapman..."
  );

  const res = await checkYandexStatus(phone);

  if (!res.ok) {
    await sendTelegramMessage(
      chatId,
      `Ro‘yxatdan o‘tish holatini olish imkoni bo‘lmadi.\n${res.message || ""}`
    );
    return;
  }

  if (res.status === "registered") {
    cancelStatusReminders(chatId);
    await sendTelegramMessage(
      chatId,
      "✅ Yandex Taxi tizimidagi ro‘yxatingiz *tasdiqlandi*.\n" +
        "Endi ishlashni boshlashingiz mumkin. Yo‘llarda omad tilaymiz! 🚕",
      { parse_mode: "Markdown" }
    );
  } else {
    await sendTelegramMessage(
      chatId,
      "Hozircha sizning ro‘yxatdan o‘tishingiz *hali yakunlanmagan*.\n" +
        "Biroz vaqt o‘tgach yana qayta tekshirib ko‘ring.",
      { parse_mode: "Markdown" }
    );
  }
}

// ====== обработка фото документов ======

async function handleDocumentPhoto(update, session, docType) {
  const msg =
    update.message ||
    update.edited_message ||
    update.channel_post ||
    update.edited_channel_post;

  const chatId = msg.chat.id;

  // вытащим file_id для альбома
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
      "Ma'lumotlarni to‘g‘ri o‘qishning imkoni bo‘lmadi. Iltimos, hujjatni yorug‘ joyda, ravshan va xirasiz suratга olib, qayta yuboring."
    );
    return;
  }

  const fields = parsedDoc.result.parsed.fields || {};

  // сохраняем в сессию
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
    await askDocTechFront(chatId, session);
  } else if (docType === "tech_front") {
    await askDocTechBack(chatId, session);
  } else if (docType === "tech_back") {
    // все три документа собраны — запускаем подтверждение
    await sendTelegramMessage(
      chatId,
      "✅ Barcha kerakli hujjatlar qabul qilindi. Endi sizga yig‘ilgan ma'lumotlarni tekshirish uchun yuboraman."
    );
    await startFirstConfirmation(chatId, session);
  }
}

// ====== handler ======
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
    const messageId = cq.message?.message_id;

    if (!chatId) {
      await answerCallbackQuery(cq.id);
      return { statusCode: 200, body: "OK" };
    }

    const session = getSession(chatId);

    // пагинация моделей
    if (data.startsWith("car_page:")) {
      const page = parseInt(data.split(":")[1], 10) || 0;
      const kb = buildCarModelsKeyboard(page);
      await editReplyMarkup(chatId, messageId, kb);
      await answerCallbackQuery(cq.id);
      return { statusCode: 200, body: "OK" };
    }

    // выбор модели
    if (data.startsWith("car_model:")) {
      const code = data.split(":")[1];
      const model = CAR_MODELS.find((m) => m.code === code);
      if (model) {
        session.carModelCode = model.code;
        session.carModelLabel = model.label;
        await sendTelegramMessage(
          chatId,
          `🚗 Siz tanlagan model: *${model.label}*`,
          { parse_mode: "Markdown" }
        );
        await askCarColor(chatId, session);
      } else {
        await sendTelegramMessage(
          chatId,
          "Bu model topilmadi. Iltimos, qaytadan tanlab ko‘ring."
        );
      }
      await answerCallbackQuery(cq.id);
      return { statusCode: 200, body: "OK" };
    }

    // выбор цвета
    if (data.startsWith("car_color:")) {
      const code = data.split(":")[1];
      const color = CAR_COLORS.find((c) => c.code === code);
      if (color) {
        session.carColor = color.label;
        session.data = session.data || {};
        session.data.carColor = session.carColor;
        await sendTelegramMessage(
          chatId,
          `🎨 Rang tanlandi: *${session.carColor}*`,
          { parse_mode: "Markdown" }
        );
        await askDocVuFront(chatId, session);
      } else {
        await sendTelegramMessage(
          chatId,
          "Bu rang topilmadi. Iltimos, qaytadan tanlab ko‘ring."
        );
      }
      await answerCallbackQuery(cq.id);
      return { statusCode: 200, body: "OK" };
    }

    // старт регистрации
    if (data === "start_registration") {
      resetSession(chatId);
      const s = getSession(chatId);
      await sendTelegramMessage(
        chatId,
        "Ajoyib, ro‘yxatdan o‘tishni boshlaymiz. Avval telefon raqamingizni tasdiqlaymiz."
      );
      await askPhone(chatId, s);
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

      await sendDocsToOperators(chatId, session);

      await sendTelegramMessage(
        chatId,
        "✅ Arizangiz va hujjatlaringiz operatorlarga tekshirish uchun yuborildi.\n\n" +
          "Bir necha daqiqadan so‘ng ro‘yxatdan o‘tish holatini tekshirishingiz mumkin.",
        {
          reply_markup: {
            keyboard: [[{ text: "🔄 Ro‘yxatdan o‘tish holatini tekshirish" }]],
            resize_keyboard: true,
          },
        }
      );

      // Запускаем напоминания (5/10/15 минут)
      scheduleStatusReminders(chatId);

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

    // статус
    if (data === "check_status") {
      await handleStatusCheck(chatId, session);
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
  const session = getSession(chatId);

  // /start
  if (text === "/start") {
    resetSession(chatId);
    await handleStart(chatId);
    return { statusCode: 200, body: "OK" };
  }

  // кнопка "Проверить статус регистрации" (узбек + старый русский вариант)
  if (
    text === "🔄 Ro‘yxatdan o‘tish holatini tekshirish" ||
    text === "🔄 Проверить статус регистрации" ||
    text.toLowerCase().includes("status")
  ) {
    await handleStatusCheck(chatId, session);
    return { statusCode: 200, body: "OK" };
  }

  // контакт (номер телефона)
  if (msg.contact && session.step === "waiting_phone") {
    const phone = msg.contact.phone_number;
    session.phone = phone;
    session.data.phone = phone;
    await sendTelegramMessage(
      chatId,
      `📞 Telefon qabul qilindi: *${phone}*`,
      { parse_mode: "Markdown" }
    );
    await askCarModel(chatId, session);
    return { statusCode: 200, body: "OK" };
  }

  // если ждём телефон, а пришёл текст
  if (session.step === "waiting_phone" && text) {
    const phone = text.trim();
    session.phone = phone;
    session.data.phone = phone;
    await sendTelegramMessage(
      chatId,
      `📞 Telefon qabul qilindi: *${phone}*`,
      { parse_mode: "Markdown" }
    );
    await askCarModel(chatId, session);
    return { statusCode: 200, body: "OK" };
  }

  // выбор цвета (текстом, как запасной вариант)
  if (session.step === "waiting_car_color" && text) {
    session.carColor = text.trim();
    session.data.carColor = session.carColor;
    await sendTelegramMessage(
      chatId,
      `🎨 Rang qabul qilindi: *${session.carColor}*`,
      { parse_mode: "Markdown" }
    );
    await askDocVuFront(chatId, session);
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
    await handleStart(chatId);
    return { statusCode: 200, body: "OK" };
  }

  // подсказки по шагам
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
  }

  return { statusCode: 200, body: "OK" };
};