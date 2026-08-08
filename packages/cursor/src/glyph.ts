/** Cursor glyph geometry. Path2D is created lazily so importing this module is safe under jsdom. */

export const ARROW_PATH_D = "M2 1 L2 20 L7 15.5 L10.4 22 L13 20.8 L9.7 14.6 L15.5 14.6 Z";
/** The glyph paths are authored in a 24×24 box, tip at the origin corner. */
export const GLYPH_UNITS = 24;
/** Nominal on-screen glyph height in CSS px before size scaling. */
export const GLYPH_PX = 22;

let cached: Path2D | null = null;

/** The arrow as a Path2D, or null when Path2D is unavailable (non-browser). */
export function arrowPath(): Path2D | null {
  if (typeof Path2D === "undefined") return null;
  if (!cached) cached = new Path2D(ARROW_PATH_D);
  return cached;
}
