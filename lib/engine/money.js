const round = (n, to = 1) => Math.round(n / to) * to;
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
function median(xs) {
    if (!xs.length)
        return 0;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function fmt(n) {
    const v = Math.round(n);
    return (v < 0 ? "-" : "") + "$" + Math.abs(v).toLocaleString("en-US");
}
const DAY = 86_400_000;
const toDate = (iso) => new Date(iso + "T00:00:00Z");
const toISO = (d) => d.toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / DAY);
const addDays = (iso, n) => toISO(new Date(toDate(iso).getTime() + n * DAY));
function addMonths(iso, n) {
    const d = toDate(iso);
    d.setUTCMonth(d.getUTCMonth() + n);
    return toISO(d);
}
/** Future value of `annual` contributed each year for `years` at `rate`. 10y at 7% = 13.816x. */
function futureValueOfAnnual(annual, years = 10, rate = 0.07) {
    return annual * ((Math.pow(1 + rate, years) - 1) / rate);
}

module.exports = { round, sum, median, fmt, toDate, toISO, daysBetween, addDays, addMonths, futureValueOfAnnual };
