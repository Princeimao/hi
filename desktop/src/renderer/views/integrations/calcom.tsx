// Cal.com browser — upcoming bookings as readable agenda cards.
import React, { useEffect, useState } from "react";
import { MapPin, Users } from "lucide-react";
import { integration } from "../../api";
import { BackBar, Chip, EmptyBox, ErrorNote, Spinner } from "./shared";

interface Booking {
  id: number;
  title: string;
  start: string;
  end: string | null;
  status: string;
  description: string;
  duration: number | null;
  location: string | null;
  attendees: string[];
  hosts: string[];
}

function statusTone(status: string): "green" | "amber" | "rose" | "neutral" {
  const s = status.toLowerCase();
  if (s === "accepted" || s === "confirmed") return "green";
  if (s === "pending" || s === "rescheduling") return "amber";
  if (s === "cancelled" || s === "canceled" || s === "rejected") return "rose";
  return "neutral";
}

export function CalBrowser({ onBack }: { onBack: () => void }): React.ReactElement {
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    integration
      .get<Booking[]>("/integrations/calcom/items?limit=20")
      .then((b) => alive && setBookings(b))
      .catch((err) => alive && setError(String(err instanceof Error ? err.message : err)));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <BackBar title="Cal.com" sub="upcoming bookings" onBack={onBack} />
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {error ? <ErrorNote message={error} /> : null}
        {bookings === null ? (
          <Spinner />
        ) : bookings.length === 0 ? (
          <EmptyBox title="Nothing on the calendar" hint="Upcoming confirmed bookings show up here" />
        ) : (
          <div className="flex flex-col gap-1.5">
            {bookings.map((b) => {
              const start = new Date(b.start);
              const day = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
              const time = start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
              return (
                <div key={b.id} className="flex gap-2 rounded-xl border border-border/60 bg-neutral-900/40 p-2">
                  <div className="flex w-12 flex-none flex-col items-center justify-center rounded-lg border border-border/50 bg-neutral-950/60 py-1">
                    <div className="text-[9px] uppercase text-neutral-500">{day}</div>
                    <div className="text-[11px] font-semibold text-neutral-100">{time}</div>
                    {b.duration ? <div className="text-[8px] text-neutral-600">{b.duration}m</div> : null}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[11px] font-medium text-neutral-100">{b.title}</span>
                      <Chip tone={statusTone(b.status)}>{b.status}</Chip>
                    </div>
                    {b.description ? <div className="mt-0.5 line-clamp-2 text-[9px] text-neutral-500">{b.description}</div> : null}
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[9px] text-neutral-500">
                      {b.hosts.length ? (
                        <span className="flex items-center gap-1">
                          <Users className="h-2.5 w-2.5" /> {b.hosts.join(", ")}
                        </span>
                      ) : null}
                      {b.attendees.length ? <span>with {b.attendees.join(", ")}</span> : null}
                      {b.location ? (
                        <span className="flex min-w-0 items-center gap-1 truncate">
                          <MapPin className="h-2.5 w-2.5 flex-none" /> {b.location}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
