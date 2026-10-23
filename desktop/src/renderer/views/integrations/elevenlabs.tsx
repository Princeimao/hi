// ElevenLabs browser — the voice library with in-app preview playback.
import React, { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { integration } from "../../api";
import { BackBar, Chip, EmptyBox, ErrorNote, Row, Spinner } from "./shared";

interface Voice {
  id: string;
  name: string;
  labels: Record<string, string>;
  category: string | null;
  previewUrl: string | null;
}

export function ElevenLabsBrowser({ onBack }: { onBack: () => void }): React.ReactElement {
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let alive = true;
    integration
      .get<Voice[]>("/integrations/elevenlabs/voices")
      .then((v) => alive && setVoices(v))
      .catch((err) => alive && setError(String(err instanceof Error ? err.message : err)));
    return () => {
      alive = false;
      audioRef.current?.pause();
    };
  }, []);

  function toggle(voice: Voice): void {
    if (!voice.previewUrl) return;
    const audio = audioRef.current ?? new Audio();
    audioRef.current = audio;
    if (playing === voice.id) {
      audio.pause();
      setPlaying(null);
      return;
    }
    audio.pause();
    audio.src = voice.previewUrl;
    audio.onended = () => setPlaying(null);
    void audio.play().catch(() => setPlaying(null));
    setPlaying(voice.id);
  }

  return (
    <div className="flex h-full flex-col">
      <BackBar title="ElevenLabs" sub="voice library · powers Chat mic & speak" onBack={onBack} />
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {error ? <ErrorNote message={error} /> : null}
        {voices === null ? (
          <Spinner />
        ) : voices.length === 0 ? (
          <EmptyBox title="No voices" />
        ) : (
          voices.map((v) => (
            <Row key={v.id} onClick={() => toggle(v)}>
              <button
                type="button"
                className="flex h-6 w-6 flex-none items-center justify-center rounded-full border border-border/60 bg-neutral-800 text-neutral-200 transition-colors hover:border-violet-400/50 hover:text-violet-300"
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(v);
                }}
              >
                {playing === v.id ? <Pause className="h-2.5 w-2.5" /> : <Play className="h-2.5 w-2.5 translate-x-px" />}
              </button>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] font-medium text-neutral-100">{v.name}</div>
                <div className="flex flex-wrap items-center gap-1 text-[9px] text-neutral-500">
                  {v.category ? <Chip tone="violet">{v.category}</Chip> : null}
                  {Object.entries(v.labels)
                    .filter(([k]) => k !== "category")
                    .slice(0, 3)
                    .map(([k, val]) => (
                      <span key={k}>{val}</span>
                    ))}
                </div>
              </div>
              {v.previewUrl ? (
                <span className="flex-none text-[9px] text-neutral-600">{playing === v.id ? "playing…" : "preview"}</span>
              ) : null}
            </Row>
          ))
        )}
      </div>
    </div>
  );
}
