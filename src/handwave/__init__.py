import importlib.metadata
import pathlib

import anywidget
import pandas as pd
import traitlets

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
    debug = traitlets.Bool(True).tag(sync=True)
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
    return df
