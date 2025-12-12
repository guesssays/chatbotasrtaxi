// netlify/functions/pbx-hook.js
const jwt = require("jsonwebtoken");

function makeVoxJwt() {
  const accountId = Number(process.env.VOX_ACCOUNT_ID);
  const keyId = process.env.VOX_KEY_ID;
  const privateKey = (process.env.VOX_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  if (!accountId || !keyId || !privateKey) {
    throw new Error("Missing VOX_* env vars (VOX_ACCOUNT_ID, VOX_KEY_ID, VOX_PRIVATE_KEY)");
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now, iss: accountId, exp: now + 3600 };

  return jwt.sign(payload, privateKey, {
    algorithm: "RS256",
    header: { typ: "JWT", kid: keyId },
  });
}

async function startScenario({ ruleId, customData }) {
  const token = makeVoxJwt();

  // StartScenarios принимает rule_id + script_custom_data
  const url = new URL("https://api.voximplant.com/platform_api/StartScenarios");
  url.searchParams.set("rule_id", String(ruleId));
  url.searchParams.set("script_custom_data", JSON.stringify(customData || {}));

  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });

  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!resp.ok) {
    throw new Error(`Voximplant StartScenarios failed: ${resp.status} ${text}`);
  }
  return json;
}

exports.handler = async (event) => {
  try {
    // 1) Логируем всё максимально прозрачно (первые тесты это спасёт)
    const contentType = event.headers["content-type"] || event.headers["Content-Type"] || "";
    const query = event.queryStringParameters || {};

    let body = {};
    if (event.body) {
      if (contentType.includes("application/json")) {
        body = JSON.parse(event.body);
      } else {
        // если OnlinePBX присылает form-urlencoded/текст
        body = { raw: event.body };
      }
    }

    // 2) Пытаемся вытащить номер звонящего из любых возможных полей
    const from =
      query.from || query.caller || query.ani ||
      body.from || body.caller || body.ani || body.src ||
      null;

    const to =
      query.to || query.called || query.dnis ||
      body.to || body.called || body.dnis || body.dst ||
      null;

    const direction = query.direction || body.direction || "inbound";

    // 3) Стартуем сценарий VoxImplant
    const ruleId = process.env.VOX_RULE_ID; // мы зададим в Netlify env
    if (!ruleId) throw new Error("Missing VOX_RULE_ID env var");

    const result = await startScenario({
      ruleId,
      customData: {
        direction,
        from,
        to,
        // можно прокинуть вообще всё, чтобы потом в VoxEngine customData() разобрать
        pbx: { query, body },
      },
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, result }),
    };
  } catch (e) {
    console.error("pbx-hook error:", e);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: String(e?.message || e) }),
    };
  }
};
