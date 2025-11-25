// netlify/functions/telegram-asr-bot.js

const TELEGRAM_TOKEN = process.env.TG_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || null;

const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || process.env.ADMIN_CHAT_ID || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const LOG_CHAT_ID = process.env.LOG_CHAT_ID || null;

// URL сайта (Netlify подставляет URL / DEPLOY_URL)
const SITE_URL = process.env.URL || process.env.DEPLOY_URL || "";

// Эндпоинт функции upload-doc (используем для обработки документов из Telegram)
const UPLOAD_DOC_ENDPOINT =
  process.env.UPLOAD_DOC_ENDPOINT ||
  (SITE_URL ? `${SITE_URL}/.netlify/functions/upload-doc` : null);

// ====== НАСТРОЙКИ ЯНДЕКС ФЛИТ API ======
const FLEET_API_URL =
  process.env.FLEET_API_URL || "https://fleet-api.taxi.yandex.net";
const FLEET_CLIENT_ID = process.env.FLEET_CLIENT_ID || "";
const FLEET_API_KEY = process.env.FLEET_API_KEY || "";
const FLEET_PARK_ID = process.env.FLEET_PARK_ID || "";

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

if (!TELEGRAM_TOKEN) console.error("TG_BOT_TOKEN is not set");

// ===== СПИСОК МОДЕЛЕЙ И РАНГ ЦВЕТОВ (КНОПКИ) =====

// Генерация "кода" модели для callback_data (только латиница/цифры, до 60 символов)
function makeCarCode(label) {
  return label
    .normalize("NFKD")
    .replace(/[^\w\s]/g, " ")      // всё, кроме букв/цифр/пробелов -> пробел
    .replace(/[\u0400-\u04FF]+/g, "") // выбросить кириллицу из кода
    .toUpperCase()
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60);
}

// Дополнительно руками фиксируем самые популярные локальные варианты,
// чтобы точно не потерять Nexia 3 и т.п.
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

// Разбираем список:
// 1) убираем пустые строки
// 2) выбрасываем "не допускается"
// 3) берём только название модели (то, что до таба/двойных пробелов)
const parsedModelLabels = CAR_MODELS_SOURCE
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !/не допускается/i.test(line))
  .map((line) => {
    // иногда разделитель — таб, иногда несколько пробелов
    const cleaned = line.replace(/\s{2,}/g, "\t");
    return cleaned.split("\t")[0].trim();
  });

// Объединяем «популярные» и распарсенный список, убираем дубли
const CAR_MODEL_LABELS = Array.from(
  new Set([...EXTRA_POPULAR_MODELS, ...parsedModelLabels])
);

// Финальный массив, который использует бот
const CAR_MODELS = CAR_MODEL_LABELS.map((label) => ({
  code: makeCarCode(label),
  label,
}));

const CAR_COLORS = [
  { code: "YELLOW", label: "Sariq" },
  { code: "WHITE", label: "Oq" },
  { code: "BLACK", label: "Qora" },
  { code: "GRAY", label: "Kulrang" },
  { code: "RED", label: "Qizil" },
  { code: "BLUE", label: "Ko'k" },
  { code: "NAVY", label: "Moviy" },
  { code: "BROWN", label: "Jigarrang" },
  { code: "GREEN", label: "Yashil" },
  { code: "PINK", label: "Pushti" },
  { code: "DARK_ORANGE", label: "To'q sariq" },
  { code: "INDIGO", label: "Siyohrang" },
  { code: "BEIGE", label: "Bej" },
  { code: "OTHER", label: "Boshqa rang" },
];


// ===== ПРОСТАЯ IN-MEMORY СЕССИЯ (на каждый chat_id) =====
// Важно: на Netlify это не персистентно между холодными стартами, но логика тут показана целиком.
const sessions = new Map(); // key: chatId string -> { step, data, ... }

function getSession(chatId) {
  const key = String(chatId);
  let s = sessions.get(key);
  if (!s) {
    s = {
      step: "idle",
      data: {
        // phoneNormalized, carModelCode, carModelLabel, carColorCode, carColorLabel, fields, etc.
      },
      editQueue: [],
      editIndex: 0,
      currentField: null,
      lastUpdated: Date.now(),
    };
    sessions.set(key, s);
  }
  return s;
}

function resetSession(chatId) {
  sessions.delete(String(chatId));
}

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ TELEGRAM =====

async function sendTelegramMessage(chatId, text, replyMarkup) {
  if (!chatId) return;

  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("Telegram sendMessage error:", res.status, errText);
    }
  } catch (e) {
    console.error("Telegram sendMessage exception:", e);
  }
}

async function sendLog(text) {
  if (!LOG_CHAT_ID) return;
  return sendTelegramMessage(LOG_CHAT_ID, text);
}

