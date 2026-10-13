"use client";
import { useEffect, useRef, useState } from "react";

type Msg = { role: "user" | "assistant"; content: string };

const STARTERS = ["What do I do with my next commission?", "Can I afford a $400 weekend trip?", "Why this order?"];

export function JeffChat({ initial, greeting }: { initial: Msg[]; greeting: string }) {
  const [msgs, setMsgs] = useState<Msg[]>(initial);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [msgs]);

  async function send(message: string) {
    if (!message.trim() || busy) return;
    setBusy(true);
    setText("");
    setMsgs(m => [...m, { role: "user", content: message }, { role: "assistant", content: "" }]);
    try {
      const res = await fetch("/api/jeff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message }) });
      if (!res.ok || !res.body) throw new Error();
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        setMsgs(m => [...m.slice(0, -1), { role: "assistant", content: m[m.length - 1].content + chunk }]);
      }
    } catch {
      setMsgs(m => [...m.slice(0, -1), { role: "assistant", content: "I couldn't reach the server. Try again in a minute." }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="dock" aria-label="Talk to Jeff">
      <div className="log" ref={log} aria-live="polite">
        {!msgs.length && <div><p className="who">Jeff</p><p className="jf" style={{ margin: 0 }}>{greeting}</p></div>}
        {msgs.map((m, i) => m.role === "user"
          ? <div key={i} className="me">{m.content}</div>
          : <div key={i}><p className="who">Jeff</p><p className="jf" style={{ margin: 0 }}>{m.content || "…"}</p></div>)}
      </div>
      {!msgs.length && <div className="chips">{STARTERS.map(s => <button key={s} type="button" onClick={() => send(s)}>{s}</button>)}</div>}
      <form onSubmit={e => { e.preventDefault(); send(text); }}>
        <input value={text} onChange={e => setText(e.target.value)} placeholder="Ask Jeff anything about your money" aria-label="Message Jeff" maxLength={2000} />
        <button disabled={busy || !text.trim()}>Send</button>
      </form>
    </section>
  );
}
