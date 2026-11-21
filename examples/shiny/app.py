"""
A 3D random walk you can handle with your hands.

- Make a fist and turn it to turn the plot, as if you were holding it.
- Pinch with both hands, like two fingers on a trackpad: move them together to
  drag, spread them apart or bring them together to zoom, and turn the line
  between them to roll.
- Clap twice (clap, brief pause, clap) to reset the view.
- Reel to step through walks: point double-barrelled finger guns (index and
  middle fingers out) at each other, hold your left hand still, and circle
  your right hand.

Run with `uv run --group examples shiny run examples/shiny/app.py`.
"""

import math

import numpy as np
import plotly.graph_objects as go
from shiny import App, reactive, render, ui
from shinywidgets import output_widget, reactive_read, render_plotly, render_widget

from handwave import HandwaveWidget

N_STEPS = 400
AIM_GAIN = 1.5  # how far the plot turns per turn of the fist
PAN_GAIN = 1.5  # view distances panned per frame width of two-pinch movement
ASPECT = 240 / 320  # widget height / width, to put pinch y in frame widths
HOME = {"eye": (1.5, 1.5, 1.0), "center": (0.0, 0.0, 0.0), "up": (0.0, 0.0, 1.0)}


def random_walk(seed):
    """A 3D Brownian motion: the running total of normally distributed steps."""
    steps = np.random.default_rng(seed).normal(size=(N_STEPS, 3))
    return np.vstack([np.zeros(3), np.cumsum(steps, axis=0)])


# Rotations -----------------------------------------------------------------


def rotate_about(vec, axis, theta):
    """Rotate `vec` by `theta` radians about `axis` (Rodrigues' formula)."""
    axis = axis / np.linalg.norm(axis)
    return (
        vec * math.cos(theta)
        + np.cross(axis, vec) * math.sin(theta)
        + axis * np.dot(axis, vec) * (1 - math.cos(theta))
    )


def rotation_matrix(rotvec):
    """Rotation matrix for a rotation vector (axis times angle)."""
    theta = np.linalg.norm(rotvec)
    if theta < 1e-12:
        return np.eye(3)
    x, y, z = np.asarray(rotvec) / theta
    k = np.array([[0, -z, y], [z, 0, -x], [-y, x, 0]])
    return np.eye(3) + math.sin(theta) * k + (1 - math.cos(theta)) * k @ k


def rotation_vector(m):
    """Rotation vector (axis times angle) of a rotation matrix."""
    angle = math.acos(min(1.0, max(-1.0, (np.trace(m) - 1) / 2)))
    if angle < 1e-9:
        return np.zeros(3)
    if angle < math.pi - 1e-3:
        w = np.array([m[2, 1] - m[1, 2], m[0, 2] - m[2, 0], m[1, 0] - m[0, 1]])
        return w * angle / (2 * math.sin(angle))
    # Near a half turn, m + I is (twice) the axis times its transpose.
    b = m + np.eye(3)
    axis = b[:, np.argmax(np.linalg.norm(b, axis=0))]
    return axis / np.linalg.norm(axis) * angle


def nearest_turn(rotvec, previous):
    """
    The rotation vector for the same rotation as `rotvec` that's closest to
    `previous` (adding whole turns about its axis), so a turn past half a
    turn keeps growing instead of flipping to the other way round.
    """
    angle = np.linalg.norm(rotvec)
    if angle < 1e-9:
        return rotvec
    axis = rotvec / angle
    candidates = [axis * (angle + 2 * math.pi * k) for k in (-2, -1, 0, 1, 2)]
    return min(candidates, key=lambda c: np.linalg.norm(c - previous))


# Plotly's camera ------------------------------------------------------------


class Camera:
    """
    Plotly's scene camera as vectors: `eye` looks at `center`, with `up`
    pointing up on screen. Plotly's scene coordinates are right-handed, so
    view x up points right.
    """

    def __init__(self, eye, center, up):
        self.eye = np.array(eye, dtype=float)
        self.center = np.array(center, dtype=float)
        view = self.center - self.eye
        self.distance = float(np.linalg.norm(view))
        self.view = view / self.distance
        # Plotly allows an up vector that isn't square to the view; square it up.
        up = np.array(up, dtype=float)
        up = up - np.dot(up, self.view) * self.view
        self.up = up / np.linalg.norm(up)

    @classmethod
    def of(cls, fig):
        camera = fig.layout.scene.camera
        eye, center, up = camera.eye, camera.center, camera.up

        def vec(v, default):
            if v is None or v.x is None:
                return default
            return (v.x, v.y, v.z)

        return cls(vec(eye, HOME["eye"]), vec(center, HOME["center"]), vec(up, HOME["up"]))

    @property
    def right(self):
        return np.cross(self.view, self.up)

    def screen_axes(self):
        """Screen axes in scene coordinates, as columns: right, down, into the
        screen (the same axes as a clutch event's drotation)."""
        return np.stack([self.right, -self.up, self.view], axis=1)

    def apply(self, fig):
        eye = self.center - self.distance * self.view

        def xyz(v):
            return {"x": float(v[0]), "y": float(v[1]), "z": float(v[2])}

        fig.layout.scene.camera = {
            "eye": xyz(eye),
            "center": xyz(self.center),
            "up": xyz(self.up),
        }


# App -------------------------------------------------------------------------

app_ui = ui.page_sidebar(
    ui.sidebar(
        output_widget("handwave", width="320px", height="242px"),
        ui.output_ui("status"),
        ui.markdown(
            """
            - **Turn:** make a fist and turn it.
            - **Drag, zoom, roll:** pinch with both hands, like two fingers on
              a trackpad.
            - **Reset:** clap twice.
            - **Next walk:** point double-barrelled finger guns at each other,
              hold your left hand still, and circle your right one.
            """
        ),
        width=360,
    ),
    output_widget("plot", fillable=True),
    title="Hands on a random walk",
    fillable=True,
)


