# adb-recorder Design

Date: 2026-07-16

## Purpose

A local webapp for recording touch input on an Android device/emulator via `adb`,
capturing a screenshot after every gesture, and replaying the recorded session
verbatim later. Built to support manual testing/debugging workflows (e.g.
navigating login → booking) where the same sequence of taps/swipes needs to be
repeated and visually inspected across runs.

General-purpose: not tied to any specific app or package, works against
whichever device/emulator is connected via `adb`.

## Architecture

A single Node.js process runs both:

- an Express HTTP server serving the web UI and REST endpoints
- a WebSocket server pushing live updates during recording
- child `adb` processes for capture/replay

No database. Each recording session is a folder on disk:

```
sessions/<session-name>/
  events.log          # raw `getevent -lt` output, verbatim
  steps.json           # parsed gesture list: [{index, type, coords, timestamp, screenshot}]
  screenshots/step-0.png, step-1.png, ...
  device.json          # serial, model, resolution captured at record time
```

Frontend is plain HTML/CSS/vanilla JS — no build step, no frontend framework.
Two pages: session list and session detail (gallery/timeline + controls).

## Components

- **DeviceManager** — lists connected devices (`adb devices`), resolves the
  target serial (explicit `-s` flag if multiple devices, otherwise the single
  connected device), fetches resolution/model for `device.json`. Auto-detects
  the touchscreen input node via `adb shell getevent -pl`.

- **Recorder** — spawns `adb -s <serial> shell getevent -lt <event-node>`,
  streams stdout, and buffers raw lines. On each `SYN_REPORT` that closes a
  gesture (down → move* → up):
  1. appends the raw slice to `events.log`
  2. fires `adb exec-out screencap -p` and saves it under `screenshots/`
  3. appends a step entry to `steps.json` (index, gesture type — tap/swipe,
     coordinates, timestamp, screenshot path)
  4. pushes the new step + thumbnail over the WebSocket to any connected UI

- **Replayer** — reads `events.log` for a session, opens the same event node
  via `adb shell sendevent`, and replays the raw lines preserving their
  original relative delays (computed from the `-t` timestamps in the log), so
  gesture speed/duration matches the original recording. Optionally
  re-screenshots after each step for before/after comparison.

- **SessionStore** — filesystem wrapper: create/list/delete session folders,
  read `steps.json` for the UI.

- **Web UI**
  - Session list: name, step count, duration, device, created date, Delete.
  - Session detail: thumbnail timeline (one thumbnail per step, labeled
    tap/swipe + coordinates), live "● Recording" indicator during capture,
    Replay / Export / Delete buttons, replay progress bar keyed to step index.

## Data Flow

**Record:** user picks a device + names the session → clicks Record →
Recorder starts the `getevent` child process → each completed gesture streams
a step + thumbnail to the UI in real time → user clicks Stop → child process
is killed, `steps.json`/`device.json` are finalized and written.

**Replay:** user opens a saved session → clicks Replay → server checks the
currently connected device's serial/resolution against the session's
`device.json` and warns (but does not block) on mismatch → Replayer pipes
`events.log` through `sendevent` with original timing → UI shows replay
progress per step, with optional re-screenshot per step for comparison against
the original.

## Capture Method

Raw `getevent`/`sendevent`, not synthesized `input tap`/`input swipe` commands.
This captures exact gesture data (taps, swipes, drags, multi-touch) with
original timing, and replay is a literal, frame-accurate playback of what was
recorded. Trade-off: a recording is tied to the exact device/screen
resolution/input event node it was captured on — replaying a session on a
different device requires re-recording there.

## Error Handling

- No device connected → block Record with a clear error, don't start capture.
- Device unplugged mid-recording → stop gracefully, keep the partial session
  (whatever steps were captured before disconnect).
- Replay attempted with no device, or a device whose serial/resolution
  doesn't match `device.json` → warn and require explicit confirmation before
  proceeding (never silently replay against a mismatched device).
- Corrupt or empty `events.log` → refuse replay with a clear message rather
  than silently no-op.

## Testing / Scope

This is a personal dev tool — no need for a full test suite. The one piece of
real logic worth unit testing is the `getevent` raw-line parser (raw text →
discrete gesture steps), since a parsing bug there would silently corrupt
every recorded session. Everything else (adb process management, file I/O,
UI) is exercised by manual dogfooding against a real emulator/device.

## Out of Scope (for this iteration)

- Cross-device/cross-resolution replay portability.
- Multi-device simultaneous recording.
- Automated CI test running against recorded sessions (this is a manual
  debugging aid, not a CI test framework).
