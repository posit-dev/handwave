import marimo

__generated_with = "0.25.2"
app = marimo.App(width="medium")


@app.cell
def _():
    import asyncio
    import math

    import marimo as mo
    import napari
    import numpy as np
    from qtpy.QtWidgets import QApplication
    from skimage import data

    from handwave import HandwaveWidget

    return HandwaveWidget, QApplication, asyncio, data, math, mo, napari, np


@app.cell
def _(QApplication, asyncio):
    # marimo has no `%gui qt`, but its kernel keeps an asyncio loop running
    # between cells. Pumping Qt from a background task keeps napari's window
    # responsive (it freezes only while a cell is running).
    async def _pump_qt():
        while True:
            app = QApplication.instance()
            if app is not None:
                app.processEvents()
            await asyncio.sleep(0.01)

    # Keep a reference: the event loop only holds tasks weakly.
    qt_pump = asyncio.get_running_loop().create_task(_pump_qt())
    return (qt_pump,)


@app.cell
def _(data, napari, qt_pump):
    qt_pump  # start the Qt pump first
    viewer = napari.Viewer(ndisplay=3)
    # Synthetic 3D volume, so no download is needed
    volume = data.binary_blobs(length=128, n_dim=3, volume_fraction=0.05, rng=0)
    viewer.add_image(
        volume.astype(float),
        name="blobs",
        colormap="magenta",
        rendering="attenuated_mip",
    )
    return (viewer,)


@app.cell
def _(math, np, viewer):
    ASPECT = 240 / 320  # widget height / width, to put pinch y in frame widths
    GRAB_GAIN = 1.5  # canvas widths panned per frame width of fist movement

    # Where each pinching hand is (frame widths), for two-handed zoom and roll.
    pinches = {}


    def rotate_about(vec, axis, theta):
        """Rotate `vec` by `theta` radians about `axis` (Rodrigues' formula)."""
        axis = axis / np.linalg.norm(axis)
        return (
            vec * math.cos(theta)
            + np.cross(axis, vec) * math.sin(theta)
            + axis * np.dot(axis, vec) * (1 - math.cos(theta))
        )


    def screen_axes():
        """World directions that point right and up on the canvas."""
        if viewer.dims.ndisplay == 3:
            view = np.array(viewer.scene.camera.view_direction)
            up = np.array(viewer.scene.camera.up_direction)
            return np.cross(view, up), up
        return np.array([0.0, 0.0, 1.0]), np.array([0.0, -1.0, 0.0])


    def pinch_span(hands):
        """Vector from the left hand's pinch point to the right's, in frame widths."""
        (lx, ly), (rx, ry) = hands["Left"], hands["Right"]
        return rx - lx, ry - ly


    def grab(event):
        """Fist: drag the data around, like grabbing it."""
        if event.type != "move":
            return
        right, up = screen_axes()
        # Frame widths -> canvas pixels -> world units
        scale = GRAB_GAIN * viewer.window._qt_viewer.canvas.native.width() / viewer.scene.camera.zoom
        center = np.array(viewer.scene.camera.center)
        viewer.scene.camera.center = tuple(center - scale * (event.dx * right - event.dy * up))


    def pinch(event):
        """Both hands pinching: spread or bring together to zoom, turn to roll."""
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
        bx, by = pinch_span(before)
        ax, ay = pinch_span(pinches)
        if math.hypot(bx, by) < 0.02:
            return
        viewer.scene.camera.zoom *= math.hypot(ax, ay) / math.hypot(bx, by)
        turn = (math.atan2(ay, ax) - math.atan2(by, bx) + math.pi) % (2 * math.pi) - math.pi
        if viewer.dims.ndisplay == 3:
            # Rotating the camera's up vector by -turn turns the data by +turn
            # (clockwise on screen).
            view = np.array(viewer.scene.camera.view_direction)
            up = np.array(viewer.scene.camera.up_direction)
            viewer.scene.camera.set_view_direction(view, rotate_about(up, view, -turn))


    def drive_napari(event):
        if event.gesture == "fist":
            grab(event)
        else:
            pinch(event)

    return (drive_napari,)


@app.cell
def _(HandwaveWidget, drive_napari, mo):
    handwave_widget = HandwaveWidget(max_num_hands=2, width=320, height=240, debug=True)
    handwave_widget.on_clutch(drive_napari)
    widget = mo.ui.anywidget(handwave_widget)
    mo.vstack([
        widget,
        mo.md(
            "Make a fist and move it to drag the data around. Pinch with both "
            "hands, then spread them apart or bring them together to zoom, and "
            "turn the line between them to roll the view."
        ),
    ])
    return


if __name__ == "__main__":
    app.run()
