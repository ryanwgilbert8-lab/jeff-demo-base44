// Jeff demo server: serves the app and gives Jeff live AI replies through the Anthropic API.
// Add ANTHROPIC_API_KEY as a secret in Base44. Without it, the demo still runs in scripted mode.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.JEFF_MODEL || "claude-haiku-4-5-20251001";
const html = fs.readFileSync(path.join(__dirname, "public", "index.html"));
// Public by design: Supabase's publishable key only allows what the database's row-level security permits.
const SUPABASE_URL = process.env.SUPABASE_URL || "https://ihnmryaakdgqebrwgfsb.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_bTA__NaqrH7c53opWgPVjw_kudnC20F";
const VENDOR = { "/vendor/supabase-2.117.3.js": fs.readFileSync(path.join(__dirname, "public", "vendor", "supabase-2.117.3.js")) };

function send(res, code, type, body, extra) {
  res.writeHead(code, { "Content-Type": type, "X-Content-Type-Options": "nosniff", ...extra });
  res.end(body);
}

http.createServer(async (req, res) => {
  if (req.method === "GET" && VENDOR[req.url]) {
    return send(res, 200, "text/javascript; charset=utf-8", VENDOR[req.url], { "Cache-Control": "public, max-age=31536000, immutable" });
  }
  if (req.method === "GET" && req.url === "/api/config") {
    return send(res, 200, "application/json", JSON.stringify({ supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY }), { "Cache-Control": "no-store" });
  }
  if (req.method === "GET" && req.url === "/api/health") {
    return send(res, 200, "application/json", JSON.stringify({ ai: !!KEY }));
  }
  if (req.method === "POST" && req.url === "/api/jeff") {
    if (!KEY) return send(res, 503, "application/json", "{}");
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const { prompt } = JSON.parse(body);
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL, max_tokens: 400, messages: [{ role: "user", content: String(prompt).slice(0, 20000) }] })
      });
      const j = await r.json();
      const text = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
      const match = text.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
      JSON.parse(match ? match[0] : "{}");
      return send(res, 200, "application/json", match ? match[0] : "{}");
    } catch (e) {
      return send(res, 500, "application/json", "{}");
    }
  }
  send(res, 200, "text/html; charset=utf-8", html);
}).listen(PORT, "0.0.0.0", () => console.log(`Jeff demo running on port ${PORT}`));
