// netlify/functions/pbx-hook.js

async function startScenario({ ruleId, customData }) {
  const accountId = process.env.VOX_ACCOUNT_ID;
  const apiKey = process.env.VOX_API_KEY;

  if (!accountId || !apiKey) {
    throw new Error("Missing VOX_* env vars (VOX_ACCOUNT_ID, VOX_API_KEY)");
  }

  const url = new URL("https://api.voximplant.com/platform_api/StartScenarios");
  url.searchParams.set("account_id", String(accountId));
  url.searchParams.set("api_key", String(apiKey));
  url.searchParams.set("rule_id", String(ruleId));
  url.searchParams.set("script_custom_data", JSON.stringify(customData || {}));

  const resp = await fetch(url.toString(), { method: "POST" });

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
    const contentType = event.headers["content-type"] || event.headers["Content-Type"] || "";
    const query = event.queryStringParameters || {};

    let body = {};
    if (event.body) {
      if (contentType.includes("application/json")) body = JSON.parse(event.body);
      else body = { raw: event.body };
    }

    const from =
      query.from || query.caller || query.ani ||
      body.from || body.caller || body.ani || body.src ||
      null;

    const to =
      query.to || query.called || query.dnis ||
      body.to || body.called || body.dnis || body.dst ||
      null;

    const direction = query.direction || body.direction || "inbound";

    const ruleId = process.env.VOX_RULE_ID;
    if (!ruleId) throw new Error("Missing VOX_RULE_ID env var");

    const result = await startScenario({
      ruleId,
      customData: { direction, from, to, pbx: { query, body } },
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
