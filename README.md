# handwave

Wave your hands at your webcam, and have your Python app wave back.

(screenshot)

handwave is an [anywidget](https://anywidget.org/), so it works in Jupyter, marimo and Shiny. It watches your hands with Google's [MediaPipe](https://ai.google.dev/edge/mediapipe/solutions/guide), right in the browser, and turns a handful of gestures into Python events: grab something with a fist and move it, twist a dial, clap twice to start over. We built it to explore data by hand, like turning a 3D microscopy image around in [napari](https://napari.org/) as if you were holding it.

Thank you to [Trevor Manz](https://trevorma.nz/) for the widget-ization of this code!

## Try it

You'll need a webcam, [uv](https://docs.astral.sh/uv/) and, for now, [Node.js](https://nodejs.org/) (installing from source builds the widget's JavaScript).

```sh
git clone https://github.com/posit-dev/handwave.git
cd handwave
uv run --group examples marimo edit examples/napari/example.py
```

That's the napari demo: a 3D image of cells you can turn, pan, zoom and slice through, all without touching the mouse. The other examples are smaller:

```sh
uv run --group examples marimo edit examples/marimo/example.py      # a shape to drag, turn and zoom
uv run --group examples shiny run examples/shiny/app.py             # a 3D plotly plot
uv run --group examples jupyter lab examples/notebook/example.ipynb # ipywidgets in Jupyter
```

To use handwave in your own project (it isn't on PyPI yet):

```sh
pip install git+https://github.com/posit-dev/handwave.git
```

## Gestures

| Gesture | How | Events |
|---|---|---|
| **Pinch** | Make an "OK" sign, then touch your thumb and index fingertips. Move, twist, or push toward the camera while pinching. | clutch, `gesture="pinch"` |
| **Fist** | Curl all four fingers in. Move it, or turn it like you're holding something. | clutch, `gesture="fist"` |
| **Finger gun** | Index finger and thumb out, other fingers curled. Aim it around; drop your thumb onto your index finger to pull the trigger. | clutch, `gesture="gun"` |
| **Claw** | The grip for turning a doorknob: fingers straight at the knuckles, curled at the tips. Twist it like a dial. | clutch, `gesture="claw"` |
| **Double clap** | Clap, brief pause, clap. | `on_clap` |
| **Reel** | Point double-barrelled finger guns (index and middle fingers) at each other. Hold your left hand still and circle your right, like winding a fishing reel. Each turn is one step; clockwise (as you see it in the preview) is forward. | `on_reel` |

The first four are *clutches*. Hold the pose still for a beat to engage it; from then on your hand's movement is reported until you open your hand to let go. Releasing, moving your hand somewhere comfortable and grabbing again works like lifting a mouse off its pad. This is also how handwave tells "I mean this" from "I'm just scratching my nose." If your hand slips out of the frame mid-clutch, the clutch waits for it to come back rather than ending.

Each hand clutches on its own, so with `max_num_hands=2` you can use two at once (say, two pinches to zoom). Clap and reel need two hands as well. If a gesture isn't catching, `debug=True` shows what handwave sees.

## Usage

```python
from handwave import HandwaveWidget

widget = HandwaveWidget(max_num_hands=2)

@widget.on_clutch
def on_clutch(event):
    if event.gesture == "fist" and event.type == "move":
        move_by(event.dx, event.dy)

@widget.on_clap
def on_clap(event):
    reset_view()

@widget.on_reel
def on_reel(event):
    show_item(current + event.direction)  # 1 or -1

widget
```

### Clutch events

Each clutch sends a `"start"` event, a `"move"` event per video frame, then an `"end"` event. A `ClutchEvent` has:

| Field | |
|---|---|
| `type` | `"start"`, `"move"` or `"end"`. |
| `gesture` | `"pinch"`, `"fist"`, `"gun"` or `"claw"`. |
| `hand` | `"Left"` or `"Right"`. |
| `x`, `y` | Where the hand is (the pinch point, or the middle of your knuckles), from 0 to 1 across the frame. Mirrored like the preview, so x increases toward your right. |
| `dx`, `dy` | Movement since the last event, in frame widths. Down is positive. |
| `dtheta` | Change in roll, in radians. Clockwise is positive. |
| `dscale` | Change in your hand's apparent size, as a ratio. Above 1 means toward the camera. |
| `drotation` | Change in your hand's 3D orientation, as a rotation vector in screen coordinates (x right, y down, z into the screen). Zeros for a pinch. |
| `trigger` | Finger gun only: whether the trigger is pulled. |

Build on the relative values (`dx`, `dtheta` and friends) rather than `x` and `y`, so letting go and grabbing again doesn't make anything jump. `drotation` drops straight into `scipy.spatial.transform.Rotation.from_rotvec()`. If you use it to turn a 3D view, give the view some depth cues (perspective, an axes indicator): without them, a turning volume looks the same either way round, and it's easy to see it turning backwards.

`widget.clutched_hands` lists the hands that are clutching right now, and can be observed like any other trait.

### Landmarks

If you'd rather work with the raw hand tracking, `widget.hands` is a list of pandas data frames, one per hand, with MediaPipe's 21 landmarks; `widget.hand` is just the first. Each has `.attrs["handedness"]` and `.attrs["handedness_score"]`. (Left and Right can come out swapped, depending on whether your camera mirrors its video.)

## Options

| Option | Default | |
|---|---|---|
| `max_num_hands` | 1 | Hands to track. Use 2 for two-handed gestures. |
| `model_complexity` | 1 | 0 is faster, 1 is more accurate. |
| `min_detection_confidence` | 0.5 | |
| `min_tracking_confidence` | 0.5 | |
| `width`, `height` | 640, 480 | Size of the video stream, in pixels. |
| `frame_of_reference` | `"image"` | Landmark origin: the image corner, or `"world"` for the center of the hand. |
| `precision` | 3 | Decimal places for landmark coordinates. |
| `pinch_engage_threshold` | 0.25 | Pinch ratio below which a pinch engages. |
| `pinch_release_threshold` | 0.4 | Pinch ratio above which it lets go. |
| `debug` | `False` | Show what the gesture recognizer sees. |

## Offline use

MediaPipe's model isn't bundled with handwave. The first time the widget runs, it downloads what it needs (about 16 MB) from jsDelivr and caches it, and after that it works without a connection. To fetch everything ahead of time (about 24 MB, including the files for `model_complexity=0` and older browsers):

```sh
python -m handwave download
```

or call `handwave.download_assets()`. `python -m handwave cache-dir` shows where the files go; set `HANDWAVE_CACHE_DIR` to put them somewhere else.

## Development

```sh
npm install
npm run dev    # rebuilds the JavaScript as you edit js/
```

Then open `examples/notebook/example.ipynb` with `uv run jupyter lab` and uncomment its development cell to pick up your changes live. Run the gesture tests with `npm test`.
