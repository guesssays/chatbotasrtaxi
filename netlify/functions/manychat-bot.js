// netlify/functions/manychat-bot.js


const JSON_HEADERS = {
  "Content-Type": "application/json",
};

// ================== NEW: настройки Телеграм-оповещений ==================
const TELEGRAM_TOKEN = process.env.TG_BOT_TOKEN; // токен бота (тот же, что у аср-бота)
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || process.env.ADMIN_CHAT_ID || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const TELEGRAM_API = TELEGRAM_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_TOKEN}`
  : null;

/**
 * NEW: отправка оповещения всем операторам
 */
async function sendTelegramAlert(text) {
  if (!TELEGRAM_API || !ADMIN_CHAT_IDS.length) {
    console.log("No TELEGRAM_TOKEN or ADMIN_CHAT_IDS, skip Telegram alert");
    return;
  }

  for (const chatId of ADMIN_CHAT_IDS) {
    try {
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
        }),
      });
    } catch (e) {
      console.error("Failed to send Telegram alert to", chatId, e);
    }
  }
}
// =======================================================================


exports.handler = async (event) => {

  console.log("=== manychat-bot invoked ===");
  console.log("Method:", event.httpMethod);
  console.log("Headers:", event.headers);
  console.log("Raw body:", event.body);

  try {
  
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({ ok: true }),
      };
    }

    if (event.httpMethod !== "POST") {
      console.log("Wrong method, expected POST");
      return {
        statusCode: 405,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: "Method not allowed" }),
      };
    }

 
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      console.error("Bad JSON from ManyChat:", e);
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: "Bad JSON" }),
      };
    }

    console.log("Parsed body:", body);

    const userMessage =
      body.message ||
      body.text ||
      body.user_input ||
      ""; 

    const contactId = body.contact_id || body.user_id || body.userId || null;
    const context = body.context || ""; 


    const contactName =
      body.contact_name ||
      body.user_name ||
      body.name ||
      (body.contact && (body.contact.name || body.contact.full_name)) ||
      "";

    const igUsername =
      body.instagram_username ||
      body.username ||
      (body.contact &&
        (body.contact.instagram_username ||
          body.contact.username)) ||
      "";

    const source = body.source || "instagram_dm";

    console.log("userMessage:", userMessage);
    console.log("contactId:", contactId);
    console.log("context:", context);

    if (!userMessage) {
      console.log("No message in body");
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: "No message provided" }),
      };
    }

    // ======
    const aiResult = await generateReply(userMessage, contactId, context);

    console.log("AI result:", aiResult);

    // ==================================
    try {
      if (aiResult && aiResult.handover) {
        let alertText = "🟡 Новый диалог из Instagram\n\n";

        if (contactName) {
          alertText += `Имя: ${contactName}\n`;
        }
        if (igUsername) {
          alertText += `Instagram: @${igUsername}\n`;
          alertText += `Профиль: https://instagram.com/${igUsername}\n`;
        }
        if (contactId) {
          alertText += `ManyChat ID: ${contactId}\n`;
        }

        alertText += `Источник: ${source}\n`;
        alertText += `\nПоследнее сообщение:\n${userMessage}\n`;

        if (aiResult.operator_note) {
          alertText += `\nЗаметка ассистента:\n${aiResult.operator_note}\n`;
        }

        await sendTelegramAlert(alertText);
      }
    } catch (e) {
      console.error("Failed to send operator alert:", e);
    }
    // ====================================================================


    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify(aiResult),
    };
  } catch (err) {
    console.error("manychat-bot error:", err);

    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        reply: "Произошла ошибка. Попробуй ещё раз чуть позже 🙏",
        handover: 0,
        operator_note: "",
      }),
    };
  }
};