// ===== ПРОКСИ В upload-doc ДЛЯ ОБРАБОТКИ ДОКУМЕНТОВ =====

async function forwardDocToUploadDoc(rawUpdate, extraMeta) {
  if (!UPLOAD_DOC_ENDPOINT) {
    console.error(
      "UPLOAD_DOC_ENDPOINT yoki URL aniqlanmagan — upload-doc funksiyasiga murojaat qilib bo‘lmadi"
    );
    return { ok: false, error: "no_upload_doc_url" };
  }

  try {
    const body = {
      source: "telegram_bot",
      telegram_update: rawUpdate,
    };

    if (extraMeta) {
      body.meta = extraMeta; // doc_type, chat_id, current_step va h.k.
    }

    const res = await fetch(UPLOAD_DOC_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // ВАЖНО: сюда передаём весь Telegram update, upload-doc.js сам разберёт
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("upload-doc error:", res.status, errText);
      return { ok: false, error: "bad_status", status: res.status, body: errText };
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    return { ok: true, data };
  } catch (e) {
    console.error("forwardDocToUploadDoc exception:", e);
    return { ok: false, error: "exception" };
  }
}

// ===== ПРОВЕРКА ВОДИТЕЛЯ В ЯНДЕКС ФЛИТ =====

function normalizePhone(raw) {
  if (!raw) return "";
  let digits = raw.replace(/[^\d]/g, "");

  if (digits.length === 11 && digits[0] === "8") {
    digits = "7" + digits.slice(1);
  }
  if (digits.length === 11 && digits[0] === "7") {
    return `+${digits}`;
  }
  if (raw.startsWith("+")) return raw;
  return `+${digits}`;
}

async function checkDriverInFleet(phone) {
  if (!FLEET_API_KEY || !FLEET_PARK_ID || !FLEET_CLIENT_ID) {
    console.warn(
      "FLEET_API_KEY, FLEET_CLIENT_ID yoki FLEET_PARK_ID belgilanmagan — haydovchini bazadan izlay olmaymiz"
    );
    return { exists: false, profile: null, raw: null };
  }

  const normalized = normalizePhone(phone);
  console.log("checkDriverInFleet → normalized phone:", normalized);

  try {
    const res = await fetch(`${FLEET_API_URL}/v1/parks/driver-profiles/list`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-ID": FLEET_CLIENT_ID,
        "X-API-Key": FLEET_API_KEY,
      },
      body: JSON.stringify({
        query: {
          park: { id: FLEET_PARK_ID },
          driver_profile: {
            phone: { value: normalized },
          },
        },
        limit: 50,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("Fleet API error:", res.status, errText);
      return { exists: false, profile: null, error: "fleet_error" };
    }

    const data = await res.json();
    const profiles = Array.isArray(data.driver_profiles)
      ? data.driver_profiles
      : [];

    let foundProfile = null;

    for (const p of profiles) {
      const apiPhones = (p.driver_profile?.phones || []).map(normalizePhone);
      if (apiPhones.includes(normalized)) {
        foundProfile = p;
        break;
      }
    }

    const exists = !!foundProfile;

    console.log(
      "Fleet API OK, exists =",
      exists,
      "profiles_count =",
      profiles.length
    );
    if (foundProfile) {
      console.log(
        "Fleet API raw driver_profile for phone:",
        JSON.stringify(foundProfile, null, 2)
      );
    }

    await sendLog(
      `🔍 Yandex.Fleet tekshiruvi\n` +
        `Telefon: <b>${normalized}</b>\n` +
        `Bazadan topildi: <b>${exists ? "HA" : "YO'Q"}</b>` +
        (foundProfile
          ? `\nIsm: <b>${foundProfile.driver_profile?.last_name || ""} ${
              foundProfile.driver_profile?.first_name || ""
            }</b>\n` +
            `Avto: <b>${foundProfile.car?.brand || "—"} ${
              foundProfile.car?.model || "—"
            }</b> (${foundProfile.car?.number || "—"})`
          : "")
    );

    return { exists, profile: foundProfile, raw: data };
  } catch (e) {
    console.error("Fleet API exception:", e);
    return { exists: false, profile: null, error: "fleet_exception" };
  }
}

// ===== КНОПКА "ПРОВЕРИТЬ СТАТУС РЕГИСТРАЦИИ" =====

async function handleStatusCheck(chatId) {
  const session = getSession(chatId);
  const phone =
    session.data?.phoneNormalized ||
    session.data?.phone ||
    session.data?.contactPhone ||
    null;

  if (!phone) {
    await sendTelegramMessage(
      chatId,
      "Telefon raqamingiz ma'lum emas.\nIltimos, /start buyrug'ini yuboring va qayta ro'yxatdan o'tish jarayonini boshlang."
    );
    return;
  }

  await sendTelegramMessage(
    chatId,
    "Ro'yxatdan o'tish holatini tekshiryapman, iltimos biroz kuting..."
  );

  const check = await checkDriverInFleet(phone);

  if (check.error === "fleet_error" || check.error === "fleet_exception") {
    await sendTelegramMessage(
      chatId,
      "Yandex.Taxi bazasiga hozircha ulanib bo'lmadi. Iltimos, birozdan so'ng yana tekshirib ko'ring."
    );
    return;
  }

  if (check.exists) {
    const p = check.profile || {};
    const dp = p.driver_profile || {};
    const car = p.car || {};

    await sendTelegramMessage(
      chatId,
      `✅ Tabriklaymiz! Sizning profilingiz Yandex.Taxi bazasida topildi.\n\n` +
        `F.I.Sh.: <b>${dp.last_name || ""} ${dp.first_name || ""}</b>\n` +
        (car.brand || car.model || car.number
          ? `Avto: <b>${car.brand || "—"} ${car.model || "—"}</b> (${car.number || "—"})\n`
          : "") +
        `Holat: <code>${p.current_status?.status || "unknown"}</code>`
    );
  } else {
    await sendTelegramMessage(
      chatId,
      "Hozircha sizning profilingiz Yandex.Taxi bazasida topilmadi.\nOperatorlar hujjatlaringizni ko‘rib chiqishyapti. Iltimos, birozdan so'ng yana tekshirib ko‘ring."
    );
  }
}

// ===== ПОСТРОЕНИЕ КНОПОК ДЛЯ МОДЕЛЕЙ МАШИН И ЦВЕТОВ =====

function buildCarModelKeyboard() {
  const rows = [];
  let row = [];
  for (const m of CAR_MODELS) {
    row.push({
      text: m.label,
      callback_data: `car_model:${m.code}`,
    });
    if (row.length === 2) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);
  return { inline_keyboard: rows };
}

function buildCarColorKeyboard() {
  const rows = [];
  let row = [];
  for (const c of CAR_COLORS) {
    row.push({
      text: c.label,
      callback_data: `car_color:${c.code}`,
    });
    if (row.length === 2) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);
  return { inline_keyboard: rows };
}

// ===== ОПИСАНИЕ ПОЛЕЙ, КОТОРЫЕ МОЖНО РЕДАКТИРОВАТЬ =====

function getEditableFields(session) {
  // Порядок полей для поэтапного подтверждения/изменения
  return [
    "first_name",
    "last_name",
    "middle_name",
    "birth_date",
    "license_series",
    "license_number",
    "tech_passport_series",
    "tech_passport_number",
    "car_year",
    "car_number",
    "car_model_label",
    "car_color_label",
  ];
}

function mapFieldKeyToLabel(key) {
  switch (key) {
    case "first_name":
      return "Ism";
    case "last_name":
      return "Familiya";
    case "middle_name":
      return "Otasining ismi";
    case "birth_date":
      return "Tug'ilgan sana";
    case "license_series":
      return "Haydovchilik guvohnomasi seriyasi";
    case "license_number":
      return "Haydovchilik guvohnomasi raqami";
    case "tech_passport_series":
      return "Texnik pasport seriyasi";
    case "tech_passport_number":
      return "Texnik pasport raqami";
    case "car_year":
      return "Avtomobil yili";
    case "car_number":
      return "Davlat raqami";
    case "car_model_label":
      return "Avtomobil modeli";
    case "car_color_label":
      return "Avtomobil rangi";
    default:
      return key;
  }
}

function getFieldValue(session, key) {
  const d = session.data || {};
  const f = d.fields || {};
  switch (key) {
    case "car_model_label":
      return d.carModelLabel || "—";
    case "car_color_label":
      return d.carColorLabel || "—";
    default:
      return f[key] ?? "—";
  }
}

// ===== СУММАРНЫЙ ТЕКСТ ДЛЯ ВОДИТЕЛЯ И ОПЕРАТОРОВ =====

function buildDriverSummary(session) {
  const d = session.data || {};
  const f = d.fields || {};
  const phone =
    d.phoneNormalized || d.phone || d.contactPhone || "—";

  const lines = [];

  lines.push("📋 <b>Ro'yxatdan o'tish ma'lumotlari</b>");
  lines.push("");
  lines.push(`📱 Telefon: <b>${phone}</b>`);

  lines.push(
    `👤 F.I.Sh.: <b>${f.last_name || "—"} ${f.first_name || "—"} ${
      f.middle_name || ""
    }</b>`
  );
  lines.push(`🎂 Tug'ilgan sana: <b>${f.birth_date || "—"}</b>`);

  lines.push("");
  lines.push("🪪 <b>Haydovchilik guvohnomasi</b>");
  lines.push(
    `Seriya va raqam: <b>${f.license_series || "—"} ${
      f.license_number || ""
    }</b>`
  );

  lines.push("");
  lines.push("📘 <b>Texnik pasport</b>");
  lines.push(
    `Seriya va raqam: <b>${f.tech_passport_series || "—"} ${
      f.tech_passport_number || ""
    }</b>`
  );
  lines.push(`Avtomobil yili: <b>${f.car_year || "—"}</b>`);

  lines.push("");
  lines.push("🚗 <b>Avtomobil</b>");
  lines.push(
    `Model: <b>${d.carModelLabel || f.car_model || "—"}</b>`
  );
  lines.push(
    `Rang: <b>${d.carColorLabel || f.car_color || "—"}</b>`
  );
  lines.push(`Davlat raqami: <b>${f.car_number || "—"}</b>`);

  return lines.join("\n");
}

// ===== ФИНАЛИЗАЦИЯ РЕГИСТРАЦИИ =====

async function finalizeRegistration(chatId, session) {
  const summary = buildDriverSummary(session);
  const phone =
    session.data?.phoneNormalized ||
    session.data?.phone ||
    session.data?.contactPhone ||
    "—";

  // Водителю — финальное сообщение
  const replyMarkup = {
    keyboard: [
      [
        {
          text: "🔄 Ro'yxatdan o'tish holatini tekshirish",
        },
      ],
    ],
    resize_keyboard: true,
  };

  await sendTelegramMessage(
    chatId,
    summary +
      "\n\n✅ <b>Ma'lumotlaringiz qabul qilindi.</b>\nOperatorlar hujjatlaringizni ko‘rib chiqishyapti. " +
      "Odatda bu biroz vaqt oladi.\n\nRo'yxatdan o'tish holatini tekshirish uchun quyidagi tugmadan foydalaning.",
    replyMarkup
  );

  // Операторам — тот же summary + служебная инфа
  if (ADMIN_CHAT_IDS.length) {
    for (const adminId of ADMIN_CHAT_IDS) {
      await sendTelegramMessage(
        adminId,
        `🆕 Yangi haydovchi ro'yxatdan o'tish uchun so'rov yubordi.\n\n${summary}\n\nChat ID: <code>${chatId}</code>\nTelefon: <b>${phone}</b>`
      );
    }
  }

  await sendLog(
    `✅ Yakuniy ro'yxatdan o'tish tasdiqlandi\nChat ID: <code>${chatId}</code>\nTelefon: <b>${phone}</b>`
  );

  // Обновим шаг
  session.step = "completed";
  session.lastUpdated = Date.now();

  // ВАЖНО: отправка напоминания через 5 минут в Netlify-функции "как есть" нереализуема.
  // Здесь можно только залогировать, а реализацию сделать через внешнюю очередь / cron.
  console.log(
    "Schedule status reminder in 5 minutes for chat:",
    chatId
  );
}

// ===== НАЧАЛО РЕДАКТИРОВАНИЯ ПОЛЕЙ =====

async function startEditingFlow(chatId, session) {
  session.editQueue = getEditableFields(session);
  session.editIndex = 0;
  session.currentField = null;
  session.step = "editing_fields";
  session.lastUpdated = Date.now();
  await goToNextEditableField(chatId, session);
}

async function goToNextEditableField(chatId, session) {
  const queue = session.editQueue || [];
  if (session.editIndex >= queue.length) {
    // Все поля просмотрены — снова показываем сводку и спрашиваем "hammasi to'g'rimi?"
    session.step = "await_summary_confirm1";
    const summary = buildDriverSummary(session);
    const kb = {
      inline_keyboard: [
        [
          { text: "✅ Ha, hammasi to'g'ri", callback_data: "summary1_yes" },
          { text: "✏️ O'zgartirish kerak", callback_data: "summary1_no" },
        ],
      ],
    };
    await sendTelegramMessage(
      chatId,
      summary + "\n\nMa'lumotlar to'g'rimi?",
      kb
    );
    return;
  }

  const fieldKey = queue[session.editIndex];
  session.currentField = fieldKey;
  session.step = "editing_field_choice";

  const label = mapFieldKeyToLabel(fieldKey);
  const value = getFieldValue(session, fieldKey);

  const kb = {
    inline_keyboard: [
      [
        {
          text: "✅ To'g'ri",
          callback_data: `edit_field_ok:${fieldKey}`,
        },
        {
          text: "✏️ O'zgartirish",
          callback_data: `edit_field_change:${fieldKey}`,
        },
      ],
    ],
  };

  await sendTelegramMessage(
    chatId,
    `${label}: <b>${value}</b>\n\nBu ma'lumot to'g'rimi?`,
    kb
  );
}

// ===== ОБРАБОТКА CALLBACK'ОВ =====

async function handleCallback(update) {
  const cb = update.callback_query;
  const data = cb.data || "";
  const chatId = cb.message?.chat?.id;
  if (!chatId) return { statusCode: 200, body: "No chat in callback" };

  const session = getSession(chatId);
  session.lastUpdated = Date.now();

  console.log("Callback data:", data, "from chat", chatId);

  // 1) Старт регистрации
  if (data === "start_registration") {
    session.step = "await_contact";

    const replyMarkup = {
      keyboard: [
        [{ text: "📱 Telefon raqamni yuborish", request_contact: true }],
      ],
      resize_keyboard: true,
      one_time_keyboard: true,
    };

    await sendTelegramMessage(
      chatId,
      "Ro'yxatdan o'tishni boshlash uchun pastdagi tugma orqali Telegram akkauntingizga ulangan telefon raqamingizni yuboring.",
      replyMarkup
    );
  }

  // 2) Выбор модели машины
  else if (data.startsWith("car_model:")) {
    const code = data.split(":")[1];
    const model = CAR_MODELS.find((m) => m.code === code);
    if (model) {
      session.data.carModelCode = model.code;
      session.data.carModelLabel = model.label;
      session.step = "await_car_color";
      await sendTelegramMessage(
        chatId,
        `Model tanlandi: <b>${model.label}</b>\n\nEndi avtomobil rangini tanlang:`,
        buildCarColorKeyboard()
      );
    } else {
      await sendTelegramMessage(
        chatId,
        "Modelni aniqlab bo'lmadi. Iltimos, qaytadan tanlab ko'ring."
      );
    }
  }

  // 3) Выбор цвета машины
  else if (data.startsWith("car_color:")) {
    const code = data.split(":")[1];
    const color = CAR_COLORS.find((c) => c.code === code);
    if (color) {
      session.data.carColorCode = color.code;
      session.data.carColorLabel = color.label;
      session.step = "await_dl_front";

      await sendTelegramMessage(
        chatId,
        `Rang tanlandi: <b>${color.label}</b>\n\nEndi ro'yxatdan o'tishni davom ettiramiz.\n\n1️⃣ Iltimos, haydovchilik guvohnomangizning <b>old tomoni</b> rasmini yuboring.\n\n📸 Rasm aniq, yozuvlar o'qiladigan bo'lsin. Hujjatni to'liq tushiring, yoritish yaxshi bo'lsin, iloji boricha yaltirash (blik) bo'lmasin.`
      );
    } else {
      await sendTelegramMessage(
        chatId,
        "Rangni aniqlab bo'lmadi. Iltimos, qaytadan tanlab ko'ring."
      );
    }
  }

  // 4) Первая сводка — Да/Нет
  else if (data === "summary1_yes") {
    session.step = "await_summary_confirm2";
    session.lastUpdated = Date.now();
    const kb = {
      inline_keyboard: [
        [
          {
            text: "✅ Ha, yakuniy tasdiqlayman",
            callback_data: "summary2_yes",
          },
          {
            text: "✏️ O'zgartirish",
            callback_data: "summary2_no",
          },
        ],
      ],
    };
    await sendTelegramMessage(
      chatId,
      "Iltimos, barcha ma'lumotlarni yana bir bor diqqat bilan tekshiring.\nAgar hammasi to'g'ri bo'lsa, quyidagi tugma orqali yakuniy tasdiqni bering.",
      kb
    );
  } else if (data === "summary1_no") {
    // Переходим к поэтапному редактированию
    await startEditingFlow(chatId, session);
  }

  // 5) Вторая сводка — финальное Да/Нет
  else if (data === "summary2_yes") {
    await finalizeRegistration(chatId, session);
  } else if (data === "summary2_no") {
    await startEditingFlow(chatId, session);
  }

  // 6) Редактирование конкретного поля
  else if (data.startsWith("edit_field_ok:")) {
    // Поле подтверждено, идём дальше
    session.editIndex += 1;
    await goToNextEditableField(chatId, session);
  } else if (data.startsWith("edit_field_change:")) {
    const fieldKey = data.split(":")[1];
    session.currentField = fieldKey;
    session.step = "await_field_new_value";
    const label = mapFieldKeyToLabel(fieldKey);
    const oldValue = getFieldValue(session, fieldKey);

    await sendTelegramMessage(
      chatId,
      `${label} uchun yangi qiymatni yozib yuboring.\n\nHozirgi qiymat: <b>${oldValue}</b>`
    );
  }

  // Ответить callback'у, чтобы "часики" исчезли
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: cb.id }),
  });

  return { statusCode: 200, body: "Callback handled" };
}

