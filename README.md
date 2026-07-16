# adb-recorder

Record touch input on an Android device/emulator via `adb`, browse a screenshot
per gesture, and replay a recorded session verbatim.

## Requirements

- Node.js 20+
- `adb` on your `PATH`, with exactly one device/emulator connected (or pass a
  specific serial in the UI's device dropdown if multiple are attached)
- **Replay fidelity depends on root.** Raw replay uses `adb shell sendevent`,
  which writes directly to `/dev/input/eventN`; on a production ("user" build)
  device or emulator SELinux denies that write to the `shell` domain, so raw
  replay needs a rooted device or a `userdebug`/`eng` AVD (`adb root`
  succeeds — check with `adb shell getprop ro.build.type`). On unrooted
  devices replay **automatically falls back** to synthesizing the recorded
  gestures with `adb shell input tap`/`input swipe` (scaled to the target
  screen), which works everywhere but loses pressure/multi-touch nuance.
  Recording only needs read access via `getevent`, which works on any build.

## Usage

    npm install
    npm start

Open http://localhost:4545, name a session, pick a device, click **Record**,
then interact with your device/emulator normally — each tap/swipe is captured
with a screenshot in real time. Click **Stop** when done.

From the session page you can **Replay** the recorded session on the same or
a different device (a confirmation is required if the target device's
resolution/serial doesn't match what was recorded), or **Export** the session
as a `.tar.gz` (raw event log, step metadata, and screenshots).

## Tests

    npm test

## How it works

See `docs/superpowers/specs/2026-07-16-adb-recorder-design.md` for the full
design. In short: `adb shell getevent -t <node>` streams raw numeric touch
events, which are grouped into discrete tap/swipe gestures, screenshotted, and
saved to `sessions/<name>/`. Replay pipes the same raw events back through
`adb shell sendevent`, preserving original timing.
