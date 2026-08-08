/**
 * A mock product UI ("CloudNotes account settings") used by both the live demo page and the
 * integration test. Keeping the markup in one exported string means the test drives the exact DOM
 * the page ships, so a green test reflects the real embed.
 */
export const PRODUCT_HTML = `
  <div class="app" style="max-width:520px;margin:0 auto;font-family:system-ui,sans-serif">
    <h1 style="font-size:20px">CloudNotes — Account settings</h1>
    <form id="settings" style="display:flex;flex-direction:column;gap:14px">
      <label style="display:flex;flex-direction:column;gap:4px">
        <span>Display name</span>
        <input data-testid="display-name" name="displayName" placeholder="Your name" />
      </label>

      <label style="display:flex;flex-direction:column;gap:4px">
        <span>Plan</span>
        <select data-testid="plan" name="plan">
          <option value="free">Free</option>
          <option value="pro">Pro</option>
          <option value="team">Team</option>
        </select>
      </label>

      <label style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" data-testid="newsletter" name="newsletter" />
        <span>Email me product updates</span>
      </label>

      <button type="submit" data-testid="save" class="btn-primary">Save changes</button>
    </form>
    <p id="result" role="status" aria-live="polite"></p>
  </div>
`;

/** Wire the mock form so "Save" shows a confirmation — lets the live demo prove real dispatch. */
export function wireProduct(doc: Document): void {
  const form = doc.querySelector<HTMLFormElement>("#settings");
  const result = doc.querySelector<HTMLElement>("#result");
  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = new FormData(form);
    if (result) {
      result.textContent = `Saved: ${data.get("displayName") || "(no name)"} · ${data.get("plan")} · updates ${
        data.get("newsletter") ? "on" : "off"
      }`;
      result.style.color = "#15803d";
    }
  });
}
