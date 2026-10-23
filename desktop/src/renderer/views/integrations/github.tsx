// GitHub browser — repos → repo (files / pulls / issues / commits) → file reader.
// Everything is read live from the GitHub API through the Hi backend.
import React, { useCallback, useEffect, useState } from "react";
import { ChevronRight, ExternalLink, FileText, Folder, GitCommitHorizontal, GitPullRequest, Star, OctagonAlert } from "lucide-react";
import { integration } from "../../api";
import { BackBar, Chip, EmptyBox, ErrorNote, LockedNote, Row, Spinner, fmtBytes, openUrl, timeAgo } from "./shared";

interface Repo {
  fullName: string;
  description: string;
  language: string | null;
  stars: number;
  private: boolean;
  pushedAt: string;
  url: string;
  defaultBranch: string;
}

interface Entry {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
}

interface Pull {
  number: number;
  title: string;
  author: string | null;
  draft: boolean;
  createdAt: string;
  url: string | null;
}

interface Issue {
  number: number;
  title: string;
  author: string | null;
  createdAt: string;
  url: string | null;
}

interface Commit {
  sha: string;
  message: string;
  author: string | null;
  date: string | null;
  url: string | null;
}

interface FileBody {
  name: string;
  path: string;
  size: number;
  text?: string;
  tooLarge?: boolean;
}

const LANG_COLORS: Record<string, string> = {
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Python: "#3572A5",
  Rust: "#dea584",
  Go: "#00ADD8",
  CSS: "#663399",
  HTML: "#e34c26",
  Shell: "#89e051",
  Ruby: "#701516",
  Java: "#b07219",
  Vue: "#41b883",
  Swift: "#F05138",
  Kotlin: "#A97BFF",
  C: "#555555",
  "C++": "#f34b7d",
  "C#": "#178600",
  PHP: "#4F5D95",
  Dart: "#00B4AB",
};

type Tab = "files" | "pulls" | "issues" | "commits";

