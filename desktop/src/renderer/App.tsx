// The island chrome: shadcn conventions with motion springs + gsap/anime.js
// accents. Geometry is a notch: flush to the top edge, square top corners,
// rounded bottom — the expanded panel hangs from there like a drawer.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { gsap } from "gsap";
import { animate as anime } from "animejs";
import { Home, MessageCircle, Users, Link2, Volume2, VolumeX, PanelsTopLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TooltipProvider, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AnimatedShinyText } from "@/components/ui/animated-shiny-text";
import { useIslandSnapshot } from "./store";
import { CollapsedIsland } from "./views/collapsed";
import { ApprovalCard } from "./views/approval";
import { QuestionCard } from "./views/question";
import { SessionsPanel } from "./views/sessions";
import { FriendsPanel } from "./views/friends";
import { IntegrationsPanel } from "./views/integrations";
import { DockPanel } from "./views/dock";
import { ChatPanel } from "./views/chat";
import { PairQr } from "@/components/PairQr";

const PANEL_W = 720;
const PANEL_H = 380;
const CARD_H = 560;

const TABS = [
  { id: "sessions", label: "Sessions", icon: Home },
  { id: "chat", label: "Chat", icon: MessageCircle },
  { id: "friends", label: "Friends", icon: Users },
  { id: "dock", label: "Dock", icon: PanelsTopLeft },
  { id: "links", label: "Links", icon: Link2 },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function App(): React.ReactElement {
  const snap = useIslandSnapshot();
  const [expanded, setExpanded] = useState(false);
  const [showPair, setShowPair] = useState(false);
  const [tab, setTab] = useState<TabId>("sessions");
  const islandRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const pulseRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef(false);
  const lastUserRef = useRef(1);

  pendingRef.current = snap.pending !== null;

  useEffect(() => {
    window.hi.onWindowBlur(() => {
      if (!pendingRef.current) setExpanded(false);
    });
  }, []);

  useEffect(() => {
    const el = islandRef.current;
    if (!el) return;
    if (expanded || snap.pending !== null) {
      gsap.fromTo(
        el,
        { filter: "blur(14px)", opacity: 0.7 },
        { filter: "blur(0px)", opacity: 1, duration: 0.45, ease: "power3.out" },
      );
    } else {
      gsap.to(el, { filter: "blur(6px)", opacity: 0.9, duration: 0.2, ease: "power2.in", onComplete: () => gsap.set(el, { filter: "blur(0px)", opacity: 1 }) });
    }
  }, [expanded, snap.pending]);

  // The live-agent count drives an anime.js pulse on the avatar badge.
  const userCount = snap.sessions.filter((s) => s.status !== "idle").length;
  useEffect(() => {
    const el = pulseRef.current;
    if (!el) return;
    anime(
      el,
      {
        scale: [1, 1.18, 1],
        opacity: [0.4, 0.9, 0.4],
        duration: 1400,
        ease: "inOutQuad",
        loop: true,
      },
    );
    return () => {
      el.getAnimations().forEach((a) => a.cancel());
    };
  }, [userCount]);

  useEffect(() => {
    const hasCard = snap.pending !== null;
    if (hasCard || expanded) window.hi.expand(PANEL_W, hasCard ? CARD_H : PANEL_H);
    else window.hi.collapse();
  }, [expanded, snap.pending]);

  useLayoutEffect(() => {
    if (userCount > lastUserRef.current) setTab("sessions");
    lastUserRef.current = userCount;
  }, [userCount]);

  // gsap stagger on the tab rail each time the island opens.
  useEffect(() => {
    if (!navRef.current || (!expanded && !snap.pending)) return;
    gsap.fromTo(
      navRef.current.querySelectorAll("[data-tab-item]"),
      { opacity: 0, y: -6 },
      { opacity: 1, y: 0, duration: 0.28, stagger: 0.035, ease: "power2.out", overwrite: true },
    );
  }, [expanded, snap.pending, tab]);

  const card = snap.pending ? (
    snap.pending.questions ? (
      <QuestionCard key={snap.pending.requestId} approval={snap.pending} />
    ) : (
      <ApprovalCard key={snap.pending.requestId} approval={snap.pending} />
    )
  ) : null;

  return (
    <TooltipProvider delayDuration={200}>
      <motion.div
        ref={islandRef}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 24 }}
        className={
          "island-root flex h-full w-full flex-col bg-neutral-950 text-neutral-100 " +
          (card || expanded ? "rounded-b-[20px] rounded-t-none" : "rounded-b-full rounded-t-none")
        }
        style={{ boxShadow: "0 10px 30px rgba(0,0,0,0.55), 0 1px 0 rgba(255,255,255,0.06) inset" }}
      >
        <div
          className={
            "topbar flex items-center gap-1 px-2 " +
            (card || expanded ? "" : "justify-center w-full")
          }
          style={{ minHeight: 44 }}
          onClick={() => setExpanded((e) => !e)}
        >
          <CollapsedIsland sessions={snap.sessions} pending={snap.pending} expanded={expanded} paused={snap.paused} />
          {(card || expanded) ? (
            <div
              ref={navRef}
              className="absolute left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-border/50 bg-black/40 p-0.5 backdrop-blur-md"
              onClick={(e) => e.stopPropagation()}
            >
              {TABS.map((t) => {
                const active = tab === t.id && !card;
                return (
                  <Tooltip key={t.id}>
                    <TooltipTrigger asChild>
                      <button
                        data-tab-item
                        onClick={() => {
                          if (!card) setTab(t.id);
                        }}
                        className={
                          "relative flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[11px] transition-colors " +
                          (active ? "text-neutral-100" : "text-neutral-400 hover:text-neutral-200")
                        }
                      >
                        {active ? (
                          <motion.span
                            layoutId="nav-active"
                            className="absolute inset-0 rounded-full bg-neutral-800/90 ring-1 ring-border/60"
                            transition={{ type: "spring", stiffness: 400, damping: 30 }}
                          />
                        ) : null}
                        <t.icon className="relative z-10 h-3 w-3" />
                        <span className="relative z-10">
                          {active ? (
                            <AnimatedShinyText className="font-medium">
                              <span>{t.label}</span>
                            </AnimatedShinyText>
                          ) : (
                            t.label
                          )}
                        </span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs">{t.label}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          ) : null}
          <div className="ml-auto flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            {card || expanded ? (
              <>
                {userCount > 0 ? (
                  <div ref={pulseRef} className="relative flex">
                    <Badge variant="outline" className="text-[10px] text-neutral-400">{userCount} live</Badge>
                  </div>
                ) : null}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => window.hi.setPaused(!snap.paused)}>
                      {snap.paused ? <VolumeX className="h-4 w-4 text-neutral-400" /> : <Volume2 className="h-4 w-4 text-neutral-400" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">{snap.paused ? "Resume monitors" : "Pause monitors"}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowPair((v) => !v)}>
                      <Link2 className="h-4 w-4 text-neutral-400" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">Pair phone</TooltipContent>
                </Tooltip>
              </>
            ) : null}
          </div>
        </div>
        {showPair ? (
          <div className="px-2.5 pb-2.5">
            <div className="rounded-xl border bg-card p-3">
              <PairQr />
            </div>
          </div>
        ) : null}
        <AnimatePresence mode="wait">
          {card ? (
            <motion.div
              key="card"
              initial={{ opacity: 0, y: -18, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ type: "spring", stiffness: 340, damping: 26 }}
              className="px-2.5 pb-2.5"
            >
              {card}
            </motion.div>
          ) : expanded ? (
            <motion.div
              key="body"
              initial={{ opacity: 0, y: -12, scale: 0.99 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.99 }}
              transition={{ type: "spring", stiffness: 300, damping: 28 }}
              className="flex-1 min-h-0 px-2.5 pb-2.5"
            >
              {tab === "sessions" ? (
                <SessionsPanel sessions={snap.sessions} />
              ) : tab === "chat" ? (
                <ChatPanel />
              ) : tab === "friends" ? (
                <FriendsPanel />
              ) : tab === "dock" ? (
                <DockPanel />
              ) : (
                <IntegrationsPanel />
              )}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>
    </TooltipProvider>
  );
}
