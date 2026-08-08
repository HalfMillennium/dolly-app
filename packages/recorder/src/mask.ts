/**
 * Sensitive-value masking. A recorder must never capture secrets: passwords, card numbers,
 * tokens, and anything the author opted out of via `[data-dolly-secret]`. Masking runs at
 * capture time so raw secrets never enter the step log.
 */

const SENSITIVE_NAME = /pass|secret|token|otp|cvv|cvc|card|ccnum|cc-num|ssn|social|pin\b|routing|account/i;
const SENSITIVE_AUTOCOMPLETE = /(cc-|current-password|new-password|one-time-code)/i;

/** True if this control's value should be masked. */
export function isSensitive(el: Element): boolean {
  const input = el as HTMLInputElement;
  const type = (input.getAttribute?.("type") ?? "").toLowerCase();
  if (type === "password") return true;
  if (el.closest?.("[data-dolly-secret]")) return true;
  if (el.getAttribute?.("data-dolly-secret") !== null && el.hasAttribute?.("data-dolly-secret")) return true;
  const auto = (el.getAttribute?.("autocomplete") ?? "").toLowerCase();
  if (auto && SENSITIVE_AUTOCOMPLETE.test(auto)) return true;
  const name = el.getAttribute?.("name") ?? "";
  const id = el.getAttribute?.("id") ?? "";
  const aria = el.getAttribute?.("aria-label") ?? "";
  if (SENSITIVE_NAME.test(`${name} ${id} ${aria}`)) return true;
  return false;
}

/** Replace a value with a length-preserving mask (so the playback still "types" something). */
export function maskValue(value: string): string {
  return value.length === 0 ? "" : "•".repeat(Math.min(value.length, 24));
}