export function GitHubBrowser({ onBack, onUnlink }: { onBack: () => void; onUnlink: () => void }): React.ReactElement {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repo, setRepo] = useState<Repo | null>(null);
  const [tab, setTab] = useState<Tab>("files");
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [file, setFile] = useState<FileBody | null>(null);
  const [pulls, setPulls] = useState<Pull[] | null>(null);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    integration
      .get<Repo[]>("/integrations/github/items?limit=30")
      .then((r) => alive && setRepos(r))
      .catch((err) => alive && setError(String(err instanceof Error ? err.message : err)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const loadDir = useCallback((repoName: string, dirPath: string) => {
    setEntries(null);
    integration
      .get<Entry[]>(`/integrations/github/contents?repo=${encodeURIComponent(repoName)}&path=${encodeURIComponent(dirPath)}`)
      .then(setEntries)
      .catch((err) => setError(String(err instanceof Error ? err.message : err)));
  }, []);

  useEffect(() => {
    if (!repo) return;
    setFile(null);
    if (tab === "files") loadDir(repo.fullName, path);
    else if (tab === "pulls" && !pulls) {
      integration.get<Pull[]>(`/integrations/github/items?repo=${encodeURIComponent(repo.fullName)}&limit=20`).then(setPulls).catch((err) => setError(String(err instanceof Error ? err.message : err)));
    } else if (tab === "issues" && !issues) {
      integration.get<Issue[]>(`/integrations/github/issues?repo=${encodeURIComponent(repo.fullName)}&limit=20`).then(setIssues).catch((err) => setError(String(err instanceof Error ? err.message : err)));
    } else if (tab === "commits" && !commits) {
      integration.get<Commit[]>(`/integrations/github/commits?repo=${encodeURIComponent(repo.fullName)}&limit=20`).then(setCommits).catch((err) => setError(String(err instanceof Error ? err.message : err)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, tab, path]);

  function openFile(entry: Entry): void {
    setFile(null);
    integration
      .get<FileBody>(`/integrations/github/file?repo=${encodeURIComponent(repo!.fullName)}&path=${encodeURIComponent(entry.path)}`)
      .then(setFile)
      .catch((err) => setError(String(err instanceof Error ? err.message : err)));
  }

  if (loading) return <Spinner />;
  if (error && !repos) return <ErrorNote message={error} />;
  if (!repos) return <EmptyBox title="No repos found" hint="The token may lack repo scope" />;

  // ── File reader ─────────────────────────────────────────────────────────────
  if (repo && file) {
    const segs = file.path.split("/");
    return (
      <div className="flex h-full flex-col">
        <BackBar
          title={
            <span className="flex items-center gap-1">
              <FileText className="h-3 w-3 text-neutral-500" /> {file.name}
            </span>
          }
          sub={`${repo.fullName} · ${fmtBytes(file.size)}`}
          onBack={() => setFile(null)}
          right={
            <button type="button" onClick={() => openUrl(`${repo.url}/blob/${repo.defaultBranch}/${file.path}`)} className="flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200">
              <ExternalLink className="h-3 w-3" />
            </button>
          }
        />
        <div className="flex-none border-b border-border/40 px-2.5 py-1 text-[9px] text-neutral-500">
          {segs.map((s, i) => (
            <span key={i}>
              {i > 0 ? <ChevronRight className="mx-0.5 inline h-2.5 w-2.5 -translate-y-px text-neutral-600" /> : null}
              {s}
            </span>
          ))}
        </div>
        {file.tooLarge ? (
          <EmptyBox title="File too large to preview" hint={fmtBytes(file.size)} />
        ) : (
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[10px] leading-relaxed text-neutral-300">
            {file.text || "(empty file)"}
          </pre>
        )}
      </div>
    );
  }

  // ── Repo view ──────────────────────────────────────────────────────────────
  if (repo) {
    const tabs: { id: Tab; label: string; icon: React.ElementType }[] = [
      { id: "files", label: "Files", icon: Folder },
      { id: "pulls", label: "Pulls", icon: GitPullRequest },
      { id: "issues", label: "Issues", icon: OctagonAlert },
      { id: "commits", label: "Commits", icon: GitCommitHorizontal },
    ];
    return (
      <div className="flex h-full flex-col">
        <BackBar
          title={repo.fullName}
          sub={repo.description || undefined}
          onBack={() => {
            setRepo(null);
            setPath("");
            setPulls(null);
            setIssues(null);
            setCommits(null);
          }}
          right={
            <button type="button" onClick={() => openUrl(repo.url)} className="flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200">
              <ExternalLink className="h-3 w-3" />
            </button>
          }
        />
        <div className="flex flex-none gap-1 border-b border-border/40 px-2 py-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-[10px] transition-colors ${
                tab === t.id ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"
              }`}
            >
              <t.icon className="h-2.5 w-2.5" /> {t.label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {error ? <ErrorNote message={error} /> : null}
          {tab === "files" ? (
            <>
              {path ? (
                <Row
                  onClick={() => {
                    const parts = path.split("/");
                    parts.pop();
                    setPath(parts.join("/"));
                    setFile(null);
                  }}
                >
                  <ChevronRight className="h-3 w-3 rotate-180 text-neutral-500" />
                  <span className="text-[11px] text-neutral-400">..</span>
                </Row>
              ) : null}
              {entries === null ? (
                <Spinner />
              ) : entries.length === 0 ? (
                <EmptyBox title="Empty folder" />
              ) : (
                [...entries]
                  .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1))
                  .map((e) => (
                    <Row
                      key={e.path}
                      onClick={() => (e.type === "dir" ? (setPath(e.path), setFile(null)) : openFile(e))}
                    >
                      {e.type === "dir" ? (
                        <Folder className="h-3 w-3 flex-none text-amber-300/80" />
                      ) : (
                        <FileText className="h-3 w-3 flex-none text-neutral-500" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-200">{e.name}</span>
                      {e.type === "file" ? <span className="text-[9px] text-neutral-600">{fmtBytes(e.size)}</span> : null}
                    </Row>
                  ))
              )}
            </>
          ) : null}
          {tab === "pulls" ? (
            pulls === null ? (
              <Spinner />
            ) : pulls.length === 0 ? (
              <EmptyBox title="No open pull requests" />
            ) : (
              pulls.map((p) => (
                <Row key={p.number} onClick={() => p.url && openUrl(p.url)}>
                  <span className="w-8 flex-none text-[9px] text-neutral-600">#{p.number}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-200">{p.title}</span>
                  {p.draft ? <Chip>draft</Chip> : null}
                  <span className="flex-none text-[9px] text-neutral-600">{p.author} · {timeAgo(p.createdAt)}</span>
                </Row>
              ))
            )
          ) : null}
          {tab === "issues" ? (
            issues === null ? (
              <Spinner />
            ) : issues.length === 0 ? (
              <EmptyBox title="No open issues" />
            ) : (
              issues.map((i) => (
                <Row key={i.number} onClick={() => i.url && openUrl(i.url)}>
                  <span className="w-8 flex-none text-[9px] text-neutral-600">#{i.number}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-200">{i.title}</span>
                  <span className="flex-none text-[9px] text-neutral-600">{i.author} · {timeAgo(i.createdAt)}</span>
                </Row>
              ))
            )
          ) : null}
          {tab === "commits" ? (
            commits === null ? (
              <Spinner />
            ) : commits.length === 0 ? (
              <EmptyBox title="No commits" />
            ) : (
              commits.map((c) => (
                <Row key={c.sha} onClick={() => c.url && openUrl(c.url)}>
                  <span className="flex-none rounded bg-neutral-800 px-1 font-mono text-[9px] text-violet-300">{c.sha}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-200">{c.message}</span>
                  <span className="flex-none text-[9px] text-neutral-600">{c.author} · {timeAgo(c.date)}</span>
                </Row>
              ))
            )
          ) : null}
        </div>
      </div>
    );
  }

  // ── Repo list ──────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col">
      <BackBar title="Repositories" sub={`${repos.length} most recently pushed`} onBack={onBack} right={<Chip tone="violet">read · browse</Chip>} />
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {error ? <ErrorNote message={error} /> : null}
        {repos.length === 0 ? (
          <LockedNote what="Repos" />
        ) : (
          repos.map((r) => (
            <Row key={r.fullName} onClick={() => setRepo(r)}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[11px] font-medium text-neutral-100">
                    {r.fullName.split("/")[0]}
                    <span className="text-neutral-500">/</span>
                    {r.fullName.split("/").slice(1).join("/")}
                  </span>
                  {r.private ? <Chip>private</Chip> : null}
                </div>
                {r.description ? (
                  <div className="truncate text-[9px] text-neutral-500">{r.description}</div>
                ) : null}
              </div>
              {r.language ? (
                <span className="flex flex-none items-center gap-1 text-[9px] text-neutral-400">
                  <span className="h-2 w-2 rounded-full" style={{ background: LANG_COLORS[r.language] ?? "#8b8b8b" }} />
                  {r.language}
                </span>
              ) : null}
              {r.stars > 0 ? (
                <span className="flex flex-none items-center gap-0.5 text-[9px] text-neutral-500">
                  <Star className="h-2.5 w-2.5" /> {r.stars}
                </span>
              ) : null}
              <span className="w-14 flex-none text-right text-[9px] text-neutral-600">{timeAgo(r.pushedAt)}</span>
            </Row>
          ))
        )}
      </div>
    </div>
  );
}
