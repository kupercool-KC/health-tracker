/**
 * Combines a shared caption with one optional note per attached photo into a
 * single text block — "Photo N: <note>" lines, in the same order the images
 * are uploaded, so the model can tell which comment belongs to which image
 * without any change to the API's plain `text` field. Used by both Today's
 * "Add a meal" form and the chat panel's multi-photo attach.
 */
export function combinePhotoCaptions(mainText: string, captions: string[]): string {
  const lines = captions
    .map((c, i) => (c.trim() ? `Photo ${i + 1}: ${c.trim()}` : null))
    .filter((l): l is string => l !== null);
  return [mainText.trim(), ...lines].filter(Boolean).join("\n");
}
