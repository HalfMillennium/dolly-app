/**
 * Demo page wiring: render the mock product, register the <dolly-walkthrough> element, build the
 * sample recording from the live DOM, and hook up the Coach / Auto-run / Drift controls.
 */
import { registerWalkthroughElement, type DollyWalkthroughElement } from "@dolly/player";
import { PRODUCT_HTML, wireProduct } from "./product.js";
import { buildSampleRecording } from "./sample.js";

registerWalkthroughElement();

const product = document.getElementById("product")!;
product.innerHTML = PRODUCT_HTML;
wireProduct(document);

const dolly = document.getElementById("dolly") as DollyWalkthroughElement;
dolly.recording = buildSampleRecording(document);

function run(mode: "auto" | "coach"): void {
  dolly.setAttribute("live-default", mode);
  void dolly.play();
}

document.getElementById("coach")?.addEventListener("click", () => run("coach"));
document.getElementById("auto")?.addEventListener("click", () => run("auto"));

// Simulate real-world drift: rename testids/ids so exact locators miss and self-heal must kick in.
document.getElementById("drift")?.addEventListener("click", () => {
  document.querySelectorAll("[data-testid]").forEach((el) => {
    const v = el.getAttribute("data-testid");
    if (v) {
      el.setAttribute("data-testid", `${v}-v2-${Math.floor(Math.random() * 999)}`);
    }
  });
  const form = document.getElementById("settings");
  form?.setAttribute("id", "settings-panel");
  alert("Renamed ids & test-ids. Run the walkthrough again — self-healing will still find each field.");
});
