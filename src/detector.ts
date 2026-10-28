import type { Incident } from "@lorenzh/pulse-contract";
import type { NotificationEvent } from "./types.ts";

export interface DetectedEvent {
  key: string;
  event: NotificationEvent;
  incident: Incident;
}

export function eventKey(incidentId: number, event: NotificationEvent): string {
  return `${incidentId}:${event}`;
}

/**
 * Events not yet handled. `handled(key)` says whether the key is recorded or queued.
 * A resolved incident yields `opened` first when its `opened` was never recorded.
 */
export function detectEvents(
  incidents: Incident[],
  handled: (key: string) => boolean,
): DetectedEvent[] {
  const events: DetectedEvent[] = [];
  for (const incident of incidents) {
    const opened = eventKey(incident.id, "opened");
    if (!handled(opened)) events.push({ key: opened, event: "opened", incident });
    if (incident.resolvedAt != null) {
      const resolved = eventKey(incident.id, "resolved");
      if (!handled(resolved)) events.push({ key: resolved, event: "resolved", incident });
    }
  }
  return events;
}

/** Keys that count as handled for all currently visible incidents. */
export function seedKeys(incidents: Incident[]): string[] {
  const keys: string[] = [];
  for (const incident of incidents) {
    keys.push(eventKey(incident.id, "opened"));
    if (incident.resolvedAt != null) keys.push(eventKey(incident.id, "resolved"));
  }
  return keys;
}
