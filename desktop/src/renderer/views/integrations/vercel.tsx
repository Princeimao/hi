// Vercel browser — projects and live deployments with state, env and deep links.
import React, { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { integration } from "../../api";
import { BackBar, Chip, EmptyBox, ErrorNote, Row, Spinner, StateDot, openUrl, timeAgo } from "./shared";

interface Project {
  id: string;
  name: string;
  framework: string | null;
  state: string | null;
  lastDeployed: string | null;
  url: string | null;
}

interface Deployment {
  id: string;
  project: string;
  state: string;
  createdAt: string | null;
  url: string | null;
  environment: string | null;
  framework: string | null;
}

function stateTone(state: string | null): "green" | "amber" | "rose" | "neutral" {
  const s = String(state ?? "").toLowerCase();
  if (s === "ready" || s === "completed" || s === "succeeded") return "green";
  if (s === "building" || s === "queued" || s === "initialized") return "amber";
  if (s === "error" || s === "failed" || s === "canceled") return "rose";
  return "neutral";
}

export function VercelBrowser({ onBack }: { onBack: () => void }): React.ReactElement {
  const [tab, setTab] = useState<"projects" | "deployments">("projects");
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [deployments, setDeployments] = useState<Deployment[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const fail = (err: unknown) => alive && setError(String(err instanceof Error ? err.message : err));
    integration.get<Project[]>("/integrations/vercel/projects?limit=20").then((p) => alive && setProjects(p)).catch(fail);
    integration.get<Deployment[]>("/integrations/vercel/items?limit=20").then((d) => alive && setDeployments(d)).catch(fail);
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <BackBar
        title="Vercel"
        sub="projects & deployments, live"
        onBack={onBack}
        right={
          <div className="flex gap-1">
            {(["projects", "deployments"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`rounded-md px-2 py-1 text-[10px] capitalize transition-colors ${
                  tab === t ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {error ? <ErrorNote message={error} /> : null}
        {tab === "projects" ? (
          projects === null ? (
            <Spinner />
          ) : projects.length === 0 ? (
            <EmptyBox title="No projects" hint="Deploy something to Vercel first" />
          ) : (
            projects.map((p) => (
              <Row key={p.id} onClick={() => p.url && openUrl(p.url)}>
                <StateDot state={p.state} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11px] font-medium text-neutral-100">{p.name}</div>
                  <div className="flex items-center gap-1.5 text-[9px] text-neutral-500">
                    {p.framework ? <Chip>{p.framework}</Chip> : null}
                    <span>{p.state ?? "no deploys"}</span>
                    {p.lastDeployed ? <span>· {timeAgo(p.lastDeployed)}</span> : null}
                  </div>
                </div>
                <ExternalLink className="h-3 w-3 flex-none text-neutral-600" />
              </Row>
            ))
          )
        ) : null}
        {tab === "deployments" ? (
          deployments === null ? (
            <Spinner />
          ) : deployments.length === 0 ? (
            <EmptyBox title="No deployments" />
          ) : (
            deployments.map((d) => (
              <Row key={d.id} onClick={() => d.url && openUrl(d.url)}>
                <StateDot state={d.state} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[11px] font-medium text-neutral-100">{d.project}</span>
                    <Chip tone={stateTone(d.state)}>{d.state}</Chip>
                    {d.environment ? <Chip tone={d.environment === "production" ? "violet" : "neutral"}>{d.environment}</Chip> : null}
                  </div>
                  <div className="truncate text-[9px] text-neutral-500">
                    {d.framework ? `${d.framework} · ` : ""}
                    {timeAgo(d.createdAt)}
                  </div>
                </div>
                <ExternalLink className="h-3 w-3 flex-none text-neutral-600" />
              </Row>
            ))
          )
        ) : null}
      </div>
    </div>
  );
}
