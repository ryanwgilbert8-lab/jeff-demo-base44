export const round = (n: number, to = 1) => Math.round(n / to) * to;
export const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function fmt(n: number): string {
  const v = Math.round(n);
  return (v < 0 ? "-" : "") + "$" + Math.abs(v).toLocaleString("en-US");
}

const DAY = 86_400_000;
export const toDate = (iso: string) => new Date(iso + "T00:00:00Z");
export const toISO = (d: Date) => d.toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / DAY);
export const addDays = (iso: string, n: number) => toISO(new Date(toDate(iso).getTime() + n * DAY));

export function addMonths(iso: string, n: number): string {
  const d = toDate(iso);
  d.setUTCMonth(d.getUTCMonth() + n);
  return toISO(d);
}

/** Future value of `annual` contributed each year for `years` at `rate`. 10y at 7% = 13.816x. */
export function futureValueOfAnnual(annual: number, years = 10, rate = 0.07): number {
  return annual * ((Math.pow(1 + rate, years) - 1) / rate);
}