// ===== ОБРАБОТКА ДОКУМЕНТОВ ПО ЭТАПАМ =====

async function handleDocumentStep(update, msg, chatId, session) {
  const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
  const hasImageDocument =
    msg.document && (msg.document.mime_type || "").startsWith("image/");
  const hasDocumentToProcess = hasPhoto || hasImageDocument;

  if (!hasDocumentToProcess) {
    return false;
  }

  // Разрешаем документы только в ожидаемых шагах
  const allowedSteps = [
    "await_dl_front",
    "await_dl_back",
    "await_tech_front",
    "await_tech_back",
    "await_car_photo",
  ];

  if (!allowedSteps.includes(session.step)) {
    await sendTelegramMessage(
      chatId,
      "Hozir hujjat qabul qilish bosqichida emasmiz.\nAgar ro'yxatdan o'tmoqchi bo'lsangiz, /start buyrug'ini yuboring."
    );
    return true;
  }

  let docType = "";
  let nextStep = null;
  let nextMessage = "";

  if (session.step === "await_dl_front") {
    docType = "driver_license_front";
    nextStep = "await_dl_back";
    nextMessage =
      "Haydovchilik guvohnomasining <b>old tomoni</b> qabul qilindi ✅\n\n2️⃣ Endi haydovchilik guvohnomasining <b>orqa tomoni</b> rasmini yuboring.\n\n📸 Yozuvlar aniq va o'qiladigan bo'lsin, hujjat to'liq tushsin.";
  } else if (session.step === "await_dl_back") {
    docType = "driver_license_back";
    nextStep = "await_tech_front";
    nextMessage =
      "Haydovchilik guvohnomasining <b>orqa tomoni</b> qabul qilindi ✅\n\n3️⃣ Endi texnik pasportingizning <b>old tomoni</b> rasmini yuboring.";
  } else if (session.step === "await_tech_front") {
    docType = "tech_passport_front";
    nextStep = "await_tech_back";
    nextMessage =
      "Texnik pasportning <b>old tomoni</b> qabul qilindi ✅\n\n4️⃣ Endi texnik pasportingizning <b>orqa tomoni</b> rasmini yuboring.";
  } else if (session.step === "await_tech_back") {
    docType = "tech_passport_back";
    nextStep = "await_car_photo";
    nextMessage =
      "Texnik pasportning <b>orqa tomoni</b> qabul qilindi ✅\n\n5️⃣ Agar imkon bo'lsa, avtomobilingizning tashqi ko‘rinishdagi rasmini yuboring.\nAgar hozir rasm yo'q bo'lsa, <code>/skip</code> deb yozib yuborishingiz mumkin.";
  } else if (session.step === "await_car_photo") {
    docType = "car_photo";
    nextStep = "await_summary_confirm1";
    // после этого сразу перейдём к сводке
  }

  await sendTelegramMessage(
    chatId,
    "Hujjat qabul qilindi, uni avtomatik tekshiryapmiz..."
  );

  const result = await forwardDocToUploadDoc(update, {
    doc_type: docType,
    chat_id: chatId,
    step: session.step,
  });

  if (!result.ok) {
    console.error("forwardDocToUploadDoc failed:", result);
    await sendTelegramMessage(
      chatId,
      "Hujjatni avtomatik tekshirishda xatolik yuz berdi. Operatorga xabar berdik, qo‘lda tekshiruv o‘tkaziladi."
    );
  } else {
    // Пытаемся забрать распознанные поля (если upload-doc их возвращает)
    const d = result.data || {};
    const extracted =
      d.extracted ||
      d.fields ||
      d.recognizedData ||
      d.recognized ||
      null;

    if (extracted && typeof extracted === "object") {
      session.data.fields = {
        ...(session.data.fields || {}),
        ...extracted,
      };
    }
  }

  // Переходим к следующему шагу
  session.step = nextStep || "await_summary_confirm1";
  session.lastUpdated = Date.now();

  if (session.step === "await_summary_confirm1") {
    const summary = buildDriverSummary(session);
    const kb = {
      inline_keyboard: [
        [
          { text: "✅ Ha, hammasi to'g'ri", callback_data: "summary1_yes" },
          { text: "✏️ O'zgartirish kerak", callback_data: "summary1_no" },
        ],
      ],
    };
    await sendTelegramMessage(
      chatId,
      summary + "\n\nMa'lumotlar to'g'rimi?",
      kb
    );
  } else if (nextMessage) {
    await sendTelegramMessage(chatId, nextMessage);
  }

  return true;
}