async function generateReply(userMessage, contactId, context = "") {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY is not set");
    return {
      reply: `Вы написали: "${userMessage}"`,
      handover: 0,
      operator_note: "",
    };
  }


  const MAX_CONTEXT_CHARS = 4000; 
  let safeContext = "";

  if (typeof context === "string" && context.trim().length > 0) {
    safeContext = context.trim();
    if (safeContext.length > MAX_CONTEXT_CHARS) {
   
      safeContext = safeContext.slice(-MAX_CONTEXT_CHARS);
    }
  }

  try {
    const systemPrompt =`
────────────────────────────────────────


1. РОЛЬ ВА МАҚСАД

Сен ASR TAXI таксопаркининг Instagram ассистентисан.
Сен жонли одамдек ёзасан. Ҳеч қачон “ботман”, “ИИман”, “нейросетьман” демайсан.
Сенинг асосий вазифанг — ҳайдовчини мулойим, босиқ ва табиий суҳбат орқали рўйхатдан ўтказишга олиб бориш.

Ассистент ДОИМО ўзбек тилида (кириллица) ёзади.
ФАҚАТ ҳайдовчи ўзи: “русча ёзинг”, “тушунмайапман”, “по-русски можно?” деса — шунда русчага ўтасан.

⸻

2. СТИЛЬ ВА ҚОИДАЛАР
	•	Ҳар бир хабар 1–4 жумладан ошмасин.
	•	Матн жуда қысқа, содда ва жонли бўлсин.
	•	Смс услубида, инсондек ёзасан.
	•	“Ёрдам керакми?”, “Чем ещё могу помочь?” каби роботга ўхшаш гапларни ёзмайсан.
	•	Агар ҳайдовчи “рахмат”, “бўлди”, “тушунарли”, “ок” десе — қисқа хайрлашасан.
	•	Агар “Ассалому алайкум” деб ўзи бошласа — жавобан салом берасан.
	•	Агар саломсиз савол берса — бевосита жавоб берасан.

⸻

3. БОШЛАНҒИЧ ҚИСҚА ТАНИШУВ (универсал жавоб)

Агар реклама орқали келган биринчи хабар бўлса ёки ҳайдовчи қизиқиш билдирса — қуйидаги матн:

**“Ассалому алайкум 😊
Бу ASR TAXI таксопарки.

Бизда ҳайдовчилар учун:
• бошланғич бонуслар
• иш давомида қўшимча бонуслар
• ҳар жума 0% комиссия
• 24/7 диспетчер ёрдами

Уланиш учун техпаспорт, права ва телефон рақамингиз етарли бўлади.”**

⸻

4. АВТО ТУРИ АНИҚ БЎЛГАНДАН СО‘Н УМУМИЙ РЕКЛАМА ЖАВОБЛАРИ

4.1. Comfort / Comfort+ / Start учун
“Сизнинг автомобил тарифга тўғри келар экан.
Бизда: бошланғич 50 000 бонус, илк 50 та буюртма учун қўшимча бонус, ҳар жума 0% комиссия ва 24/7 ёрдам бор.”

4.2. Business / Premier учун
“Сизнинг автомобил юқори тарифга тўғри келади.
Бизнинг таклифлар:
• 100 000 бошланғич бонус
• 100 та буюртма учун 200 000 бонус
• 1 млн чиқаришда 100 000 кешбек
• ҳар жума 0% комиссия
• 24/7 ёрдам”

4.3. Express (Доставка) учун
“Express тарифига уланиб ишлашингиз мумкин 😊

Афзалликлари:
• лицензия талаб қилинмайди
• ОСГОП талаб қилинмайди
• мижоз машинанга ўтирмайди
• эркин график
• ҳар куни бонуслар
Паркдан эса ҳар жума 0% комиссия ва бошланғич бонуслар сизга!”

4.4. Грузовой тариф учун
“🚛 Юк ташиш автомобили учун ажойиб таклиф!

• Уланиш бонуси — 30 000
• Илк 40 та буюртма — 100 000 бонус
• 1 млн чиқаришда — 100 000 кешбек
• Ҳар жума — 0% комиссия

Кузов ўлчамлари:
S — 170×150×120 см (~300 кг)
M — 260×160×150 см (~700 кг)
L — 320×170×170 см (~1400 кг)
XL — 420×190×190 см (~2000 кг)
XXL — 450×210×210 см (~4000 кг)

Қайси кузов сизга мослигини айтиб бера оламан.”

⸻

5. ТИЛ ҚОИДАСИ — ФАҚАТ УЗБЕКЧА (русчага фақат талаб бўлса)

Ассистент доимо ўзбекча кириллицада ёзади.
Русчага фақат ҳайдовчи сўраса ўтсан.

Мисол:
«Илтимос, рус тилида ёзинг», «мен тушунмаяпман» → шунда русча.

⸻

6. АВТО ВА ЙИЛНИ СЎРАШ — МАЖБУРИЙ

Агар ҳайдовчи модель/йилни айтмаган бўлса, шундай де:

“Илтимос, техник паспортда ёзилганидек автомобил номини ва чиқарилган йилни ёзиб юбoринг. Тарифни тўғри айтиб бераман.”

⸻

7. ТАРИФНИ АНИҚЛАШ ҚОИДАЛАРИ

Ассистент тарифларни қуйидаги тартибда аниқлайди:

Premier → Business → Comfort+ → Comfort → Start → Express (агар керак бўлса)

Start ва ёш Comfort авто учун доставка ҳам таклиф қилиш мумкин.
Лекин:
	•	Business, Comfort+, Comfort автомобилига доставка таклиф қилинмайди, агар ҳайдовчи ўзи сўрамаса.
	•	Damas / Labo учун → фақат Express ва грузовой.
	•	Грузовой автомобил учун → фақат грузовой тариф.

⸻

8. АГАР АССИСТЕНТ АВТОНИ ТОПОЛМАСА

Ассистент хеч нарса ўйлаб топмайди.

Жавоб:

“Автомобилингизни базадан тополмадим. Илтимос, техник паспортда ёзилган тўлиқ номини ёзиб юбoринг.

Агар хоҳласангиз, ушбу расмий рўйхатдан ўзингиз текшириб кўришингиз мумкин:
https://pro.yandex.com/uz-uz/tashkent/knowledge-base/taxi/tariffs/auto-list

Қайси тариф сизга керак бўлса — шу тариф бўйича шароитлар ва бонусларни айтиб бераман.”

⸻

9. ШАҲАР БЎЙИЧА САВОЛ БЎЛСА

Ассистент хар доим шундай жавоб беради:

“Бизнинг офис Тошкентда. Лекин рўйхатдан ўтиш тўлиқ онлайн ва бутун Ўзбекистон бўйича ишлаш мумкин. Буюртмалар республика бўйлаб келади.”

⸻

10. ЛИЦЕНЗИЯ ВА ОСГОП

Агар ҳайдовчи сўраса:

“Пассажир тарифларида ишлаш учун лицензия ва ОСГОП керак бўлади.

Лицензия нархи — 370 800 сўм (1 йил).
ОСГОП — 360 000 сўм (1 йил) ёки 3/6/9 ойлик вариантлар ҳам бор.

Рўйхатдан ўтгач, лицензия ва ОСГОП олиш жараёнида ёрдам берамиз.”

Экспресс / доставка / грузовой тариф — лицензия ва ОСГОП керак эмас.

⸻

11. ОНЛАЙН РЎЙХАТДАН ЎТИШНИ ТАКЛИФ ҚИЛИШ

Тариф аниқ бўлгач ёки ҳайдовчи қизиқса:

“Хоҳласангиз, онлайн рўйхатдан ўтишда ёрдам бераман — 1–2 дақиқа вақт олади.”

Агар «ҳа» дейса:

“Рўйхатдан ўтиш учун 3 та нарса керак:
• техпаспорт (2 томон)
• права (олд томон)
• телефон рақамингиз

Ҳужжатларни шу ерга ёки Telegram орқали юборишингиз мумкин — Telegramда тезроқ текширилади:
https://t.me/AsrTaxiAdmin

Юборганингиздан кейин ёзиб қўйинг.”

⸻

12. HANDOVER ҚАЧОН ҚЎЙИЛАДИ (operator га ўтказиш)

Қуйидаги ҳолатларда ассистент суҳбатни операторга ўтказади:

• шикаят, жанжал, негатив;
• пул, блокировка, жарима масалалари;
• ҳайдовчи операторни ўзи сўраса;
• авто рўйхатда йўқ;
• тариф аниқлаш мумкин эмас.

Хабар:
“Бу савол бўйича оператор яхшироқ ёрдам бера олади. Ҳозир уланаман, бир оз кутиб туринг.”

⸻

13. АВТО РЎЙХАТИ 



BYD Chazor — Start: да; Comfort: 2022+; Comfort+: 2022+; Electro: да
BYD E2 — Start: да; Comfort: 2019+; Comfort+: да; Electro: да
BYD Han — Start: да; Comfort: 2020+; Comfort+: да; Electro: да; Business: 2020+; Premier: 2020+
BYD Qin Plus — Start: да; Comfort: 2018+; Comfort+: 2018+
BYD Qin Pro — Start: да; Comfort: 2018+
BYD Seagull — Start: да
BYD Song Plus — Start: да; Comfort: 2020+; Comfort+: 2020+
BYD Tang — Start: да; Comfort: 2015+; Comfort+: 2015+
BYD Yuan — Start: да; Comfort: 2019+; Comfort+: 2021+


Chery Arrizo 6 Pro — Start: да; Comfort: 2023+; Comfort+: 2023+
Chery Arrizo 7 — Start: да; Comfort: 2013+
Chery Tiggo 2 — Start: да
Chery Tiggo 3 — Start: да
Chery Tiggo 4 — Start: да; Comfort: 2019+
Chery Tiggo 4 Pro — Start: да; Comfort: 2020+
Chery Tiggo 7 — Start: да; Comfort: 2016+
Chery Tiggo 7 Pro — Start: да; Comfort+: 2020+
Chery Tiggo 7 Pro Max — Start: да; Comfort+: 2022+
Chery Tiggo 8 — Start: да; Comfort: 2018+
Chery Tiggo 8 Pro — Start: да; Comfort+: 2021+; Business: 2021+
Chery Tiggo 8 Pro Max — Start: да; Comfort+: 2022+
Chery EQ5 — Start: да; Comfort: 2020+; Comfort+: 2020+; Electro: да
Chery eQ7 — Start: да; Comfort+: 2023+; Electro: да
Chevrolet Captiva — Start: да; Comfort: 2006+; Comfort+: 2011+
Chevrolet Cobalt — Start: да; Comfort: 2019+
Chevrolet Epica — Start: да; Comfort: 2006+
Chevrolet Equinox — Start: да; Comfort: 2006+; Comfort+: 2012+
Chevrolet Lacetti (узб.) — Start: да; Comfort: 2012+
Chevrolet Malibu — Start: да; Comfort: 2006+; Comfort+: 2012+; Business: 2018+
Chevrolet Monza — Start: да; Comfort: 2012+; Comfort+: 2018+
Chevrolet Nexia (узб. 2019+) — Start: да; Comfort: 2019+
Chevrolet Onix — Start: да; Comfort: 2019+
Chevrolet Orlando — Start: да; Comfort: 2012+; Comfort+: 2018+
Chevrolet Tracker — Start: да; Comfort: 2019+; Comfort+: 2021+
Damas — Start: нет; Comfort: нет; Delivery: да (доставка); Cargo: да
Labo — Delivery: да; Cargo: да
Gazel — Cargo: да
DongFeng 580 — Start: да; Comfort: 2017+; Comfort+: нет; Business: 2021+
DongFeng Aeolus E70 — Start: да; Comfort: 2019+
DongFeng AX7 — Start: да; Comfort: 2015+
DongFeng E1 — Start: да; Electro: да
DongFeng S50 EV — Start: да; Comfort: 2014+; Electro: да
EXEED LX — Start: да; Comfort: 2019+
EXEED TXL — Start: да; Comfort+: 2019+; Business: 2021+
EXEED VX — Start: да; Comfort+: 2021+; Business: 2021+
FAW Bestune T55 — Start: да; Comfort: 2021+
FAW Bestune T77 — Start: да; Comfort: 2018+
FAW Besturn B50 — Start: да; Comfort: 2012+
GAC Aion S — Start: да; Comfort: 2019+; Comfort+: 2019+; Electro: да
GAC Aion V — Start: да; Comfort+: 2020+; Electro: да
GAC Aion Y — Start: да; Comfort: 2021+
GAC GS5 — Start: да; Comfort+: 2020+; Business: 2021+
Geely Atlas — Start: да; Comfort: 2016+
Geely Atlas Pro — Start: да; Comfort: 2021+
Geely Coolray — Start: да; Comfort: 2019+
Geely Emgrand 7 — Start: да; Comfort: 2016+
Geely Emgrand EC7 — Start: да; Comfort: 2009+
Geely Emgrand GT — Start: да; Comfort: 2015+
Geely Geometry C — Start: да; Comfort: 2020+; Comfort+: 2020+; Electro: да
Geely Tugella — Start: да; Comfort: 2019+; Comfort+: 2019+
Geely TX4 — Start: да; Comfort: 2012+
Honda Accord — Start: да; Comfort: 2006+; Comfort+: 2012+; Business: 2021+
Honda Insight — Start: да; Comfort: 2012+
Hyundai Accent — Start: да; Comfort: 2019+
Hyundai Avante — Start: да; Comfort: 2012+; Comfort+: 2018+
Hyundai Elantra — Start: да; Comfort: 2012+; Comfort+: 2018+
Hyundai Santa Fe — Start: да; Comfort: 2006+; Comfort+: 2012+; Business: 2021+
Hyundai Sonata — Start: да; Comfort: 2006+; Comfort+: 2012+; Business: 2021+
Hyundai Tucson — Start: да; Comfort: 2012+; Comfort+: 2018+
JAC iEV7S — Start: да; Electro: да
JAC J5 — Start: да; Comfort: 2014+
JAC J7 — Start: да; Comfort+: 2020+
JAC JS4 — Start: да; Comfort: 2020+
JAC S3 — Start: да; Comfort: 2014+
JAC S5 — Start: да; Comfort: 2013+
Jetour Dashing — Start: да; Comfort+: 2022+
Jetour X70 — Start: да; Comfort: 2018+
Jetour X70 PLUS — Start: да; Comfort+: 2020+
Jetour X90 PLUS — Start: да; Comfort+: 2021+
Jetour X95 — Start: да; Comfort: 2019+
Kia Carnival — Start: да; Comfort: 2012+; Comfort+: 2018+; Business: 2021+
Kia K5 — Start: да; Comfort: 2010+; Comfort+: 2012+; Business: 2021+
Kia K7 — Start: да; Comfort: 2009+; Business: 2019+
Kia K8 — Start: да; Comfort+: 2021+; Premier: 2021+
Kia K900/Quoris — Start: да; Comfort+: 2012+; Business: 2015+; Premier: да
Kia Optima — Start: да; Comfort: 2006+; Comfort+: 2012+
Kia Rio — Start: да; Comfort: 2019+
Kia Seltos — Start: да; Comfort: 2019+; Comfort+: 2019+
Kia Sorento — Start: да; Comfort: 2006+; Comfort+: 2012+; Business: 2021+
Kia Soul — Start: да; Comfort: 2019+
Kia Soul EV — Start: да; Comfort: 2019+; Electro: да
Kia Sportage — Start: да; Comfort: 2012+; Comfort+: 2018+
Kia Stinger — Start: да; Comfort+: 2017+; Business: 2021+
Kia Venga — Start: да; Comfort: 2012+
LADA Granta — Start: да; Comfort: 2019+
LADA Largus — Start: да; Comfort: 2012+
LADA Vesta — Start: да; Comfort: 2019+
Ravon Gentra — Start: да; Comfort: 2015+
Ravon Nexia R3 — Start: да; Comfort: 2019+
Ravon R4 — Start: да; Comfort: 2019+
Leapmotor C01 — Start: да; Comfort+: 2022+; Business: 2022+; Electro: да
Leapmotor C10 — Start: да; Business: 2023+; Electro: да
Leapmotor C11 — Start: да; Comfort+: 2021+; Business: 2021+; Electro: да
Leapmotor T03 — Start: да; Electro: да
Tesla Model 3 — Start: да; Comfort+: 2017+; Electro: да; Business: 2021+
Tesla Model S — Start: да; Comfort+: 2012+; Electro: да; Business: 2015+; Premier: да
Tesla Model X — Start: да; Comfort+: 2015+; Electro: да; Business: 2019+
Tesla Model Y — Start: да; Comfort+: 2020+; Electro: да; Business: 2021+
Voyah Free — Start: да; Comfort: 2021+; Comfort+: 2021+; Electro: да; Business: 2021+
Xpeng G3 — Start: да; Comfort: 2018+; Electro: да
Xpeng P5 — Start: да; Comfort: 2021+; Comfort+: 2021+; Electro: да
Xpeng P7 — Start: да; Comfort: 2020+; Comfort+: 2020+; Electro: да
Zeekr 001 — Start: да; Comfort+: 2021+; Business: 2021+; Premier: да; Electro: да
Zeekr 007 — Start: да; Comfort+: 2023+; Business: 2023+; Premier: да; Electro: да
Zeekr 009 — Start: да; Comfort+: 2022+; Business: 2022+; Premier: да; Electro: да



⸻

14. ЗАҚАЗ БЎЙИЧА ЁРДАМ (КУРЬЕР/ДОСТАВКА)

Агар ҳайдовчи сўраса:

“Курьерлар одатда таом, маҳсулотлар, кийим, ҳужжат, техника ва дўкон/кафелардан турли посилкаларни етказиб беришади.”

⸻

15. ЗАБРАНЕННЫЕ ФРАЗЫ

Ассистент ҳеч қачон ёзмайди:
• “ботман”, “AIман”
• “хатолик рўй берди”
• “қайта уриниб кўринг”
• “мен тушунмайман, дерем”

⸻

16. СУҲБАТ СТИЛИ — ФАҚАТ ИНСОНДЕК
	•	табиий, мулойим, қисқа
	•	эслаб тур: мақсад — рўйхатдан ўтказиш
	•	ортиқча матн ва роботга ўхшаш жумлалар йўқ

────────────────────────────────────────

`;
 const formatPrompt = `
СЕЙЧАС ОЧЕНЬ ВАЖНО: отвечай СТРОГО одним JSON-объектом БЕЗ форматирования кода, 
БЕЗ тройных кавычек и блоков \`\`\`.

Формат:
{
  "reply": "текст для клиента на его языке",
  "handover": false,
  "operator_note": "краткое пояснение для оператора (по-русски)"
}

• reply — то, что увидит клиент в Instagram. Если нужно передать диалог оператору, сразу напиши об этом клиенту и попроси немного подождать.
• handover — ставь true, если по правилам выше нужно подключать живого оператора. Во всех других случаях — false.
• operator_note — одно-два предложения для оператора: кто клиент, по какому вопросу обратился, что уже объяснил, какие данные получил (авто, год, тариф и т.п.). Если оператор не нужен, оставь пустую строку "".

Никакого другого формата, только этот JSON.
`;

 let fullUserContent;
    if (safeContext) {
      fullUserContent =
        "Предыдущая переписка с этим клиентом (усечённая):\n" +
        safeContext +
        "\n\nНовое сообщение клиента:\n" +
        userMessage;
    } else {
      fullUserContent = userMessage;
    }

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "system", content: formatPrompt },
      { role: "user", content: fullUserContent },
    ];

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages,
        temperature: 0.7,

        response_format: { type: "json_object" },
      }),
    });

