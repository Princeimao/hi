import { useSyncExternalStore } from "react";
import type { Action, ApprovalView, SessionView, Snapshot } from "./api";

// The island's one-way push: the main process is the source of truth, and this
// tiny store is all the renderer knows.

class Store {
  snapshot: Snapshot = { sessions: [], pending: null, paused: false };
  version = 0;
  private listeners = new Set<() => void>();
  private ready = false;

  init() {
    if (this.ready) return;
    this.ready = true;
    void window.hi.snapshot().then((snap) => {
      this.snapshot = snap;
      this.version++;
      this.listeners.forEach((l) => l());
    });
    window.hi.onActions((actions) => this.apply(actions));
  }

  apply(actions: Action[]) {
    const snap = this.snapshot;
    const sessions = new Map(snap.sessions.map((s) => [s.id, s]));
    let pending: ApprovalView | null = snap.pending;

    for (const a of actions) {
      if (a.type === "session.started" || a.type === "session.updated") {
        const session = a["session"] as SessionView;
        sessions.set(session.id, session);
      } else if (a.type === "session.removed") {
        sessions.delete(String(a["id"]));
      } else if (a.type === "approval.begin") {
        pending = a["approval"] as ApprovalView;
      } else if (a.type === "approval.drop") {
        if (pending && String(a["requestId"]) === pending.requestId) pending = null;
      }
    }
    this.snapshot = { sessions: [...sessions.values()], pending, paused: snap.paused };
    this.version++;
    this.listeners.forEach((l) => l());
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const store = new Store();

export function useIslandSnapshot(): Snapshot {
  store.init();
  useSyncExternalStore(
    store.subscribe.bind(store),
    () => store.version,
  );
  return store.snapshot;
}
