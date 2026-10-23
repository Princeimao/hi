// Dock tab: a countdown timer plus the shared todo list the agents can also
// write to ([todo: …] markers in chat replies land here). Timer state lives
// in dockStore so closing the island never loses the countdown.
import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Plus, Timer as TimerIcon, Trash2, ListTodo } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { dockStore, useDockVersion } from "../dockstore";
import type { RestAuth } from "../api";

interface Todo {
  id: string;
  text: string;
  done: boolean;
  source: string;
}

const fmt = (s: number): string => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export function DockPanel(): React.ReactElement {
  useDockVersion();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [todoText, setTodoText] = useState("");
  const restRef = useRef<RestAuth | null>(null);

  useEffect(() => {
    void (async () => {
      restRef.current = await window.hi.restAuth();
      const auth = restRef.current;
      if (!auth?.token) return;
      try {
        const res = await fetch(`${auth.restBase}/api/todos`, { headers: { Authorization: `Bearer ${auth.token}` } });
        if (res.ok) setTodos((await res.json()) as Todo[]);
      } catch {
        // live updates still arrive via hub events
      }
    })();
  }, []);

  // Todos update live from agent replies too.
  useEffect(() => {
    window.hi.onHubEvent((event) => {
      const type = event["type"];
      if (type === "todo.created") {
        const todo = event["todo"] as Todo | undefined;
        if (todo) setTodos((prev) => [todo, ...prev.filter((t) => t.id !== todo.id)]);
      }
      if (type === "todo.updated") {
        const todo = event["todo"] as Todo | undefined;
        if (todo) setTodos((prev) => prev.map((t) => (t.id === todo.id ? todo : t)));
      }
      if (type === "todo.deleted") {
        const id = String(event["id"] ?? "");
        setTodos((prev) => prev.filter((t) => t.id !== id));
      }
    });
  }, []);

  async function addTodo(): Promise<void> {
    const text = todoText.trim();
    if (!text) return;
    setTodoText("");
    const auth = restRef.current;
    if (!auth?.token) return;
    try {
      const res = await fetch(`${auth.restBase}/api/todos`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        const todo = (await res.json()) as Todo;
        setTodos((prev) => [todo, ...prev.filter((t) => t.id !== todo.id)]);
      }
    } catch {
      // silent
    }
  }

  async function toggleTodo(todo: Todo): Promise<void> {
    setTodos((prev) => prev.map((t) => (t.id === todo.id ? { ...t, done: !t.done } : t)));
    const auth = restRef.current;
    if (!auth?.token) return;
    await fetch(`${auth.restBase}/api/todos/${todo.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` },
      body: JSON.stringify({ done: !todo.done }),
    }).catch(() => undefined);
  }

  async function deleteTodo(todo: Todo): Promise<void> {
    setTodos((prev) => prev.filter((t) => t.id !== todo.id));
    const auth = restRef.current;
    if (!auth?.token) return;
    await fetch(`${auth.restBase}/api/todos/${todo.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${auth.token}` },
    }).catch(() => undefined);
  }

  const open = todos.filter((t) => !t.done);
  const done = todos.filter((t) => t.done);
  const mm = String(Math.floor(dockStore.seconds / 60)).padStart(2, "0");
  const ss = String(dockStore.seconds % 60).padStart(2, "0");
  const progress = dockStore.seconds > 0 ? dockStore.seconds % 60 / 60 : 0;

  return (
    <div className="flex h-full min-h-0 gap-3">
      <div className="flex min-h-0 w-[290px] flex-none flex-col gap-2.5">
        {/* Timer */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, ease: "easeOut" }}
          className="relative overflow-hidden rounded-xl border border-border/60 bg-gradient-to-b from-neutral-900/80 to-neutral-950/60 p-3.5"
        >
          {dockStore.timerOn ? (
            <motion.div
              animate={{ opacity: [0.2, 0.45, 0.2] }}
              transition={{ repeat: Infinity, duration: 3, ease: "easeInOut" }}
              className="pointer-events-none absolute -right-10 -top-12 h-32 w-32 rounded-full bg-violet-500/25 blur-2xl"
            />
          ) : null}
          <div className="relative flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-neutral-500">
              <TimerIcon className="h-3 w-3" /> Timer
            </div>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => dockStore.addSeconds(300)}>+5m</Button>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] text-neutral-500" onClick={() => dockStore.addSeconds(60)}>+1m</Button>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] text-neutral-500" onClick={() => dockStore.resetTimer()}>clear</Button>
            </div>
          </div>
          <div className="relative mt-1 flex items-center justify-between">
            <motion.div
              key={`${mm}:${ss}`}
              initial={{ opacity: 0.5, y: -3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18 }}
              className="font-mono text-4xl tracking-wider text-neutral-100"
            >
              {mm}:{ss}
            </motion.div>
            <motion.span whileTap={{ scale: 0.9 }} whileHover={{ scale: 1.05 }}>
              <Button size="sm" className="h-8 px-3.5 text-xs" onClick={() => dockStore.setTimer(!dockStore.timerOn)}>
                {dockStore.timerOn ? "Pause" : dockStore.seconds > 0 ? "Resume" : "Start"}
              </Button>
            </motion.span>
          </div>
          <div className="relative mt-2 h-1 overflow-hidden rounded-full bg-neutral-800">
            <motion.div
              className="h-full rounded-full bg-violet-400/80"
              animate={{ width: `${Math.max(2, progress * 100)}%` }}
              transition={{ duration: 0.4, ease: "easeOut" }}
            />
          </div>
        </motion.div>
        {/* Empty note */}
        <div className="rounded-xl border border-dashed border-border/40 px-3 py-2.5 text-[10px] leading-relaxed text-neutral-500">
          Ask Hi in chat — "remind me with a 10 min timer", "add a todo to call mom" — agents update this dock directly.
        </div>
      </div>
      {/* Todos */}
      <motion.div
        initial={{ opacity: 0, x: 12 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.28, delay: 0.06, ease: "easeOut" }}
        className="flex min-h-0 flex-1 flex-col gap-2"
      >
        <div className="flex items-center gap-2">
          <Input
            className="h-9 flex-1 text-xs"
            placeholder="Add a todo… agents can add them too"
            value={todoText}
            onChange={(e) => setTodoText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addTodo();
            }}
          />
          <Button size="icon" className="h-9 w-9" onClick={() => void addTodo()}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1 rounded-xl border border-border/60 bg-card/40">
          <div className="flex flex-col gap-1 p-2">
            {open.length === 0 && done.length === 0 ? (
              <div className="px-2 py-6 text-center text-[11px] leading-relaxed text-neutral-500">
                <ListTodo className="mx-auto mb-1.5 h-4 w-4 opacity-60" />
                Empty — add one here, or tell Hi in chat ("add a todo to call mom") and it lands here.
              </div>
            ) : null}
            <AnimatePresence initial={false}>
              {[...open, ...done].map((t) => (
                <motion.div
                  key={t.id}
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ duration: 0.16 }}
                  className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-neutral-800/40"
                >
                  <input
                    type="checkbox"
                    checked={t.done}
                    onChange={() => void toggleTodo(t)}
                    className="h-3.5 w-3.5 flex-none accent-neutral-100"
                  />
                  <motion.span layout="position" className={"min-w-0 flex-1 truncate text-xs " + (t.done ? "text-neutral-600 line-through" : "text-neutral-100")}>
                    {t.text}
                  </motion.span>
                  {t.source === "agent" ? (
                    <Badge variant="outline" className="flex-none border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0 text-[9px] text-emerald-300">agent</Badge>
                  ) : null}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 flex-none text-neutral-500 hover:text-rose-300"
                    onClick={() => void deleteTodo(t)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </ScrollArea>
      </motion.div>
    </div>
  );
}
