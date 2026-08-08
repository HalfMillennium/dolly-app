/**
 * Build the sample Recording from the real product markup using the actual selector engine, so
 * the demo's locators are exactly what the recorder would have produced. Callers pass the document
 * the recording should target (the live page's `document`, or a jsdom doc in the test).
 */
import { describe as locate } from "@dolly/selector";
import type { Recording, Step } from "@dolly/schema";

export function buildSampleRecording(doc: Document): Recording {
  const q = (sel: string): Element => {
    const el = doc.querySelector(sel);
    if (!el) throw new Error(`sample: missing ${sel}`);
    return el;
  };

  const steps: Step[] = [
    {
      id: "s1",
      t: 0.6,
      action: "input",
      target: locate(q('[data-testid="display-name"]'), doc),
      value: "Ada Lovelace",
      liveMode: "auto",
      caption: "Type your display name",
    },
    {
      id: "s2",
      t: 1.8,
      action: "change",
      target: locate(q('[data-testid="plan"]'), doc),
      value: "pro",
      liveMode: "auto",
      caption: "Choose the Pro plan",
    },
    {
      id: "s3",
      t: 2.7,
      action: "click",
      target: locate(q('[data-testid="newsletter"]'), doc),
      liveMode: "auto",
      caption: "Opt in to product updates",
    },
    {
      id: "s4",
      t: 3.6,
      action: "submit",
      target: locate(q('[data-testid="save"]'), doc),
      liveMode: "coach",
      caption: "Save your changes",
    },
  ];

  return {
    version: 1,
    id: "sample-cloudnotes",
    title: "Set up your CloudNotes account",
    createdAt: "2026-01-01T00:00:00.000Z",
    startUrl: "https://cloudnotes.example/settings",
    viewport: { w: 1280, h: 800 },
    steps,
  };
}
