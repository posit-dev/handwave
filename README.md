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

## Configuration options

The widget takes the following configuration options in its constructor:

- **frame_of_reference**: Whether to use the image frame of reference (default) or the world frame of reference for hand landmarks. The image frame of reference will use the corner of the image as the origin. The world frame of reference will use the detected center of the hand as the origin.
- **max_num_hands**: Maximum number of hands to detect (default is 1).
- **model_complexity**: Complexity of the hand landmark model: 0 or 1 (default is 1). Landmark accuracy as well as inference latency generally goes up with the model complexity.
- **min_detection_confidence**: Minimum confidence score for hand detection, from 0 to 1 (default is 0.5).
- **min_tracking_confidence**: Minimum confidence score for hand tracking, from 0 to 1 (default is 0.5).
- **precision**: Number of decimal places to round the landmark coordinates to (default is 3).
- **debug**: Whether to show debug information in the widget (default is False).
- **width**: Width of the video stream in pixels (default is 320).
- **height**: Height of the video stream in pixels (default is 240).

## Development

We recommend using [uv](https://github.com/astral-sh/uv) for development.
It will automatically manage virtual environments and dependencies for you.

```sh
uv run jupyter lab example.ipynb
```

Alternatively, create and manage your own virtual environment:

```sh
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
jupyter lab example.ipynb
```

The widget front-end code bundles it's JavaScript dependencies. After setting up Python,
make sure to install these dependencies locally:

```sh
npm install
```

While developing, you can run the following in a separate terminal to automatically
rebuild JavaScript as you make changes:

```sh
npm run dev
```

Open `example.ipynb` in JupyterLab, VS Code, or your favorite editor
to start developing. Changes made in `js/` will be reflected
in the notebook.
