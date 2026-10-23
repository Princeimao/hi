import React, { useLayoutEffect, useRef } from "react";
import { animate, createSpring } from "animejs";
import { Avatar } from "@bible-strong/avatar-react";
import "@bible-strong/avatar-react/styles.css";
import hubuDefinition from "../assets/hubu.avatar.json";
import type { AvatarDefinition } from "@bible-strong/avatar-core";

export function IslandAvatar({ state }: { state: string }): React.ReactElement {
  const slotRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);
  const key = stateToAnimation[state] ?? "idle";

  // A springy pop whenever the island's state changes: the avatar reacts to
  // the machine instead of just switching clips.
  useLayoutEffect(() => {
    if (!slotRef.current) return;
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    animate(slotRef.current, {
      scale: [
        { to: 1.14, duration: 110, ease: "out(2)" },
        { to: 1, duration: 340 },
      ],
      ease: createSpring({ stiffness: 260, damping: 14 }),
    });
  }, [key]);

  return (
    <div className="avatar-slot">
      <div ref={slotRef} className="avatar-bounce">
        <Avatar
          definition={hubuDefinition as AvatarDefinition}
          size={44}
          animation={key as never}
          className="island-avatar"
          onError={(err) => console.error(`[avatar] ${err.code}: ${err.message}`)}
        />
      </div>
    </div>
  );
}

const stateToAnimation: Record<string, string> = {
  idle: "idle",
  thinking: "thinking",
  working: "working",
  question: "curious",
  approval: "curious",
  finished: "celebrate",
  error: "sad",
  ratelimit: "bored",
};
