import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { loadFinances } from "@/lib/data";
import { factsFor, JEFF_MODEL, streamJeff } from "@/lib/jeff";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

const Body = z.object({ message: z.string().trim().min(1).max(2000) });
const FALLBACK = "Sorry, I couldn't answer that just now. Try again in a minute.";

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_request" }, { status: 400 });

  const f = await loadFinances();
  const db = supabaseAdmin();
  const userId = f.user.id;

  const { data: past } = await f.supabase.from("messages").select("role, content").eq("user_id", userId).order("created_at", { ascending: false }).limit(30);
  const history: Anthropic.Beta.BetaMessageParam[] = (past ?? []).reverse().map(m => ({ role: m.role, content: m.content }));
  while (history.length && history[0].role !== "user") history.shift();
  history.push({ role: "user", content: parsed.data.message });
  await db.from("messages").insert({ user_id: userId, role: "user", content: parsed.data.message });

  const stream = streamJeff(factsFor(f), history);
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let text = "";
      try {
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            text += event.delta.text;
            controller.enqueue(encoder.encode(event.delta.text));
          }
        }
        const final = await stream.finalMessage();
        if (final.stop_reason === "refusal" || !text.trim()) {
          const msg = text.trim() ? "" : FALLBACK;
          if (msg) controller.enqueue(encoder.encode(msg));
          text = text.trim() || FALLBACK;
        }
        await db.from("messages").insert({ user_id: userId, role: "assistant", content: text });
        await db.from("audit_log").insert({ user_id: userId, actor: "jeff", action: "replied", payload: { model: final.model, requested: JEFF_MODEL, stop: final.stop_reason, usage: final.usage } });
      } catch (err) {
        console.error("jeff stream failed", err instanceof Anthropic.APIError ? `${err.status} ${err.message}` : err);
        if (!text) controller.enqueue(encoder.encode(FALLBACK));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
