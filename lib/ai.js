// The financial brain: server-side calls to the Anthropic API. Without ANTHROPIC_API_KEY
// the app still runs in scripted mode (the client falls back to its scripted flows).
const KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.JEFF_MODEL || "claude-haiku-4-5-20251001";

const enabled = () => !!KEY;

async function complete({ system, prompt, maxTokens = 700 }) {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: prompt }]
      })
    });
    if (!r.ok) {
      console.error("Anthropic API error:", r.status);
      return null;
    }
    const j = await r.json();
    return (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  } catch (e) {
    console.error("Anthropic request failed:", e.message);
    return null;
  }
}

module.exports = { enabled, complete };
