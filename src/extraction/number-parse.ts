// ---------------------------------------------------------------------------
// Shared number parsing for PDF table text (Swedish / English formats).
// ---------------------------------------------------------------------------

export function parseNumber(raw: string): number | null {
  let s = raw.trim();

  s = s.replace(/^[^0-9(–−-]+/, '');
  if (s.length === 0) return null;

  const isAccountingNeg = s.startsWith('(') && s.includes(')');
  if (isAccountingNeg) s = s.replace(/\(/, '').replace(/\)/, '');

  const hasMinusPrefix = /^[-–−]/.test(s);
  if (hasMinusPrefix) s = s.replace(/^[-–−]\s*/, '');

  const commaMatch = s.match(/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?/);
  if (commaMatch) {
    s = commaMatch[0].replace(/,/g, '');
  } else {
    s = s.replace(/[^0-9.,]+$/, '');
    if (s.length === 0) return null;

    s = s.replace(/(?<=\d) (?=\d{3}(?!\d))/g, '');

    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');

    if (lastComma > lastDot) {
      const afterComma = s.substring(lastComma + 1);
      if (afterComma.length <= 2) {
        s = s.replace(/\./g, '').replace(',', '.');
      } else {
        s = s.replace(/,/g, '');
      }
    } else {
      s = s.replace(/,/g, '');
    }
  }

  if (!/^\d+(\.\d+)?$/.test(s)) return null;

  const value = parseFloat(s);
  if (isNaN(value) || !isFinite(value)) return null;

  return isAccountingNeg || hasMinusPrefix ? -value : value;
}
