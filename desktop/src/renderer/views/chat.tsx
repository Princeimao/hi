// Chat tab — real messages through the same hub WS the approvals ride: send
// chat.send, render chat.delta as it streams, finalize on chat.message.
// Multiple conversations: a switcher lists them, + starts a new one; the
// selected thread loads over REST. ElevenLabs voice via /voice/tts.
import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Send, Square, Mic, MicOff, Loader2, Sparkles, CheckCircle2, Plus, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { RestAuth } from "../api";
import { dockStore } from "../dockstore";
import { ToolCard, type ToolCardData } from "../components/ToolCard";

interface Bubble {
  id: string;
  role: string;
  content: string;
  streaming?: boolean;
}

interface RestMessage {
  id: string;
  role: string;
  content: string;
  meta?: { streaming?: boolean } | null;
}

interface ConversationRow {
  id: string;
  title?: string;
}

/** Parse [clarify: question | opt1, opt2, …] out of an assistant reply. */
function parseClarify(text: string): { clean: string; question: string; options: string[] } | null {
  const m = text.match(/\[clarify:\s*([^\]|]+?)\s*(?:\|\s*([^\]]+))?\]/);
  if (!m) return null;
  const question = m[1].trim();
  const options = (m[2] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const clean = text.replace(/\[clarify:[^\]]*\]/g, "").trim();
  return { clean, question, options };
}

