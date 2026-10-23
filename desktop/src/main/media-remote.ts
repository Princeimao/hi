// System media + audio bridge (Windows): the island drives whatever player is
// active (Spotify, browsers, anything with media keys) via keybd_event, gets
// the track title via WinRT's media transport service, and raises/lowers/mutes
// system volume with the standard volume keys. No COM interop needed.
import { execFile } from "node:child_process";

const PS = "powershell.exe";
const ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

function ps(script: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(PS, [...ARGS, script], { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 64 }, (err, stdout) =>
      resolve(err ? "" : String(stdout).trim()),
    );
  });
}

const MEDIA_KEYS_PRELUDE = `
$def = @"
using System;
using System.Runtime.InteropServices;
public static class MediaKeys {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public static void Press(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); keybd_event(vk, 0, 2, UIntPtr.Zero); }
}
"@
Add-Type -TypeDefinition $def
function PressAll([byte[]]$keys) { foreach ($k in $keys) { [MediaKeys]::Press($k); Start-Sleep -Milliseconds 55 } }`;

export type MediaKeyId =
  | "prev"
  | "playPause"
  | "next"
  | "volDown"
  | "volUp"
  | "mute";

const VK: Record<MediaKeyId, number> = {
  prev: 177, // VK_MEDIA_PREV_TRACK
  playPause: 179, // VK_MEDIA_PLAY_PAUSE
  next: 176, // VK_MEDIA_NEXT_TRACK
  volDown: 174, // VK_VOLUME_DOWN
  volUp: 175, // VK_VOLUME_UP
  mute: 173, // VK_VOLUME_MUTE
};

/** Sends one or more media keys. Volume steps default to 4% (4 taps). */
export function mediaAction(kind: MediaKeyId, steps = 1): void {
  const key = VK[kind];
  const keys: number[] = [];
  for (let i = 0; i < Math.max(1, Math.min(steps, 50)); i += 1) keys.push(key);
  void ps(`${MEDIA_KEYS_PRELUDE.trim()}
PressAll @(${keys.join(",")})`.trim());
}

export interface MediaInfo {
  title: string;
  artist: string;
  status: string;
}

const MEDIA_INFO_PS = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + [char]0x60 + '1' })[0]
function Await($WinRtTask, $ResultType) {
  $netTask = $asTaskGeneric.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
$man = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$sessions = Await ($man::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$session = @($sessions.GetSessions()) | Select-Object -First 1
if (-not $session) { "none|" } else {
  $info = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $status = $session.GetPlaybackInfo().PlaybackStatus
  "$($status)|$([string]$info.Title)|$([string]$info.Artist)"
}
`;

export async function mediaInfo(): Promise<MediaInfo | null> {
  const out = await ps(MEDIA_INFO_PS.trim());
  if (!out) return null;
  const first = out.split("\r\n")[0].trim();
  const [status, title, artist] = first.split("|");
  if (!status || status === "none") return null;
  return { status: status.trim(), title: (title ?? "").trim(), artist: (artist ?? "").trim() };
}
