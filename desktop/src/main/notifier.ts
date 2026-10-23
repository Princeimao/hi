// Windows toasts for the moments that matter: a pending approval ("wants to
// use Bash …") and a session that finishes or fails while you are elsewhere.
// Clicking a toast raises the island and grows it to the card; nothing here
// ever decides an approval.

import { Notification, BrowserWindow } from "electron";

const LAST_STATUS = new Map<string, string>();

/// Click route is owned by the caller so the paper trail stays in main.ts.
export type OpenCard = () => void;
let openCard: OpenCard = () => {};

export function wireNotifications(handler: OpenCard): void {
  openCard = handler;
}

export function pushActionNotifications(
  actions: { type: string; [key: string]: unknown }[],
): void {
  for (const action of actions) {
    if (action.type === "approval.begin") {
      const approval = action["approval"] as { tool?: string; command?: string } | undefined;
      notify(
        "Waits for you",
        approval?.tool
          ? `${approval.tool}: ${truncate(approval.command ?? "")}`.trim()
          : "A permission request is waiting",
        true,
      );
      continue;
    }
    if (action.type !== "session.updated" && action.type !== "session.started") continue;
    const session = action["session"] as
      | { id: string; status: string; projectName?: string }
      | undefined;
    if (!session || typeof session.status !== "string") continue;
    const prev = LAST_STATUS.get(session.id);
    LAST_STATUS.set(session.id, session.status);
    if (prev === undefined) continue; // an old session replaying events
    if (session.status === "finished" && prev !== "finished") {
      notify(`${session.projectName ?? "Session"} finished`, "The agent has completed its run", false);
    } else if (session.status === "error" && prev !== "error") {
      notify(`${session.projectName ?? "Session"} failed`, "The agent hit an error", false);
    }
  }
}

function notify(title: string, body: string, urgent: boolean): void {
  if (!Notification.isSupported()) return;
  // Only requests that need input pop to the front; quiet ones just appear
  // in the action centre.
  const n = new Notification({ title, body, silent: !urgent });
  n.on("click", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
    }
    openCard();
  });
  n.show();
}

function truncate(input: string, max = 90): string {
  return input.length > max ? `${input.slice(0, max)}…` : input;
}
