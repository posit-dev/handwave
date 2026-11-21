import marimo

__generated_with = "0.25.2"
app = marimo.App(width="medium")


@app.cell
def _():
    import asyncio
    import ctypes
    import ctypes.util
    import math
    import sys

    import marimo as mo
    import napari
    import numpy as np
    from qtpy.QtCore import QEvent, QPoint, QPointF, Qt
    from qtpy.QtGui import QCursor, QMouseEvent
    from qtpy.QtWidgets import QApplication

    from handwave import HandwaveWidget

    return (
        HandwaveWidget,
        QApplication,
        QCursor,
        QEvent,
        QMouseEvent,
        QPoint,
        QPointF,
        Qt,
        asyncio,
        ctypes,
        math,
        mo,
        napari,
        np,
        sys,
    )


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
def _(napari, qt_pump):
    qt_pump  # start the Qt pump first
    viewer = napari.Viewer(ndisplay=3)
    # napari's canonical sample: a 3D fluorescence image of cells, as two image
    # layers (membranes and nuclei). The first use downloads 11 MB via
    # scikit-image.
    viewer.open_sample("napari", "cells3d")
    # Depth cues, so it's clear which way the data turns: a plain maximum
    # intensity projection with no perspective looks the same turning either
    # way (like a spinning silhouette).
    viewer.scene.camera.perspective = 45
    viewer.axes.visible = True
    for _layer in viewer.layers:
        _layer.rendering = "attenuated_mip"
    return (viewer,)


