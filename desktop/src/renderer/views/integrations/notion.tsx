// Notion browser — search the workspace, then read the page itself in-app.
import React, { useEffect, useState } from "react";
import { ExternalLink, Search } from "lucide-react";
import { integration } from "../../api";
import { BackBar, EmptyBox, ErrorNote, Row, Spinner, openUrl, timeAgo } from "./shared";

interface Hit {
  id: string;
  title: string;
  icon: string;
  url: string;
  lastEdited: string;
}

interface Line {
  type: "h1" | "h2" | "h3" | "p" | "ul" | "ol" | "todo" | "quote" | "code" | "callout" | "hr" | "page" | "media";
  text: string;
  checked?: boolean;
  lang?: string;
}

interface Page {
  id: string;
  title: string;
  url: string;
  lines: Line[];
}

function LineView({ line }: { line: Line }): React.ReactElement | null {
  switch (line.type) {
    case "h1":
      return <div className="mt-2 text-[13px] font-semibold text-neutral-50">{line.text}</div>;
    case "h2":
      return <div className="mt-2 text-[12px] font-semibold text-neutral-100">{line.text}</div>;
    case "h3":
      return <div className="mt-1.5 text-[11px] font-semibold text-neutral-200">{line.text}</div>;
    case "ul":
      return (
        <div className="flex gap-1.5 pl-1 text-[11px] text-neutral-300">
          <span className="text-neutral-600">•</span>
          <span className="min-w-0 flex-1">{line.text}</span>
        </div>
      );
    case "ol":
      return (
        <div className="flex gap-1.5 pl-1 text-[11px] text-neutral-300">
          <span className="text-neutral-600">1.</span>
          <span className="min-w-0 flex-1">{line.text}</span>
        </div>
      );
    case "todo":
      return (
        <div className="flex gap-1.5 pl-1 text-[11px]">
          <span className={line.checked ? "text-emerald-400" : "text-neutral-600"}>{line.checked ? "☑" : "☐"}</span>
          <span className={line.checked ? "text-neutral-500 line-through" : "text-neutral-300"}>{line.text}</span>
        </div>
      );
    case "quote":
      return <div className="border-l-2 border-neutral-700 pl-2 text-[11px] italic text-neutral-400">{line.text}</div>;
    case "code":
      return (
        <pre className="overflow-x-auto rounded-lg bg-neutral-950/80 p-1.5 font-mono text-[10px] leading-relaxed text-emerald-200/90">
          {line.text}
        </pre>
      );
    case "callout":
      return <div className="rounded-lg border border-border/50 bg-neutral-900/70 p-1.5 text-[11px] text-neutral-300">{line.text}</div>;
    case "hr":
      return <hr className="my-1.5 border-border/50" />;
    case "page":
      return <div className="text-[11px] text-neutral-400">📄 {line.text}</div>;
    case "media":
      return <div className="text-[10px] text-neutral-500">📎 {line.text}</div>;
    default:
      return line.text.trim() ? <div className="text-[11px] leading-relaxed text-neutral-300">{line.text}</div> : null;
  }
}

export function NotionBrowser({ onBack }: { onBack: () => void }): React.ReactElement {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const timer = window.setTimeout(() => {
      setHits(null);
      integration
        .get<Hit[]>(`/integrations/notion/items?q=${encodeURIComponent(q)}&limit=25`)
        .then((h) => {
          if (alive) setHits(h);
        })
        .catch((err) => {
          if (alive) setError(String(err instanceof Error ? err.message : err));
        });
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [q]);

  function openPage(hit: Hit): void {
    setPage(null);
    integration
      .get<Page>(`/integrations/notion/page?id=${encodeURIComponent(hit.id)}`)
      .then(setPage)
      .catch((err) => setError(String(err instanceof Error ? err.message : err)));
  }

  if (page) {
    return (
      <div className="flex h-full flex-col">
        <BackBar
          title={
            <span className="flex items-center gap-1.5">
              <span>{page.title}</span>
            </span>
          }
          sub={`${page.lines.length} blocks · readable here`}
          onBack={() => setPage(null)}
          right={
            <button type="button" onClick={() => openUrl(page.url)} className="flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200">
              <ExternalLink className="h-3 w-3" />
            </button>
          }
        />
        <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
          {page.lines.length === 0 ? (
            <EmptyBox title="This page is empty" />
          ) : (
            <div className="flex flex-col gap-1">
              {page.lines.map((l, i) => (
                <LineView key={i} line={l} />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <BackBar title="Notion" sub="search, then read pages here" onBack={onBack} />
      <div className="flex-none px-2 py-1.5">
        <div className="flex items-center gap-1.5 rounded-lg border border-border/60 bg-neutral-950/50 px-2 py-1">
          <Search className="h-3 w-3 flex-none text-neutral-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="search your workspace…"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-neutral-100 outline-none placeholder:text-neutral-600"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {error ? <ErrorNote message={error} /> : null}
        {hits === null ? (
          <Spinner />
        ) : hits.length === 0 ? (
          <EmptyBox title={q ? `Nothing matches “${q}”` : "No pages shared with this integration"} hint="In Notion: Settings → Connections → add your integration to the pages" />
        ) : (
          hits.map((h) => (
            <Row key={h.id} onClick={() => openPage(h)}>
              <span className="flex h-5 w-5 flex-none items-center justify-center text-[11px]">{h.icon}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] text-neutral-100">{h.title}</div>
                <div className="text-[9px] text-neutral-600">edited {timeAgo(h.lastEdited)}</div>
              </div>
              <ExternalLink className="h-3 w-3 flex-none text-neutral-600" />
            </Row>
          ))
        )}
      </div>
    </div>
  );
}
