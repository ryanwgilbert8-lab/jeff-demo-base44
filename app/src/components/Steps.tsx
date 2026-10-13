const ORDER = ["connect", "income", "living", "plan"] as const;

export function Steps({ at }: { at: (typeof ORDER)[number] }) {
  const i = ORDER.indexOf(at);
  return <div className="steps" aria-label={`Step ${i + 1} of ${ORDER.length}`}>{ORDER.map((s, n) => <i key={s} className={n <= i ? "on" : ""} />)}</div>;
}
