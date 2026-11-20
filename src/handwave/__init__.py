import dataclasses
import importlib.metadata
import pathlib
import typing

import anywidget
import pandas as pd
import traitlets

from ._assets import AssetUnavailableError, cache_dir, download_assets, get_asset

__all__ = [
    "HandwaveWidget",
    "ClutchEvent",
    "ClapEvent",
    "ReelEvent",
    "download_assets",
    "cache_dir",
]

try:
    __version__ = importlib.metadata.version("handwave")
except importlib.metadata.PackageNotFoundError:
    __version__ = "unknown"

bundler_output_dir = pathlib.Path(__file__).parent / "static"


@dataclasses.dataclass(frozen=True)
class ClutchEvent:
    """A clutch event (pinch, fist or finger gun), delivered to callbacks registered with
    `HandwaveWidget.on_clutch()`.

    A gesture is a "start" event, any number of "move" events, then an "end"
    event, all with the same `gesture`. Use the relative fields (`dx`, `dy`,
    `dtheta`, `dscale`) to drive whatever you're manipulating; releasing and
    re-engaging then lets you reposition your hand without moving the data
    (like lifting a mouse).
    """

    type: typing.Literal["start", "move", "end"]
    """Phase of the gesture."""
    gesture: typing.Literal["pinch", "fist", "gun"]
    """Which clutch gesture produced the event: an "OK sign" pinch, a fist, or a
    finger gun (index and thumb out, other fingers curled)."""
    hand: typing.Literal["Left", "Right"]
    """Which hand (subject to the usual handedness caveats)."""
    x: float
    """Gesture point (the pinch, or the knuckles of a fist or gun), 0 (user's left) to 1
    (user's right), mirrored like the preview."""
    y: float
    """Gesture point, 0 (top) to 1 (bottom)."""
    dx: float
    """Horizontal movement since the last event, in frame widths."""
    dy: float
    """Vertical movement since the last event, in frame widths (down is positive)."""
    dtheta: float
    """Change in hand roll since the last event, in radians (clockwise is positive)."""
    dscale: float
    """Multiplicative change in apparent hand size (> 1 means moving toward the camera)."""
    t: float
    """Browser timestamp, in milliseconds."""
    drotation: tuple[float, float, float] = (0.0, 0.0, 0.0)
    """Fist or finger gun (zero for a pinch): change in the hand's 3D orientation since
    the last event, as a rotation vector (axis times angle, in radians) in screen
    coordinates: x toward the user's right, y down, z into the screen: the
    hand's physical turn, from the user's point of view. Rotate something by
    this to turn it with the hand, e.g. with
    `scipy.spatial.transform.Rotation.from_rotvec(event.drotation)`."""


@dataclasses.dataclass(frozen=True)
class ClapEvent:
    """A double clap (two claps with a brief pause between), delivered to
    callbacks registered with `HandwaveWidget.on_clap()`. Needs
    `max_num_hands=2`."""

    type: typing.Literal["clap"]
    x: float
    """Where the hands met the second time, 0 (user's left) to 1 (user's right), mirrored like the preview."""
    y: float
    """Where the hands met, 0 (top) to 1 (bottom)."""
    t: float
    """Browser timestamp, in milliseconds."""


@dataclasses.dataclass(frozen=True)
class ReelEvent:
    """One step from reeling, delivered to callbacks registered with
    `HandwaveWidget.on_reel()`. Needs `max_num_hands=2`.

    Point double-barrelled finger guns (index and middle fingers out, ring
    and pinky curled) at each other, hold the left one still and circle the
    right one, like reeling in a fishing line: each turn is one step.
    """

    type: typing.Literal["reel"]
    direction: typing.Literal[1, -1]
    """1 for forward (circling clockwise, as seen in the preview), -1 for backward."""
    t: float
    """Browser timestamp, in milliseconds."""


ClutchCallback = typing.Callable[[ClutchEvent], typing.Any]
ClapCallback = typing.Callable[[ClapEvent], typing.Any]
ReelCallback = typing.Callable[[ReelEvent], typing.Any]

_CLUTCH_EVENT_FIELDS = {field.name for field in dataclasses.fields(ClutchEvent)}
_CLAP_EVENT_FIELDS = {field.name for field in dataclasses.fields(ClapEvent)}
_REEL_EVENT_FIELDS = {field.name for field in dataclasses.fields(ReelEvent)}


