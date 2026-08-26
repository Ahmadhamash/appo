const arabicIndicDigits: Readonly<Record<string, string>> = {
  "٠": "0",
  "١": "1",
  "٢": "2",
  "٣": "3",
  "٤": "4",
  "٥": "5",
  "٦": "6",
  "٧": "7",
  "٨": "8",
  "٩": "9",
  "۰": "0",
  "۱": "1",
  "۲": "2",
  "۳": "3",
  "۴": "4",
  "۵": "5",
  "۶": "6",
  "۷": "7",
  "۸": "8",
  "۹": "9",
};

function toAsciiDigits(value: string): string {
  return [...value].map((character) => arabicIndicDigits[character] ?? character).join("");
}

/**
 * Converts only unambiguous Jordanian input forms to E.164. Unknown or malformed values return
 * null so callers retain the original value instead of guessing a phone identity.
 */
export function normalizeJordanianPhone(input: string): string | null {
  const ascii = toAsciiDigits(input.trim());
  if (!/^[+0-9\s().-]+$/.test(ascii)) {
    return null;
  }
  let compact = ascii.replace(/[\s().-]/g, "");
  if (compact.startsWith("00")) {
    compact = `+${compact.slice(2)}`;
  }
  if (!compact.startsWith("+")) {
    if (compact.startsWith("0")) {
      compact = `+962${compact.slice(1)}`;
    } else if (compact.startsWith("962")) {
      compact = `+${compact}`;
    } else {
      return null;
    }
  }
  if (!/^\+962\d+$/.test(compact)) {
    return null;
  }
  const nationalNumber = compact.slice(4);
  if (!/^[2-9]\d{7,8}$/.test(nationalNumber)) {
    return null;
  }
  return compact;
}
