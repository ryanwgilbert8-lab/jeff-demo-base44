// Reads required server env vars lazily so a missing one fails the request that needs it,
// with a clear message, instead of crashing the whole app at import time.
export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}. See app/.env.example.`);
  return v;
}