def server(input, output, session):
    seed = reactive.value(1)
    # Each fist's turn since it engaged, and the camera at that moment, so the
    # view follows the hand's total turn and never drifts (see `aim`).
    aims = {}
    # Where each pinching hand is (frame widths), for two-handed gestures.
    pinches = {}

    @render_plotly
    def plot():
        # Render once: gestures update this figure in place, so the view
        # doesn't jump back when a new walk comes in.
        with reactive.isolate():
            walk = random_walk(seed.get())
        steps = np.arange(len(walk))
        fig = go.FigureWidget(
            go.Scatter3d(
                x=walk[:, 0],
                y=walk[:, 1],
                z=walk[:, 2],
                mode="lines+markers",
                marker={"size": 2.5, "color": steps, "colorscale": "Viridis"},
                line={"width": 3, "color": steps, "colorscale": "Viridis"},
                hovertemplate="step %{marker.color}<extra></extra>",
            )
        )
        fig.update_layout(
            margin={"l": 0, "r": 0, "t": 40, "b": 0},
            scene={
                "camera": {
                    "eye": dict(zip("xyz", HOME["eye"])),
                    "center": dict(zip("xyz", HOME["center"])),
                    "up": dict(zip("xyz", HOME["up"])),
                    "projection": {"type": "perspective"},
                },
                "aspectmode": "cube",
                # Keep mouse dragging from snapping the up vector back to z.
                "dragmode": "orbit",
            },
            uirevision="walk",  # keep the view when the data changes
        )
        return fig

    def aim(event):
        """Fist: the plot turns the way your hand turns, as if holding it."""
        fig = plot.widget
        if event.type == "start":
            camera = Camera.of(fig)
            aims[event.hand] = {
                "camera": camera,
                "screen": camera.screen_axes(),
                # How the hand has turned since, as a matrix and a rotation vector.
                "hand": np.eye(3),
                "turn": np.zeros(3),
            }
            return
        if event.type == "end":
            aims.pop(event.hand, None)
            return
        state = aims.get(event.hand)
        if state is None:
            return
        # Add up the hand's total turn, and turn the view by a multiple of that
        # (scaled-up 3D turns made frame by frame don't cancel out, so the view
        # would drift).
        state["hand"] = rotation_matrix(np.array(event.drotation)) @ state["hand"]
        state["turn"] = nearest_turn(rotation_vector(state["hand"]), state["turn"])
        turn = rotation_matrix(AIM_GAIN * state["turn"])
        # Turning the plot by `turn` is turning the camera's axes the other way.
        turned = state["screen"] @ turn.T
        camera = Camera.of(fig)
        camera.view, camera.up = turned[:, 2], -turned[:, 1]
        camera.apply(fig)

    def pinch(event):
        """Both hands pinching: drag, zoom and roll."""
        if event.type == "start":
            pinches[event.hand] = (event.x, event.y * ASPECT)
            return
        if event.type == "end":
            pinches.pop(event.hand, None)
            return
        # Track each pinch by adding up its movement, so nothing jumps.
        before = dict(pinches)
        hx, hy = pinches.get(event.hand, (event.x, event.y * ASPECT))
        pinches[event.hand] = (hx + event.dx, hy + event.dy)
        if len(before) != 2:
            return
        (blx, bly), (brx, bry) = before["Left"], before["Right"]
        (alx, aly), (arx, ary) = pinches["Left"], pinches["Right"]
        bx, by = brx - blx, bry - bly
        ax, ay = arx - alx, ary - aly
        if math.hypot(bx, by) < 0.02:
            return
        fig = plot.widget
        camera = Camera.of(fig)
        # Spread apart to zoom in.
        zoom = math.hypot(ax, ay) / math.hypot(bx, by)
        camera.distance = min(8.0, max(0.3, camera.distance / zoom))
        # Drag by how far the point midway between the pinches moved.
        dx = (alx + arx - blx - brx) / 2
        dy = (aly + ary - bly - bry) / 2
        camera.center = camera.center - PAN_GAIN * camera.distance * (
            dx * camera.right - dy * camera.up
        )
        # Rotating the camera's up vector by -turn turns the plot by +turn
        # (clockwise on screen).
        turn = (math.atan2(ay, ax) - math.atan2(by, bx) + math.pi) % (2 * math.pi) - math.pi
        camera.up = rotate_about(camera.up, camera.view, -turn)
        camera.apply(fig)

    def on_clutch(event):
        # Finger guns do nothing here.
        if event.gesture == "fist":
            aim(event)
        elif event.gesture == "pinch":
            pinch(event)

    def on_clap(event):
        Camera(**HOME).apply(plot.widget)

    def on_reel(event):
        seed.set(max(1, seed.get() + event.direction))
        walk = random_walk(seed.get())
        with plot.widget.batch_update():
            plot.widget.data[0].x = walk[:, 0]
            plot.widget.data[0].y = walk[:, 1]
            plot.widget.data[0].z = walk[:, 2]

    @render_widget
    def handwave():
        widget = HandwaveWidget(max_num_hands=2, width=320, height=240)
        widget.on_clutch(on_clutch)
        widget.on_clap(on_clap)
        widget.on_reel(on_reel)
        return widget

    @render.ui
    def status():
        # Take a dependency on which hands are clutching.
        clutched = reactive_read(handwave.widget, "clutched_hands")
        return ui.p(
            ui.strong(f"Walk #{seed.get()}"),
            ui.br(),
            "Clutched: ",
            ", ".join(clutched) or "none",
        )


app = App(app_ui, server)
