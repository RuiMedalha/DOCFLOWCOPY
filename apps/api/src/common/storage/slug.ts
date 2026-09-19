/**
 * slugify — fold a free-text string into a URL/path-safe form.
 *
 * Diacritics are folded to ASCII BEFORE the dash collapse, so
 * "Américo Alves" → "americo-alves" rather than "am-rico-alves".
 * Unicode NFD decomposition + combining-mark strip covers accented Latin
 * without pulling in a locale-data dependency.
 *
 * Rules (Sprint E):
 *   - NFD + strip combining marks
 *   - Collapse `[^a-z0-9]+` → `-`
 *   - Trim leading/trailing dashes
 *   - Lowercase
 *   - Cap 60 chars
 *   - Empty input → `null` (caller decides fallback)
 */
export function slugify(input: string | null | undefined): string | null {
  if (input == null) return null;
  const cleaned = input.replace(/\0/g, '').trim();
  if (!cleaned) return null;
  const folded = cleaned.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const slugged = folded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slugged || null;
}
