/**
 * Comparator for one sort field. Rows that compare equal on the field fall
 * back to a deterministic secondary order so sorting is stable across calls.
 */
export function compareBy(field, dir = 'asc') {
  const sign = dir === 'desc' ? -1 : 1;
  return (a, b) => {
    const x = a[field];
    const y = b[field];
    if (x < y) return -sign;
    if (x > y) return sign;
    return a._seq - b._seq;
  };
}