// ===== ОСНОВНОЙ ХЭНДЛЕР NETLIFY ======

exports.handler = async (event) => {
  console.log("=== telegram-asr-bot (registration) invoked ===");
  console.log("Method:", event.httpMethod);

  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200 };
    }

    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method not allowed" };
    }

    if (WEBHOOK_SECRET) {
      const incoming =
        event.headers["x-telegram-bot-api-secret-token"] ||
        event.headers["X-Telegram-Bot-Api-Secret-Token"];
      if (!incoming) {
        console.warn("Telegram so'rovi secret_token headersiz keldi");
      } else if (incoming !== WEBHOOK_SECRET) {
        console.warn("Bad webhook secret:", incoming);
        return { statusCode: 403, body: "Forbidden" };
      }
    }

    let update;
    try {
      update = JSON.parse(event.body || "{}");
    } catch (e) {
      console.error("Bad JSON from Telegram:", e);
      return { statusCode: 400, body: "Bad request" };
    }

    console.log("Update:", JSON.stringify(update));

    // ===== CALLBACK КНОПКИ =====
    if (update.callback_query) {
      return await handleCallback(update);
    }

    // ===== СООБЩЕНИЯ =====
    const msg = update.message || update.edited_message;
    if (!msg) {
      return { statusCode: 200, body: "No message" };
    }

    const chatId = msg.chat?.id;
    const chatType = msg.chat?.type;
    if (!chatId || chatType !== "private") {
      return { statusCode: 200, body: "Ignored" };
    }

    const session = getSession(chatId);
    session.lastUpdated = Date.now();

    const text = msg.text || msg.caption || "";
    const hasContact = !!msg.contact;

    // Команда /start — приветствие и кнопка "Ro'yxatdan o'tish"
    if (text === "/start") {
      resetSession(chatId);
      const inlineKeyboard = {
        inline_keyboard: [
          [{ text: "🚖 Ro'yxatdan o'tish", callback_data: "start_registration" }],
        ],
      };

      await sendTelegramMessage(
        chatId,
        "Assalomu alaykum! 👋\nBu bot haydovchilarga <b>ASR TAXI</b> parkiga ulanishda yordam beradi.\n\nRo'yxatdan o'tishni boshlash uchun quyidagi tugmani bosing.",
        inlineKeyboard
      );

      return { statusCode: 200, body: "OK" };
    }

    // Кнопка "Проверить статус регистрации"
    if (
      text === "🔄 Ro'yxatdan o'tish holatini tekshirish" ||
      text === "/status"
    ) {
      await handleStatusCheck(chatId);
      return { statusCode: 200, body: "Status checked" };
    }

    // Обновление значения поля при редактировании
    if (session.step === "await_field_new_value" && session.currentField && !hasContact) {
      const fieldKey = session.currentField;
      session.data.fields = session.data.fields || {};
      session.data.fields[fieldKey] = text.trim();
      session.currentField = null;
      session.step = "editing_fields";
      session.editIndex += 1;

      await sendTelegramMessage(
        chatId,
        `${mapFieldKeyToLabel(fieldKey)} yangilandi ✅`
      );
      await goToNextEditableField(chatId, session);
      return { statusCode: 200, body: "Field updated" };
    }

    // Водитель отправил контакт
    if (hasContact) {
      const contact = msg.contact;
      const from = msg.from;

      // Telefon boshqa Telegram akkauntga tegishli bo‘lsa — rad etamiz
      if (contact.user_id && from && contact.user_id !== from.id) {
        await sendTelegramMessage(
          chatId,
          "Iltimos, aynan o'zingizning Telegram akkauntingizga ulangan raqamni yuboring."
        );
        return { statusCode: 200, body: "Foreign contact rejected" };
      }

      const phone = contact.phone_number;
      const normalized = normalizePhone(phone);

      session.data.phone = phone;
      session.data.phoneNormalized = normalized;
      session.step = "contact_received";

      // Уберём клавиатуру с отправкой контакта
      const removeKb = { remove_keyboard: true };

      console.log(
        "Got contact from user:",
        from?.id,
        "phone:",
        phone,
        "normalized:",
        normalized
      );

      await sendTelegramMessage(
        chatId,
        `Rahmat! <b>${normalized}</b> raqam qabul qilindi.\nSizni Yandex.Taxi bazasida tekshiryapman...`,
        removeKb
      );

      await sendLog(
        `📲 Yangi haydovchi kontakti\n` +
          `Chat ID: <code>${chatId}</code>\n` +
          `Telefon (xom): <code>${phone}</code>\n` +
          `Telefon (norm.): <b>${normalized}</b>`
      );

      const check = await checkDriverInFleet(normalized);

      if (check.error === "fleet_error" || check.error === "fleet_exception") {
        await sendTelegramMessage(
          chatId,
          "Hozircha Yandex.Taxi bazasini tekshirib bo'lmadi. Raqamingizni operatorga yuboraman, u siz bilan qo'lda bog'lanadi."
        );

        if (ADMIN_CHAT_IDS.length) {
          for (const adminId of ADMIN_CHAT_IDS) {
            await sendTelegramMessage(
              adminId,
              `❗️ Fleet API xatosi.\nChat ID: <code>${chatId}</code>\nTelefon: <b>${normalized}</b>`
            );
          }
        }
        return { statusCode: 200, body: "Fleet error" };
      }

      if (check.exists) {
        // Уже есть в базе — документы и машину дополнительно не спрашиваем
        await sendTelegramMessage(
          chatId,
          "Siz allaqachon Yandex.Taxi bazasida ro'yxatdan o'tgansiz. ✅\nOperator ma'lumotlarni tekshiradi va siz bilan ulanish bo'yicha bog'lanadi."
        );

        const p = check.profile || {};
        const dp = p.driver_profile || {};
        const car = p.car || {};

        const shortInfo =
          `F.I.Sh.: <b>${dp.last_name || ""} ${dp.first_name || ""}</b>\n` +
          (car.brand || car.model || car.number
            ? `Avto: <b>${car.brand || "—"} ${car.model || "—"}</b> (${car.number || "—"})\n`
            : "") +
          `Holat: <code>${p.current_status?.status || "unknown"}</code>`;

        if (ADMIN_CHAT_IDS.length) {
          for (const adminId of ADMIN_CHAT_IDS) {
            await sendTelegramMessage(
              adminId,
              `✅ Haydovchi bazada topildi.\nChat ID: <code>${chatId}</code>\nTelefon: <b>${normalized}</b>\n${shortInfo}`
            );
          }
        }

        await sendLog(
          `✅ Tekshiruv natijasi\n` +
            `Chat ID: <code>${chatId}</code>\n` +
            `Telefon: <b>${normalized}</b>\n` +
            shortInfo
        );

        session.step = "completed_existing";
      } else {
        // Yandex bazasida yo'q — спрашиваем модель машины (кнопками)
        session.step = "await_car_model";
        await sendTelegramMessage(
          chatId,
          "Siz hozircha Yandex.Taxi bazasida topilmadingiz.\nParkka ulanish uchun ma'lumotlarni to'ldirishni davom ettiramiz.\n\nAvval avtomobil modelini tanlang:",
          buildCarModelKeyboard()
        );

        if (ADMIN_CHAT_IDS.length) {
          for (const adminId of ADMIN_CHAT_IDS) {
            await sendTelegramMessage(
              adminId,
              `🆕 Ro'yxatdan o'tish uchun yangi haydovchi.\nChat ID: <code>${chatId}</code>\nTelefon: <b>${normalized}</b>\nAvtomobil modeli va hujjatlar Telegram orqali qabul qilinadi.`
            );
          }
        }

        await sendLog(
          `🆕 Haydovchi Fleet bazasidan topilmadi\n` +
            `Chat ID: <code>${chatId}</code>\n` +
            `Telefon: <b>${normalized}</b>\n` +
            `Keyingi bosqich: avtomobil modelini tanlash`
        );
      }

      return { statusCode: 200, body: "Contact processed" };
    }

    // Обработка документов (фото) по текущему шагу
    const docHandled = await handleDocumentStep(update, msg, chatId, session);
    if (docHandled) {
      return { statusCode: 200, body: "Document handled" };
    }

    // Пропуск фото машины (последний шаг документов)
    if (text === "/skip" && session.step === "await_car_photo") {
      session.step = "await_summary_confirm1";
      session.lastUpdated = Date.now();
      const summary = buildDriverSummary(session);
      const kb = {
        inline_keyboard: [
          [
            { text: "✅ Ha, hammasi to'g'ri", callback_data: "summary1_yes" },
            { text: "✏️ O'zgartirish kerak", callback_data: "summary1_no" },
          ],
        ],
      };
      await sendTelegramMessage(
        chatId,
        summary + "\n\nMa'lumotlar to'g'rimi?",
        kb
      );
      return { statusCode: 200, body: "Skip car photo" };
    }

    // Всё остальное
    await sendTelegramMessage(
      chatId,
      "Hozircha bu bot faqat haydovchilarni ro'yxatdan o'tkazish va hujjatlarni qabul qilish uchun ishlaydi.\nRo'yxatdan o'tishni boshlash uchun /start buyrug'ini yuboring."
    );

    return { statusCode: 200, body: "OK" };
  } catch (err) {
    console.error("telegram-asr-bot handler error:", err);
    await sendLog(
      `🔥 telegram-asr-bot handler xatosi:\n<code>${String(err)}</code>`
    );
    return { statusCode: 500, body: "Internal error" };
  }
};
