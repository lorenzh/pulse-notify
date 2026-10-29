import type { Incident } from "@lorenzh/pulse-contract";
import type { NotificationEvent } from "./types.ts";

export interface DetectedEvent {
  key: string;
  event: NotificationEvent;
  incident: Incident;
}

/** When reminders are due: every `everyMs` after an incident opened, judged at `nowMs`. */
export interface ReminderPlan {
  everyMs: number;
  nowMs: number;
}

export function eventKey(incidentId: number, event: "opened" | "resolved"): string {
  return `${incidentId}:${event}`;
}

export function reminderKey(incidentId: number, n: number): string {
  return `${incidentId}:reminder:${n}`;
}

/** The time an event is about: `openedAt`, `resolvedAt`, or now for a reminder. */
export function eventTimeMs(event: NotificationEvent, incident: Incident, nowMs: number): number {
  switch (event) {
    case "opened":
      return incident.openedAt;
    case "resolved":
      return incident.resolvedAt as number;
    case "reminder":
      return nowMs;
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

/** The index of the latest reminder due for an open incident; 0 means none yet. */
function dueReminder(incident: Incident, plan: ReminderPlan): number {
  return Math.max(0, Math.floor((plan.nowMs - incident.openedAt) / plan.everyMs));
}

/**
 * Events not yet handled. `handled(key)` says whether the key is recorded or queued.
 * A resolved incident yields `opened` first when its `opened` was never recorded.
 * With a reminder plan, an open incident yields only its latest due reminder, never the
 * ones that were missed before it.
 */
export function detectEvents(
  incidents: Incident[],
  handled: (key: string) => boolean,
  reminders?: ReminderPlan,
): DetectedEvent[] {
  const events: DetectedEvent[] = [];
  for (const incident of incidents) {
    const opened = eventKey(incident.id, "opened");
    const isOpenedHandled = handled(opened);
    if (!isOpenedHandled) events.push({ key: opened, event: "opened", incident });
    if (incident.resolvedAt != null) {
      const resolved = eventKey(incident.id, "resolved");
      if (!handled(resolved)) events.push({ key: resolved, event: "resolved", incident });
    } else if (reminders && isOpenedHandled) {
      const n = dueReminder(incident, reminders);
      const key = reminderKey(incident.id, n);
      if (n >= 1 && !handled(key)) events.push({ key, event: "reminder", incident });
    }
  }
  return events;
}

/** Keys that count as handled for all currently visible incidents. */
export function seedKeys(incidents: Incident[], reminders?: ReminderPlan): string[] {
  const keys: string[] = [];
  for (const incident of incidents) {
    keys.push(eventKey(incident.id, "opened"));
    if (incident.resolvedAt != null) {
      keys.push(eventKey(incident.id, "resolved"));
    } else if (reminders) {
      const n = dueReminder(incident, reminders);
      if (n >= 1) keys.push(reminderKey(incident.id, n));
    }
  }
  return keys;
}
