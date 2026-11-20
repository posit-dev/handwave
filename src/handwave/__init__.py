import importlib.metadata
import pathlib

import anywidget
import pandas as pd
import traitlets

from ._assets import AssetUnavailableError, cache_dir, download_assets, get_asset

__all__ = ["HandwaveWidget", "download_assets", "cache_dir"]

try:
    __version__ = importlib.metadata.version("handwave")
except importlib.metadata.PackageNotFoundError:
    __version__ = "unknown"

bundler_output_dir = pathlib.Path(__file__).parent / "static"


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

    # state
    hands_data = traitlets.List(None, allow_none=True).tag(sync=True)
    handedness = traitlets.List(
        trait=traitlets.Tuple(traitlets.Unicode(), traitlets.Float()), allow_none=True
    ).tag(sync=True)

    is_tracking = traitlets.Bool(False).tag(sync=True)
    camera_active = traitlets.Bool(False).tag(sync=True)

    _esm = bundler_output_dir / "widget.js"
    _css = bundler_output_dir / "widget.css"

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.on_msg(self._on_custom_msg)

    def _on_custom_msg(self, _widget, content, _buffers):
        """Serve MediaPipe files to the browser from the local cache."""
        if not isinstance(content, dict) or content.get("type") != "handwave:get_asset":
            return
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