export function ChatPanel(): React.ReactElement {
  const [messages, setMessages] = useState<Bubble[]>([]);
  const [conv, setConv] = useState<string | null>(null);
  const [convs, setConvs] = useState<ConversationRow[]>([]);
  const [showList, setShowList] = useState(false);
  const [draft, setDraft] = useState("");
  const [state, setState] = useState("idle");
  const [spoken, setSpoken] = useState<Set<string>>(new Set());
  const [tools, setTools] = useState<{ label: string; ok: boolean }[]>([]);
  const [toolCards, setToolCards] = useState<ToolCardData[]>([]);
  const [voice, setVoice] = useState<"none" | "ready" | "listening" | "transcribing">("none");
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const restRef = useRef<RestAuth | null>(null);

  // Voice availability rides on the ElevenLabs link (native TTS ⇄ STT pair);
  // conversation list + selected thread load over REST.
  useEffect(() => {
    void (async () => {
      const auth = await window.hi.restAuth();
      restRef.current = auth;
      if (!auth?.token) return;
      const headers = { Authorization: `Bearer ${auth.token}` };
      try {
        const res = await fetch(`${auth.restBase}/api/integrations`, { headers });
        if (res.ok) {
          const list = (await res.json()) as unknown;
          const rows = (list as { rows?: { service: string; connected: boolean }[] }).rows ?? [];
          if (rows.find((r) => r.service === "elevenlabs")?.connected) setVoice("ready");
        }
      } catch {
        // live chat still works without voice
      }
      // Conversation list.
      try {
        const listRes = await fetch(`${auth.restBase}/api/conversations`, { headers });
        if (listRes.ok) {
          const list = (await listRes.json()) as ConversationRow[];
          setConvs(list);
          const latest = list[0];
          if (latest) {
            await loadConversation(latest.id, auth, headers);
          }
        }
      } catch {
        // offline: live events still work
      }
    })();
    window.hi.onHubEvent((event: Record<string, unknown>) => {
      const type = event["type"];
      if (type === "conversation.created") {
        const created = event["conversation"] as ConversationRow | undefined;
        if (created?.id) {
          setConv(created.id);
          setConvs((prev) => [created, ...prev.filter((c) => c.id !== created.id)]);
          setMessages([]);
        }
        return;
      }
      if (type === "chat.message") {
        const msg = event["message"] as { id: string; role: string; content: string; meta?: { streaming?: boolean } } | undefined;
        if (!msg?.id || (msg.role !== "user" && msg.role !== "assistant")) return;
        setMessages((prev) => {
          const next = prev.filter((b) => b.id !== msg.id);
          next.push({ id: msg.id, role: msg.role, content: msg.content, streaming: msg.meta?.streaming === true });
          return next;
        });
        if (msg.role === "assistant" && msg.meta?.streaming !== true && msg.content.trim()) {
          void speak(msg.id, msg.content);
        }
        return;
      }
      if (type === "chat.send") {
        // Local-looking prompts get a live Pi session immediately.
        const text = String(event["text"] ?? "");
        if (/\b(list|dir|ls|find|search|read|open|count|files?|folder|directory|how many)\b/i.test(text)) {
          window.hi.sessionSynthetic({
            hook_event_name: "PreToolUse",
            hi_agent: "pi",
            cwd: "",
            tool_name: "powershell",
            tool_input: { command: text.slice(0, 80) },
          });
        }
        return;
      }
      if (type === "chat.delta") {
        const messageId = String(event["messageId"] ?? "");
        if (!messageId) return;
        setMessages((prev) =>
          prev.map((b) => (b.id === messageId ? { ...b, content: b.content + String(event["text"] ?? "") } : b)),
        );
        return;
      }
      if (type === "chat.delivered") {
        return;
      }
      if (type === "chat.tool") {
        setTools((prev) => [...prev.slice(-3), { label: String(event["label"] ?? "tool"), ok: event["ok"] !== false }]);
        return;
      }
      if (type === "chat.tool.result") {
        const card: ToolCardData = {
          tool: String(event["tool"] ?? ""),
          label: String(event["label"] ?? "tool"),
          ok: event["ok"] !== false,
          output: String(event["output"] ?? ""),
        };
        setToolCards((prev) => [...prev.slice(-4), card]);
        setTools((prev) => [...prev.slice(-3), { label: card.label, ok: card.ok }]);
        // Surface local work as a live session in the Sessions tab.
        const isLocal = card.tool === "local.exec" || card.tool === "pi.code";
        if (isLocal) {
          window.hi.sessionSynthetic({
            hook_event_name: "Stop",
            hi_agent: "pi",
            cwd: "",
            last_assistant_message: card.ok
              ? card.output.split("\n").filter(Boolean).slice(0, 3).join(" · ").slice(0, 120)
              : `failed: ${card.output.slice(0, 100)}`,
          });
        }
        return;
      }
      if (type === "chat.timer") {
        const seconds = Number(event["seconds"] ?? 0);
        if (seconds > 0) dockStore.setTimer(true, seconds);
        return;
      }
      if (type === "avatar.state") {
        const s = String(event["state"] ?? "");
        if (s === "error") dockStore.setMood("angry", 4000);
        setState(["idle", "thinking", "speaking", "error"].includes(s) ? s : state);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadConversation(id: string, auth?: RestAuth | null, headers?: HeadersInit): Promise<void> {
    const a = auth ?? restRef.current;
    if (!a?.token) return;
    const h = headers ?? { Authorization: `Bearer ${a.token}` };
    try {
      const convRes = await fetch(`${a.restBase}/api/conversations/${id}`, { headers: h });
      if (!convRes.ok) return;
      const body = (await convRes.json()) as { messages: RestMessage[] };
      setConv(id);
      setToolCards([]);
      setMessages(
        (body.messages ?? [])
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m: RestMessage) => ({ id: m.id, role: m.role, content: m.content, streaming: m.meta?.streaming === true })),
      );
    } catch {
      // offline
    }
  }

  function newConversation(): void {
    setConv(null);
    setMessages([]);
    setToolCards([]);
    setShowList(false);
  }

  // Auto-scroll: shadcn ScrollArea wraps content in a viewport div; use
  // scrollIntoView on the last bubble so it works inside the scroll container.
  useEffect(() => {
    const el = scrollRef.current?.lastElementChild as HTMLElement | null;
    if (el) el.scrollIntoView({ block: "end" });
  }, [messages]);

  async function speak(messageId: string, text: string): Promise<void> {
    setSpoken((seen) => {
      if (seen.has(messageId)) return seen;
      const next = new Set(seen);
      next.add(messageId);
      return next;
    });
    const rest = restRef.current;
    if (!rest?.token) return;
    try {
      const res = await fetch(`${rest.restBase}/api/voice/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${rest.token}` },
        body: JSON.stringify({ text: text.slice(0, 1200) }),
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const audio = new Audio(URL.createObjectURL(blob));
      void audio.play().catch(() => undefined);
    } catch {
    }
  }

  function send(): void {
    const trimmed = draft.trim();
    if (!trimmed || state === "thinking") return;
    setDraft("");
    window.hi.sendChat(trimmed, conv);
  }

  function stop(): void {
    const streaming = messages.find((b) => b.streaming);
    if (streaming && conv) window.hi.stopChat(conv, streaming.id);
  }

  // Push-to-talk: click to record from the mic, click again to transcribe via
  // ElevenLabs Scribe on the server and auto-send the transcript.
  async function toggleVoice(): Promise<void> {
    if (voice === "listening") {
      recorderRef.current?.stop();
      return;
    }
    if (voice !== "ready") return;
    setVoiceNote(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const chunks: Blob[] = [];
      chunksRef.current = chunks;
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        void transcribeAndSend(mime);
      };
      recorder.start();
      recorderRef.current = recorder;
      setVoice("listening");
    } catch {
      setVoiceNote("mic unavailable — check microphone access");
    }
  }

  async function transcribeAndSend(mime: string): Promise<void> {
    const rest = restRef.current;
    const chunkList = chunksRef.current;
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setVoice((v) => (v === "listening" ? "ready" : v));
    if (!rest?.token || chunkList.length === 0) return;
    setVoice("transcribing");
    try {
      const blob = new Blob(chunkList, { type: mime.split(";")[0] });
      const res = await fetch(`${rest.restBase}/api/voice/stt`, {
        method: "POST",
        headers: { "Content-Type": mime.split(";")[0], Authorization: `Bearer ${rest.token}` },
        body: blob,
      });
      const body = (await res.json().catch(() => ({}))) as { text?: string; message?: string };
      if (res.ok && body.text?.trim()) {
        window.hi.sendChat(body.text.trim(), conv);
      } else if (!res.ok) {
        setVoiceNote(body.message ?? "transcription failed");
      }
    } catch {
      setVoiceNote("transcription failed");
    } finally {
      setVoice((v) => (v === "transcribing" ? "ready" : v));
    }
  }

  const busy = state === "thinking";

  return (
    <div className="flex h-full flex-col gap-1.5">
      {/* Conversation switcher: only shown when there's more than one thread. */}
      {convs.length > 1 || showList ? (
        <div className="flex items-center gap-1 px-1">
          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={newConversation} title="New chat">
            <Plus className="h-3 w-3" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 flex-1 justify-start gap-1 truncate text-[10px] text-neutral-400"
            onClick={() => setShowList((s) => !s)}
          >
            <MessageSquare className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{convs.find((c) => c.id === conv)?.title ?? (conv ? "Conversation" : "New chat")}</span>
          </Button>
        </div>
      ) : null}
      <AnimatePresence>
        {showList && convs.length > 1 ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <ScrollArea className="max-h-28 rounded-lg border border-border/50 bg-card/50">
              <div className="flex flex-col p-1">
                {convs.length === 0 ? (
                  <div className="px-2 py-1.5 text-[10px] text-neutral-500">No conversations yet</div>
                ) : (
                  convs.map((c) => (
                    <button
                      key={c.id}
                      className={
                        "rounded-md px-2 py-1 text-left text-[11px] transition-colors " +
                        (c.id === conv ? "bg-neutral-100 text-neutral-900" : "text-neutral-300 hover:bg-neutral-100/10")
                      }
                      onClick={() => {
                        void loadConversation(c.id);
                        setShowList(false);
                      }}
                    >
                      <span className="truncate">{c.title || "Untitled"}</span>
                    </button>
                  ))
                )}
              </div>
            </ScrollArea>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <ScrollArea className="flex-1 min-h-0 rounded-xl border border-border/60 bg-card/40">
        <div ref={scrollRef} className="flex flex-col gap-2 p-3">
          {messages.length === 0 ? (
            <div className="flex items-center gap-2 pt-6 pb-2 text-xs text-neutral-500">
              <Sparkles className="h-3.5 w-3.5" />
              Say something — replies stream here, and aloud when voice is linked.
            </div>
          ) : null}
          <AnimatePresence initial={false}>
            {messages.map((b, idx) => {
              const isLastAssistant = b.role === "assistant" && idx === messages.length - 1 && !b.streaming;
              const clarify = b.role === "assistant" ? parseClarify(b.content) : null;
              const shown = clarify ? clarify.clean : b.content;
              return (
                <motion.div
                  key={b.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                  className={
                    "max-w-[85%] rounded-2xl px-3 py-2 text-xs leading-relaxed " +
                    (b.role === "user"
                      ? "self-end bg-neutral-100 text-neutral-900"
                      : "self-start bg-neutral-900 text-neutral-100 border border-border/60")
                  }
                >
                  {shown || (b.streaming ? "…" : "")}
                  {b.streaming ? <span className="ml-0.5 inline-block h-3 w-[2px] animate-pulse bg-neutral-400 align-middle" /> : null}
                  {clarify && isLastAssistant ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {clarify.options.map((opt) => (
                        <button
                          key={opt}
                          className="rounded-full border border-violet-400/40 bg-violet-400/10 px-2.5 py-1 text-[11px] text-violet-200 transition-colors hover:bg-violet-400/25"
                          onClick={() => {
                            setDraft(opt);
                            // send immediately
                            void (async () => {
                              const text = opt;
                              setDraft("");
                              await window.hi.sendChat(text, conv);
                            })();
                          }}
                        >
                          {opt}
                        </button>
                      ))}
                      <span className="self-center text-[10px] text-neutral-500">or type below</span>
                    </div>
                  ) : null}
                </motion.div>
              );
            })}
          </AnimatePresence>
          {toolCards.map((c, i) => (
            <ToolCard key={`${c.tool}-${i}`} card={c} />
          ))}
          {busy ? <div className="self-start text-[10px] text-neutral-500">thinking…</div> : null}
        </div>
      </ScrollArea>
      {tools.length ? (
        <div className="flex flex-wrap gap-1.5 px-1">
          <AnimatePresence initial={false}>
            {tools.map((t, i) => (
              <motion.span
                key={`${t.label}-${i}`}
                layout
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className={
                  "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] " +
                  (t.ok
                    ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                    : "border-rose-400/30 bg-rose-400/10 text-rose-300")
                }
              >
                <CheckCircle2 className="h-2.5 w-2.5" /> {t.label}
              </motion.span>
            ))}
          </AnimatePresence>
        </div>
      ) : null}
      {voiceNote ? <div className="px-1 text-[10px] text-rose-400">{voiceNote}</div> : null}
      {voice === "none" ? (
        <div className="px-1 text-[10px] text-neutral-500">Link ElevenLabs in Links to talk — mic + spoken replies.</div>
      ) : voice === "listening" ? (
        <div className="px-1 text-[10px] text-emerald-400">listening… click the mic to send</div>
      ) : null}
      <div className="flex items-center gap-2">
        {voice === "ready" || voice === "listening" || voice === "transcribing" ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <motion.div
                animate={voice === "listening" ? { scale: [1, 1.08, 1] } : { scale: 1 }}
                transition={voice === "listening" ? { repeat: Infinity, duration: 1.2, ease: "easeInOut" } : undefined}
              >
                <Button
                  size="icon"
                  variant={voice === "listening" ? "default" : "outline"}
                  className="h-9 w-9"
                  disabled={voice === "transcribing"}
                  onClick={() => void toggleVoice()}
                >
                  {voice === "transcribing" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : voice === "listening" ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                </Button>
              </motion.div>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {voice === "listening" ? "Send" : voice === "transcribing" ? "Transcribing…" : "Talk to Hi"}
            </TooltipContent>
          </Tooltip>
        ) : null}
        <Input
          className="h-9 flex-1 text-xs"
          placeholder={busy ? "Thinking…" : "Message Hi"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
        />
        {busy ? (
          <Button size="icon" variant="outline" className="h-9 w-9" onClick={stop}>
            <Square className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button size="icon" className="h-9 w-9" disabled={!draft.trim()} onClick={send}>
            <Send className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}
