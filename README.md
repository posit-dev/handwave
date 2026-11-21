# handwave

Handwave is an [anywidget](https://anywidget.org/) for waving your hands around like an idiot and having your computer respond.

(screenshot)

It's based on [Google MediaPipe](https://ai.google.dev/edge/mediapipe/solutions/guide) and uses a webcam to detect hand gestures.

Thank you to [Trevor Manz](https://trevorma.nz/) for the widget-ization of this code!

## Installation

```sh
pip install handwave
```

or with [uv](https://github.com/astral-sh/uv):

```sh
uv add handwave
```

## Usage

### Jupyter notebook

```python
from handwave import HandwaveWidget

widget = HandwaveWidget()
widget
```

This will show a widget that uses your webcam to detect hand gestures.

- You can use the `widget.hands` property to retrieve a list of Pandas data frames of the detected hands and their landmarks (or `None` if no hands are detected).
- You can use the `widget.hand` property to retrieve just the first detected hand and its landmarks, as a Pandas data frame (or `None` if no hand is detected).
- Each hand also has `.attrs["handedness"]` (either "Left" or "Right") and `.attrs["handedness_score"]` properties. Be aware that Left and Right may be swapped depending on whether your camera returns mirrored video or not.

## Pinch clutch

Pinching your thumb and index finger together "clutches" the widget: while you hold the pinch, your hand movements are reported as events, and when you let go they stop. This is how you tell handwave "I mean this" versus "I'm just moving my hand." Release, move your hand somewhere comfortable, and pinch again to keep going, like lifting a mouse off the pad.

Starting a pinch takes a deliberate pose, so a relaxed hand can't start one by accident: make an "OK" sign, with your thumb and index fingertips touching, your other three fingers extended, your whole hand in view, and your hand held still for a moment (about 0.1 seconds). Once it's engaged, only the fingertips need to stay together; the other fingers can relax.

### Fist clutch

Making a fist clutches too, the same way: hold the fist and move, open your hand to let go. Events from a fist have `gesture="fist"` (a pinch's have `gesture="pinch"`), so you can map them to something different, such as panning. To start one, curl all four fingers in (the thumb can be anywhere), with your whole hand in view, and hold it still for a moment (about 0.15 seconds). A loosely curled, relaxed hand doesn't count. Each hand holds one clutch at a time: a pinch stays a pinch if your fingers curl up after it engages.

### Finger gun clutch

A finger gun (index finger out, thumb out, the other three fingers curled) clutches for turning things in 3D. Its events have `gesture="gun"` and a `drotation`: how your hand turned since the last event, so the thing you're holding can turn with it. If you turn a 3D view with it, give the view depth cues (perspective, an axes indicator): without them, a rotating volume looks the same turning either way, and it's easy to perceive the turn backwards. Hold the pose still for a moment to start it, and curl your index finger or open your hand to let go. Pointing with your thumb tucked in doesn't count. Once it's engaged, you can aim anywhere, including straight at the camera.

A fist's events have a `drotation` too, from your palm and knuckles, so you can also turn things by turning your fist.

```python
from scipy.spatial.transform import Rotation

@widget.on_clutch
def on_clutch(event):
    if event.gesture == "gun" and event.type == "move":
        turn = Rotation.from_rotvec(event.drotation)  # in screen coordinates
```

```python
widget = HandwaveWidget()

@widget.on_clutch
def on_clutch(event):
    if event.type == "move":
        print(event.hand, event.dx, event.dy, event.dtheta, event.dscale)
```

Each pinch produces a `"start"` event, then `"move"` events (one per video frame), then an `"end"` event. Each event is a `handwave.ClutchEvent` with:

- **gesture**: `"pinch"`, `"fist"` or `"gun"`.
- **hand**: `"Left"` or `"Right"`. Each hand has its own clutch, so two-handed gestures work with `max_num_hands=2`.
- **x**, **y**: The pinch point (or, for a fist or finger gun, the middle of your knuckles), from 0 to 1 across the frame. x is mirrored like the preview, so it increases toward your right.
- **dx**, **dy**: Movement since the previous event, in frame widths (so horizontal and vertical movement are scaled the same). Down is positive.
- **dtheta**: Change in hand roll since the previous event, in radians. Twist your hand like a dial; clockwise is positive.
- **dscale**: Change in the apparent size of your hand, as a ratio. Greater than 1 means your hand moved toward the camera.
- **drotation**: Fist or finger gun (zeros for a pinch). Change in your hand's 3D orientation from your point of view, as a rotation vector (axis times angle, in radians) in screen coordinates: x toward your right, y down, z into the screen. It relies on MediaPipe's depth estimate, so it's smoothed.

Use the relative values (`dx`, `dy`, `dtheta`, `dscale`) rather than absolute positions, so that releasing and re-pinching doesn't make anything jump. Movement is smoothed with a [One Euro filter](https://gery.casiez.net/1euro/).

The preview shows the clutch state at the pinch point: a ring that fills as your fingers close, a solid cyan dot (with a line back to where you started) while engaged, and an amber ring when the pinch loosens. Loosening the pinch freezes movement without releasing, so your fingers opening doesn't drag the data at the last moment. A fist works the same way, shown as a larger rounded square at your knuckles, and a finger gun as a diamond, except that neither freezes as it loosens: your knuckles stay put as your fingers open, and a fast-moving fist often looks loose for a frame.

If your hand slips out of the frame mid-pinch, the clutch goes on hold rather than ending: no events are sent, and the preview shows a dashed orange ring where your hand left. There's no timeout. Bring your hand back still pinching and the clutch picks up where you are, without a jump (unless it was gone only for a moment, under 0.2 seconds, as when MediaPipe loses a fast-moving hand for a frame: then the movement made meanwhile counts, as if your hand was never lost); bring it back open (and keep it open for a moment, about 5 frames) and it ends. The same happens when only part of your hand goes past the edge: if either pinching fingertip, or the joint just below it, is outside the frame or within 4% of its edge, MediaPipe can only guess where it is, so neither the movement nor whether your fingers look pinched is trusted until both fingertips are back in view. The rest of your hand (knuckles, wrist) can be off the edge without affecting the clutch. For a fist, it's your four fingers (knuckles to tips) that must stay in view; your thumb and wrist can be off the edge.

`widget.clutched_hands` lists the hands that are currently clutching with a pinch or a fist (including clutches on hold), and can be observed like any other trait.

If pinches engage too easily or not easily enough, set `debug=True` to see the live pinch ratio (fingertip distance divided by palm length) and how straight your other fingers are (from 0 to 1; engaging needs 0.85 or more), and adjust `pinch_engage_threshold` and `pinch_release_threshold`. Keep the release threshold comfortably above the engage threshold. The debug display also shows a fist's "reach": how far your farthest fingertip is from your wrist, relative to its knuckle, in 3D (so it still works with your fist pointed at the camera). A fist engages below 1.3; an open hand is around 2. An engaged fist releases once a finger is extended (reach above 1.6 and nearly straight) for 3 frames in a row.

## Clap

With `max_num_hands=2`, clapping twice (clap, brief pause, clap) sends a `ClapEvent` to callbacks registered with `on_clap()`, for one-off actions like resetting a view:

```python
@widget.on_clap
def on_clap(event):
    reset_view()
```

`event.x` and `event.y` are where your hands met the second time, like a clutch event's. The preview shows a small cyan ring for the first clap, then a bigger one expanding from where you clapped the second time.

The second clap must come between 0.25 and 1 second after the first; single claps happened by accident too often to act on. A clap is two hands, at least two hand lengths apart, becoming one (MediaPipe sees clasped hands as a single hand) somewhere between where they were, within 0.3 seconds. Bringing your hands together slowly doesn't count, and neither does one hand leaving the frame (or the other being mostly out of it). Claps are ignored while either hand is clutching.

## Reel

With `max_num_hands=2`, you can step through a list of things (channels, layers, dates) by reeling: point double-barrelled finger guns (index and middle fingers out, ring and pinky curled) at each other, hold your left hand still, and circle your right hand like winding a fishing reel. Each turn sends a `ReelEvent` to callbacks registered with `on_reel()`:

```python
@widget.on_reel
def on_reel(event):
    show_item(current + event.direction)
```

`event.direction` is 1 for forward (circling clockwise, as you see it in the preview) and -1 for backward. The first step comes most of the way (70%) through your first turn, then one per full turn after that. Stopping for a moment starts the count over, and so does dropping the pose; going back the other way takes a full turn, so wobbling just past a step won't undo it. While your hands are in position, the preview shows a ring around your right hand that fills toward the next step and flashes when it steps.

## Offline use

handwave uses Google's [MediaPipe Hands](https://github.com/google-ai-edge/mediapipe) model, which isn't bundled with the package. The first time the widget runs, it downloads the MediaPipe files it needs (about 16 MB) from the jsDelivr CDN and caches them locally. After that, the widget works without an internet connection.

To download everything manually, run:

```sh
python -m handwave download
```

This fetches all of the files (about 24 MB), including the ones for `model_complexity=0` and for browsers without WebAssembly SIMD support. You can also call `handwave.download_assets()` from Python.

Files are cached in `~/Library/Caches/handwave` on macOS, `%LOCALAPPDATA%\handwave` on Windows, and `~/.cache/handwave` elsewhere. Run `python -m handwave cache-dir` to see the location, or set the `HANDWAVE_CACHE_DIR` environment variable to use a different one.

## Configuration options

The widget takes the following configuration options in its constructor:

- **frame_of_reference**: Whether to use the image frame of reference (default) or the world frame of reference for hand landmarks. The image frame of reference will use the corner of the image as the origin. The world frame of reference will use the detected center of the hand as the origin.
- **max_num_hands**: Maximum number of hands to detect (default is 1).
- **model_complexity**: Complexity of the hand landmark model: 0 or 1 (default is 1). Landmark accuracy as well as inference latency generally goes up with the model complexity.
- **min_detection_confidence**: Minimum confidence score for hand detection, from 0 to 1 (default is 0.5).
- **min_tracking_confidence**: Minimum confidence score for hand tracking, from 0 to 1 (default is 0.5).
- **precision**: Number of decimal places to round the landmark coordinates to (default is 3).
- **debug**: Whether to show debug information in the widget (default is False).
- **width**: Width of the video stream in pixels (default is 640).
- **height**: Height of the video stream in pixels (default is 480).
- **pinch_engage_threshold**: Pinch ratio below which a pinch clutch engages (default is 0.25). See [Pinch clutch](#pinch-clutch).
- **pinch_release_threshold**: Pinch ratio above which a pinch clutch releases (default is 0.4).

## Development

We recommend using [uv](https://github.com/astral-sh/uv) for development.
It will automatically manage virtual environments and dependencies for you.

```sh
uv run jupyter lab examples/notebook/example.ipynb
```

Alternatively, create and manage your own virtual environment:

```sh
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
jupyter lab examples/notebook/example.ipynb
```

### Running the examples

The apps in `examples/` need a few more packages (marimo, Shiny, plotly, napari),
collected in the `examples` dependency group:

```sh
uv run --group examples jupyter lab examples/notebook/example.ipynb
uv run --group examples marimo edit examples/marimo/example.py
uv run --group examples marimo edit examples/napari/example.py
uv run --group examples shiny run examples/shiny/app.py
```

Without uv, `pip install --group examples` (pip 25.1 or later) installs the
same packages.

The widget front-end code is built with esbuild. After setting up Python,
make sure to install the JavaScript build dependencies locally:

```sh
npm install
```

While developing, you can run the following in a separate terminal to automatically
rebuild JavaScript as you make changes:

```sh
npm run dev
```

Open `examples/notebook/example.ipynb` in JupyterLab, VS Code, or your favorite editor
to start developing, and uncomment its development cell: then changes made in `js/`
will be reflected in the notebook.