@app.cell
def _(
    QApplication,
    QCursor,
    QEvent,
    QMouseEvent,
    QPoint,
    QPointF,
    Qt,
    ctypes,
    math,
    np,
    sys,
    viewer,
):
    ASPECT = 240 / 320  # widget height / width, to put pinch y in frame widths
    GRAB_GAIN = 3  # canvas widths panned per frame width of two-pinch movement
    AIM_GAIN = 1.5  # how far the data turns per turn of the fist
    DIAL_DEGREES = 1.5  # how far to twist a claw to step one z slice (2D view)
    POINTER_GAIN = 2  # screen widths the mouse pointer moves per frame width of finger gun movement

    # Where each pinching hand is (frame widths), for two-handed zoom and roll.
    pinches = {}

    # Each fist's turn since it engaged, and the view at that moment, so the
    # view follows the hand's total turn and never drifts (see `aim`).
    aims = {}

    # Each claw's twist (degrees) not yet turned into a z step, so the dial
    # steps a slice per DIAL_DEGREES however the twist is split into events.
    dials = {}

    # The finger gun steering the mouse pointer, and where on the screen the
    # pointer is (unrounded, so slow movement adds up).
    # `pressed` is the napari widget the trigger is holding the mouse button down on.
    pointer = {"hand": None, "x": 0.0, "y": 0.0, "pressed": None}

    # What reeling steps through: all the channels together, then each on its own.
    channel_views = ["all channels", *(layer.name for layer in viewer.layers)]
    channel_view = {"index": 0}


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


    def pan(dx, dy):
        """Drag the data by a hand movement of (dx, dy) frame widths."""
        right, up = screen_axes()
        # Frame widths -> canvas pixels -> world units
        scale = GRAB_GAIN * viewer.window._qt_viewer.canvas.native.width() / viewer.scene.camera.zoom
        center = np.array(viewer.scene.camera.center)
        viewer.scene.camera.center = tuple(center - scale * (dx * right - dy * up))


    def aim(event):
        """Fist: the data turns the way your hand turns, as if holding it."""
        if viewer.dims.ndisplay != 3:
            return
        camera = viewer.scene.camera
        if event.type == "start":
            view = np.array(camera.view_direction)
            up = np.array(camera.up_direction)
            aims[event.hand] = {
                # Screen axes in world coordinates when the fist engaged, as
                # columns: right, down, into the screen (the same axes as
                # event.drotation).
                "screen": np.stack([np.cross(view, up), -up, view], axis=1),
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
        # Add up the hand's turn since the fist engaged. Turning the view by
        # AIM_GAIN times each frame's turn would drift: scaled-up 3D turns don't
        # cancel out, so going out and back left the data turned. Scaling the
        # total turn instead brings the data back whenever the hand comes back.
        state["hand"] = rotation_matrix(np.array(event.drotation)) @ state["hand"]
        state["turn"] = nearest_turn(rotation_vector(state["hand"]), state["turn"])
        # drotation is how the hand physically turned, from the user's point of
        # view: turn the data the same way, as if holding it.
        turn = rotation_matrix(AIM_GAIN * state["turn"])
        # Turning the data by `turn` is turning the camera's axes the other way.
        turned = state["screen"] @ turn.T
        camera.set_view_direction(turned[:, 2], -turned[:, 1])


    def dial(event):
        """
        Claw (the grip for turning a doorknob), in 2D view: twist it to step
        through z.
        """
        if event.type == "start":
            dials[event.hand] = 0.0
            return
        if event.type == "end":
            dials.pop(event.hand, None)
            return
        if viewer.dims.ndisplay != 2 or not viewer.dims.not_displayed:
            return
        dials[event.hand] += math.degrees(event.dtheta)
        steps = int(dials[event.hand] / DIAL_DEGREES)  # toward zero
        if steps == 0:
            return
        # Keep the remainder even when stopped at the first or last slice, so
        # twisting back steps back at once.
        dials[event.hand] -= steps * DIAL_DEGREES
        # The slider napari's arrow keys step (z, for cells3d).
        axis = viewer.dims.last_used
        last = int(viewer.dims.nsteps[axis]) - 1
        step = viewer.dims.current_step[axis] + steps  # clockwise = deeper
        viewer.dims.set_current_step(axis, min(last, max(0, step)))


    def pinch(event):
        """
        Both hands pinching, like two fingers on a trackpad: move them together
        to drag, spread or bring together to zoom, turn to roll.
        """
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
        # Drag by how far the point midway between the pinches moved.
        (blx, bly), (brx, bry) = before["Left"], before["Right"]
        (alx, aly), (arx, ary) = pinches["Left"], pinches["Right"]
        pan((alx + arx - blx - brx) / 2, (aly + ary - bly - bry) / 2)
        turn = (math.atan2(ay, ax) - math.atan2(by, bx) + math.pi) % (2 * math.pi) - math.pi
        if viewer.dims.ndisplay == 3:
            # Rotating the camera's up vector by -turn turns the data by +turn
            # (clockwise on screen).
            view = np.array(viewer.scene.camera.view_direction)
            up = np.array(viewer.scene.camera.up_direction)
            viewer.scene.camera.set_view_direction(view, rotate_about(up, view, -turn))


    def show_channel(index):
        """Show `channel_views[index]` (wrapping around), and say which it is."""
        index %= len(channel_views)
        channel_view["index"] = index
        for layer in viewer.layers:
            layer.visible = index == 0 or layer.name == channel_views[index]
        viewer.canvas.overlays.text.text = channel_views[index]
        viewer.canvas.overlays.text.visible = True


    def step_channel(event):
        """Reeling: step to the next or previous channel."""
        show_channel(channel_view["index"] + event.direction)


    def reset_view(event):
        """Double clap: back to the starting view."""
        viewer.reset_view()


    if sys.platform == "darwin":
        core_graphics = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreGraphics"))

        class CGPoint(ctypes.Structure):
            _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]

        core_graphics.CGWarpMouseCursorPosition.argtypes = [CGPoint]
        core_graphics.CGAssociateMouseAndMouseCursorPosition.argtypes = [ctypes.c_bool]


    def warp_pointer(position):
        """Move the OS mouse pointer to `position`, a QPoint in screen coordinates."""
        if sys.platform == "darwin":
            # Qt moves the pointer by posting a mouse event, which macOS allows only
            # with Accessibility permission. Warping it directly needs none.
            core_graphics.CGWarpMouseCursorPosition(CGPoint(position.x(), position.y()))
            # Otherwise the real mouse stops moving the pointer for a moment.
            core_graphics.CGAssociateMouseAndMouseCursorPosition(True)
        else:
            QCursor.setPos(position)


    def send_mouse(widget, kind, position, buttons):
        """Send a napari widget a left-button mouse event at `position` (screen coordinates)."""
        button = Qt.MouseButton.NoButton if kind == QEvent.Type.MouseMove else Qt.MouseButton.LeftButton
        QApplication.sendEvent(
            widget,
            QMouseEvent(
                kind,
                QPointF(widget.mapFromGlobal(position)),
                QPointF(position),
                button,
                buttons,
                Qt.KeyboardModifier.NoModifier,
            ),
        )


    def let_go(position):
        """Release the mouse button the trigger is holding down, if it is."""
        if pointer["pressed"] is not None:
            send_mouse(pointer["pressed"], QEvent.Type.MouseButtonRelease, position, Qt.MouseButton.NoButton)
            pointer["pressed"] = None


    def point(event):
        """
        Finger gun: move the mouse pointer around the screen from wherever it is,
        like a finger on a trackpad. The latest gun to engage steers it. Pulling
        the trigger presses the left mouse button on whatever part of napari is
        under the pointer (moving meanwhile drags), and letting go releases it.
        """
        if event.type == "start":
            here = QCursor.pos()
            pointer.update(hand=event.hand, x=float(here.x()), y=float(here.y()))
            return
        if event.hand != pointer["hand"]:
            return
        if event.type == "end":
            let_go(QCursor.pos())
            pointer["hand"] = None
            return
        here = QCursor.pos()
        if abs(here.x() - round(pointer["x"])) > 2 or abs(here.y() - round(pointer["y"])) > 2:
            # The real mouse moved the pointer: carry on from there.
            pointer.update(x=float(here.x()), y=float(here.y()))
        screen = QApplication.screenAt(here) or QApplication.primaryScreen()
        # dx and dy are both in frame widths.
        scale = POINTER_GAIN * screen.geometry().width()
        x = pointer["x"] + scale * event.dx
        y = pointer["y"] + scale * event.dy
        if QApplication.screenAt(QPoint(round(x), round(y))) is None:
            # Off every screen: stop at the edge of the one the pointer is on.
            bounds = screen.geometry()
            x = min(max(x, bounds.left()), bounds.right())
            y = min(max(y, bounds.top()), bounds.bottom())
        pointer.update(x=x, y=y)
        position = QPoint(round(x), round(y))
        warp_pointer(position)
        # Moving the OS pointer from code doesn't send Qt a mouse move, so tell
        # napari: a drag goes to what the trigger pressed on, and otherwise the
        # canvas hears about the pointer passing over it and shows what's under it.
        canvas = viewer.window._qt_viewer.canvas.native
        if pointer["pressed"] is not None:
            send_mouse(pointer["pressed"], QEvent.Type.MouseMove, position, Qt.MouseButton.LeftButton)
        elif canvas.isVisible() and canvas.rect().contains(canvas.mapFromGlobal(position)):
            send_mouse(canvas, QEvent.Type.MouseMove, position, Qt.MouseButton.NoButton)
        if event.trigger and pointer["pressed"] is None:
            # Only napari's own windows can be clicked this way. Other apps
            # would need macOS's Accessibility permission.
            target = QApplication.widgetAt(position)
            if target is not None:
                send_mouse(target, QEvent.Type.MouseButtonPress, position, Qt.MouseButton.LeftButton)
                pointer["pressed"] = target
        elif not event.trigger:
            let_go(position)


    def drive_napari(event):
        if event.gesture == "gun":
            point(event)
        elif event.gesture == "fist":
            aim(event)
        elif event.gesture == "pinch":
            pinch(event)
        elif event.gesture == "claw":
            dial(event)

    return drive_napari, reset_view, step_channel


