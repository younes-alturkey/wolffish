/** Opaque cursor <-> { sortKey, id }. */
export function encodeCursor({ sortKey, id }) {
  return Buffer.from(JSON.stringify([sortKey, id])).toString('base64url');
}

export function decodeCursor(cursor) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    throw new Error('malformed cursor');
  }
  if (!Array.isArray(parsed)) throw new Error('malformed cursor');
  const [sortKey] = parsed;
  return { sortKey };
}
