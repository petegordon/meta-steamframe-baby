# Frame Hands: a native Steam Frame app

A small VR app that runs **on the Steam Frame itself** (no PC, no browser). It draws your hands, tracked by the headset's own cameras, and lets you interact with no controllers:

- **Point** with your hand. A ray comes out along your fingers.
- **Make a fist** while the ray is on a red button to **click** it. Clicking changes the block colours.
- **Make a fist** while the ray is on a block to **grab** it. Move your hand to carry it, and open your hand to drop it.

This is an early experiment. Expect wobbly hands. Your feedback is the whole point of this build.

## How it works

```
Frame cameras ─▶ hand tracker (spyjacob/steam-frame-hand-tracking, runs on the headset)
              ─▶ UDP 127.0.0.1:47811 ─▶ Frame Hands (Godot 4 + OpenXR, this app)
```

- The camera access and hand tracking come from [spyjacob/steam-frame-hand-tracking](https://github.com/spyjacob/steam-frame-hand-tracking) (MIT). Only its **headset** part is used. Its PC driver is not needed.
- This app subscribes to that tracker locally. It places each hand using the head pose from when the camera saw it, and draws a simple hand from the palm pose and finger bends.

---

## For the Steam Frame owner: setup

You need SSH or a terminal on the Frame (Desktop Mode → Konsole works). Every command below runs **on the Frame**.

### 1. Install the hand tracker (headset part only)

Follow the **"Install → Headset"** section of
<https://github.com/spyjacob/steam-frame-hand-tracking#install>. In short:

```bash
git clone https://github.com/spyjacob/steam-frame-hand-tracking ~/handtrack/src
cd ~/handtrack/src
python3 -m venv ~/handtrack/venv
~/handtrack/venv/bin/pip install mediapipe opencv-python numpy onnxruntime
tools/fetch_models.sh
capture/build.sh && capture/install.sh
mkdir -p ~/.config/mrhand && touch ~/.config/mrhand/enable-capture
systemctl --user restart steamvr
cp headset/*.sh headset/start_args ~/handtrack/
overlay/install_overlay.sh        # optional: "Hand Tracking" on/off panel in the SteamVR dashboard
```

Skip their **PC** section entirely.

> ⚠️ **Read their warnings first.**
> - The tracker adds a small capture layer to SteamVR's compositor. `capture/uninstall.sh` removes it.
> - It makes the Frame run hot. Their watchdog stops tracking at 93 °C.
> - If tracking keeps stopping, turn on only one hand in the Hand Tracking panel.

**Check it's working.** Run `~/handtrack/start.sh`, hold a hand up in front of the headset, then run `tail /tmp/live.log`. You should see hands detected; `hands/run 0.00` means it sees none.

### 2. Download Frame Hands

```bash
cd ~
curl -L -o frame-hands.zip https://github.com/petegordon/meta-steamframe-baby/releases/download/native-latest/frame-hands-linux-arm64.zip
unzip -o frame-hands.zip        # creates ~/frame-hands/
cat ~/frame-hands/build_info.json   # which build you have
```

Run the same commands again to update. The latest build is always at that URL.

### 3. Run it

Make sure SteamVR is running on the headset. Then, from a terminal in Desktop Mode:

```bash
~/frame-hands/run.sh
```

`run.sh` starts the hand tracker, then the app, and logs to `/tmp/frame-hands.log`.

**Start it from the Steam library instead (nicer).** In Desktop Mode, open Steam → **Games → Add a Non-Steam Game to My Library** → Browse → pick `~/frame-hands/run.sh`. Then launch "run.sh" from the library inside the headset. You can rename it to "Frame Hands".

**Try the app without the tracker** (to check the app itself works):

```bash
~/frame-hands/run.sh --fake
```

This shows simulated hands that wave around, point at the buttons and make fists.

### 4. Use it

- A status panel floats above the button board. It shows the build, whether the tracker is connected, and each hand: `open`, `FIST` or `—` (not seen).
- Hold your hands up in front of you, where the cameras can see them.
- Point at a red button and close your hand into a fist to click.
- Point at a block on the table, make a fist to grab it, move your hand, and open it to drop.

### 5. Stop it

Close the app (or press the Steam button and quit), then stop the tracker so the Frame cools down:

```bash
~/handtrack/stop.sh
```

The Hand Tracking dashboard panel can also turn it off.

---

## Please report back

Send the contents of `/tmp/frame-hands.log` and answers to these:

1. Did the app open in the headset? If not, what's in the log?
2. Does the status panel say **Tracker connected**?
3. Do your hands appear, in roughly the right place, and follow your hands when you turn your head?
4. Can you click a button? Can you grab and move a block?
5. Did it get too hot or stop?

## Troubleshooting

| Symptom | Try |
|---|---|
| App window opens on the desktop but not in the headset | SteamVR must be running. The log shows which OpenXR runtime was used. Set it by hand: `XR_RUNTIME_JSON=/path/to/steamxr_linux64.json ~/frame-hands/run.sh` (find the file with `find / -name 'steamxr*.json' 2>/dev/null`) |
| `frame-hands.arm64: cannot execute` / permission denied | `chmod +x ~/frame-hands/run.sh ~/frame-hands/frame-hands.arm64` |
| Black screen or graphics errors | Try OpenGL: `~/frame-hands/run.sh -- --rendering-driver opengl3` |
| "Waiting for the hand tracker" | Tracker not running: `~/handtrack/start.sh`, then check `/tmp/live.log` |
| Hands show but in the wrong place / mirrored | Note what you see (and a photo if possible). The tracker's head-frame conventions may differ from what we assumed |
| Tracking stops after a while | Thermal watchdog (`/tmp/watchdog.log`). Use one hand, let it cool |

## Developing

- `native/godot/` holds the Godot 4.7 project. Open it in the Godot editor or run it directly.
- **Desktop test with simulated hands:** run `python3 native/tools/fake_hands.py`, then `godot --path native/godot --xr-mode off`.
- **Builds:** `.github/workflows/native.yml` exports a Linux ARM64 binary on every push to `main` that touches `native/`, and uploads it to the `native-latest` release.
