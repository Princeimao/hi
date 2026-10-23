// Dock state lives outside React so the island can collapse without losing
// the timer — the collapsed strip and the expanded panel read the same values.
import { useSyncExternalStore } from "react";

export type Mood = "idle" | "angry";

class DockStore {
  timerOn = false;
  seconds = 0;
  mood: Mood = "idle";
  private moodTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  version = 0;

  emit(): void {
    this.version += 1;
    this.listeners.forEach((l) => l());
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  setTimer(on: boolean, seconds?: number): void {
    if (seconds !== undefined) this.seconds = Math.max(0, seconds);
    this.timerOn = on && this.seconds > 0;
    this.emit();
  }

  tick(): void {
    if (!this.timerOn || this.seconds <= 0) return;
    this.seconds -= 1;
    if (this.seconds === 0) this.timerOn = false;
    this.emit();
  }

  addSeconds(delta: number): void {
    this.seconds = Math.max(0, this.seconds + delta);
    if (this.seconds > 0) this.timerOn = true;
    this.emit();
  }

  resetTimer(): void {
    this.timerOn = false;
    this.seconds = 0;
    this.emit();
  }

  /** Avatar mood: auto-reverts to idle so anger is transient. */
  setMood(mood: Mood, revertMs?: number): void {
    this.mood = mood;
    this.emit();
    if (this.moodTimer) clearTimeout(this.moodTimer);
    if (revertMs) {
      this.moodTimer = setTimeout(() => {
        this.mood = "idle";
        this.emit();
      }, revertMs);
    }
  }
}

export const dockStore = new DockStore();

// The countdown runs in one place, forever — independent of any panel mount.
setInterval(() => dockStore.tick(), 1000);

/** Rerenders whenever dock state changes; read fields off `dockStore`. */
export function useDockVersion(): number {
  return useSyncExternalStore(dockStore.subscribe, () => dockStore.version, () => 0);
}