if (!response.ok) {
  const errText = await response.text();
  console.error("OpenAI error:", response.status, errText);
  return {
    reply: "По этому вопросу лучше подключить оператора, чуть подождите 🙏",
    handover: 1,
    operator_note: `Ошибка OpenAI (${response.status}). Нужен ответ оператора. Последнее сообщение клиента: ${userMessage}`,
  };
}


    const data = await response.json();
    let raw = data.choices?.[0]?.message?.content?.trim() || "";

    console.log("Raw OpenAI answer:", raw);


    if (raw.startsWith("```")) {
      raw = raw
        .replace(/^```[a-zA-Z]*\s*/i, "") 
        .replace(/```$/i, "")            
        .trim();
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error("Failed to parse JSON from OpenAI:", e, "raw:", raw);
return {
  reply: "По этому вопросу лучше подключить оператора, чуть подождите 🙏",
  handover: 1,
  operator_note: `Ошибка в generateReply. Нужен ответ оператора. Последнее сообщение клиента: ${userMessage}`,
};

    }

    // Исходный ответ от модели
    const replyRaw =
      typeof parsed.reply === "string"
        ? parsed.reply.trim()
        : "Не удалось сформировать ответ 😔";

    let reply = replyRaw;

    // Тот самый двуязычный текст, который бот постоянно повторяет
    const bilingualTrigger =
      "Вам на каком языке удобнее общаться — русским или узбекском?";

    // Если модель снова прислала этот текст,
    // а в контексте он уже есть — переписываем ответ вручную
    if (
      reply.startsWith(bilingualTrigger) &&
      safeContext.includes(bilingualTrigger)
    ) {
      const fullText = (safeContext + " " + userMessage).toLowerCase();

      // Пытаемся понять, что человек выбрал узбекский
      const prefersUz =
        /uzbek|ozbek|o'zbek|ўзбек|узбек|uzb|özbek|ozb/.test(fullText);

      if (prefersUz) {
        // Короткий вариант на узбекском
        reply =
          "Келинг, ўзбек тилида ёзаман. Илтимос, техник паспортдаги каби автомобил моделини ва чиқарилган йилни ёзиб юборанг. Шунда қайси тарифга тушишини ва бонусларни аниқ айта оламан.";
      } else {
        // Короткий вариант на русском
        reply =
          "Хорошо, давайте на русском. Напишите, пожалуйста, точное название модели вашего авто и год выпуска — как в техпаспорте. Я подскажу, в какой тариф подходит машина и какие есть бонусы.";
      }

      console.log(
        "Bilingual greeting was repeated — replaced with short variant"
      );
    }

    const handover = parsed.handover ? 1 : 0;
    const operatorNote =
      typeof parsed.operator_note === "string"
        ? parsed.operator_note.trim()
        : "";

    return {
      reply,
      handover,
      operator_note: operatorNote,
    };

  } catch (e) {
    console.error("generateReply error:", e);
    return {
      reply: "Что-то пошло не так, попробуйте ещё раз позже 🙏",
      handover: 0,
      operator_note: "",
    };
  }
}