@app.cell
def _(HandwaveWidget, drive_napari, mo, reset_view, step_channel):
    handwave_widget = HandwaveWidget(max_num_hands=2, width=640, height=480, debug=True)
    handwave_widget.on_clutch(drive_napari)
    handwave_widget.on_clap(reset_view)
    handwave_widget.on_reel(step_channel)
    widget = mo.ui.anywidget(handwave_widget)
    mo.vstack([
        widget,
        # mo.md(
        #     "Make a fist and move it to drag the data around. Make a finger gun "
        #     "(index and thumb out) and turn your hand to turn the data. Pinch "
        #     "with both hands, then spread them apart or bring them together to "
        #     "zoom, and turn the line between them to roll the view. In 2D view, "
        #     "grip with a claw, as if turning a doorknob (fingers straight at the "
        #     "knuckles, curled at the tips), and twist it to step through the z "
        #     "slices (clockwise goes deeper). Clap twice "
        #     "(clap, brief pause, clap) to reset the view. To step through the channels, point double-barrelled finger "
        #     "guns (index and middle fingers out) at each other, hold your left hand "
        #     "still, and circle your right hand like reeling in a fishing line: "
        #     "clockwise (as you see it in the preview) for the next channel, the "
        #     "other way for the previous one."
        # ),
    ])
    return


if __name__ == "__main__":
    app.run()
