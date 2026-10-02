const pad = (n) => String(n).padStart(2, '0');

/** Day key (YYYY-MM-DD) for an instant given as a Date or an ISO string. */
export function dayKey(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid instant: ${input}`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Validate a YYYY-MM-DD key and return its numeric parts. */
export function parseKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key));
  if (!m) throw new Error(`invalid day key: ${key}`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}