class HandwaveWidget(anywidget.AnyWidget):
    # config
    frame_of_reference = traitlets.Enum(["image", "world"], "image").tag(sync=True)
    max_num_hands = traitlets.Int(1).tag(sync=True)
    model_complexity = traitlets.Float(1.0).tag(sync=True)
    min_detection_confidence = traitlets.Float(0.5).tag(sync=True)
    min_tracking_confidence = traitlets.Float(0.5).tag(sync=True)
    precision = traitlets.Int(3).tag(sync=True)
    debug = traitlets.Bool(False).tag(sync=True)
    width = traitlets.Int(640).tag(sync=True)
    height = traitlets.Int(480).tag(sync=True)
    pinch_engage_threshold = traitlets.Float(0.25).tag(sync=True)
    pinch_release_threshold = traitlets.Float(0.4).tag(sync=True)

    # state
    hands_data = traitlets.List(None, allow_none=True).tag(sync=True)
    handedness = traitlets.List(
        trait=traitlets.Tuple(traitlets.Unicode(), traitlets.Float()), allow_none=True
    ).tag(sync=True)

    is_tracking = traitlets.Bool(False).tag(sync=True)
    camera_active = traitlets.Bool(False).tag(sync=True)
    clutched_hands = traitlets.List(traitlets.Unicode(), []).tag(sync=True)

    _esm = bundler_output_dir / "widget.js"
    _css = bundler_output_dir / "widget.css"

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._clutch_callbacks: list[ClutchCallback] = []
        self._clap_callbacks: list[ClapCallback] = []
        self._reel_callbacks: list[ReelCallback] = []
        self.on_msg(self._on_custom_msg)

    def on_clutch(self, callback: ClutchCallback, remove: bool = False):
        """Register a callback for clutch events (pinch, fist and finger gun).

        The callback receives a `ClutchEvent`. Can be used as a decorator:

            @widget.on_clutch
            def handle(event):
                if event.type == "move":
                    ...

        Pass `remove=True` to unregister a callback.
        """
        if remove:
            self._clutch_callbacks.remove(callback)
        else:
            self._clutch_callbacks.append(callback)
        return callback

    def on_clap(self, callback: ClapCallback, remove: bool = False):
        """Register a callback for double claps (needs `max_num_hands=2`).

        The callback receives a `ClapEvent`. Can be used as a decorator:

            @widget.on_clap
            def handle(event):
                reset_view()

        Pass `remove=True` to unregister a callback.
        """
        if remove:
            self._clap_callbacks.remove(callback)
        else:
            self._clap_callbacks.append(callback)
        return callback

    def on_reel(self, callback: ReelCallback, remove: bool = False):
        """Register a callback for reeling steps (needs `max_num_hands=2`).

        The callback receives a `ReelEvent`, one per turn. Can be used as a
        decorator:

            @widget.on_reel
            def handle(event):
                show_item(current + event.direction)

        Pass `remove=True` to unregister a callback.
        """
        if remove:
            self._reel_callbacks.remove(callback)
        else:
            self._reel_callbacks.append(callback)
        return callback

    def _on_custom_msg(self, _widget, content, _buffers):
        if not isinstance(content, dict):
            return
        if content.get("type") == "handwave:clutch":
            self._dispatch_clutch(content.get("events", []))
        elif content.get("type") == "handwave:clap":
            self._dispatch(
                [
                    ClapEvent(**{k: v for k, v in fields.items() if k in _CLAP_EVENT_FIELDS})
                    for fields in content.get("events", [])
                ],
                self._clap_callbacks,
            )
        elif content.get("type") == "handwave:reel":
            self._dispatch(
                [
                    ReelEvent(**{k: v for k, v in fields.items() if k in _REEL_EVENT_FIELDS})
                    for fields in content.get("events", [])
                ],
                self._reel_callbacks,
            )
        elif content.get("type") == "handwave:get_asset":
            self._serve_asset(content)

    def _dispatch_clutch(self, events):
        clutch_events = []
        for fields in events:
            # Ignore fields this version doesn't know about, in case the
            # browser is running a different build of the widget.
            known = {k: v for k, v in fields.items() if k in _CLUTCH_EVENT_FIELDS}
            if "drotation" in known:
                known["drotation"] = tuple(known["drotation"])
            clutch_events.append(ClutchEvent(**known))
        self._dispatch(clutch_events, self._clutch_callbacks)

    @staticmethod
    def _dispatch(events, callbacks):
        # Deliver every event to every callback even if one raises, so a
        # failing callback can't swallow another hand's "end" event; then
        # re-raise the first error so it still shows up.
        errors = []
        for event in events:
            for callback in list(callbacks):
                try:
                    callback(event)
                except Exception as e:
                    errors.append(e)
        if errors:
            raise errors[0]

    def _serve_asset(self, content):
        """Serve MediaPipe files to the browser from the local cache."""
        name = content.get("name")
        reply = {"type": "handwave:asset", "name": name}
        try:
            data = get_asset(name)
        except AssetUnavailableError as e:
            self.send({**reply, "error": str(e)})
            return
        self.send(reply, buffers=[data])

    @property
    def hands(self) -> list[pd.DataFrame]:
        """Return landmarks as a pandas DataFrame."""

        if self.hands_data is None:
            return None
        return [
            construct_hand(hand, label, score)
            for hand, (label, score) in zip(self.hands_data, self.handedness)
        ]

    @property
    def hand(self) -> pd.DataFrame | None:
        """Return the first hand's landmarks as a pandas DataFrame."""
        import pandas as pd

        if self.hands_data is None or len(self.hands_data) == 0:
            return None
        return construct_hand(self.hands_data[0], *self.handedness[0])


def construct_hand(hand_data, label, score) -> pd.DataFrame:
    """Construct a DataFrame from hand data."""
    import pandas as pd

    df = pd.DataFrame(hand_data)
    df.attrs["handedness"] = label
    df.attrs["handedness_score"] = score
    df.index = landmark_names
    return df


landmark_names = [
    "wrist",
    "thumb_cmc",
    "thumb_mcp",
    "thumb_ip",
    "thumb_tip",
    "index_finger_mcp",
    "index_finger_pip",
    "index_finger_dip",
    "index_finger_tip",
    "middle_finger_mcp",
    "middle_finger_pip",
    "middle_finger_dip",
    "middle_finger_tip",
    "ring_finger_mcp",
    "ring_finger_pip",
    "ring_finger_dip",
    "ring_finger_tip",
    "pinky_mcp",
    "pinky_pip",
    "pinky_dip",
    "pinky_tip",
]
