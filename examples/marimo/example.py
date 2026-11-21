import marimo

__generated_with = "0.25.2"
app = marimo.App(width="medium")


@app.cell
def _():
    import math

    import marimo as mo
    from handwave import HandwaveWidget

    return HandwaveWidget, math, mo


@app.cell
def _(mo):
    # Accumulated "specimen" pose, driven by clutch events.
    # `hands` tracks where each pinching hand is, for two-handed zoom;
    # `fists` lists the hands holding a fist, which drag the specimen around;
    # `grab` is where the fist drag says the specimen should be, before clamping
    # it to the view (so pushing against an edge doesn't lose any distance).
    # `color` is an index into COLORS, stepped by reeling.
    HOME = {"x": 0.5, "y": 0.375, "angle": 0.0, "zoom": 1.0}
    COLORS = ["#00E5FF", "#FF4FA3", "#FFC400", "#76FF03"]
    get_pose, set_pose = mo.state(
        {**HOME, "hands": {}, "fists": [], "grab": (0.5, 0.375), "engaged": [],
         "color": 0, "events": 0}
    )
    return COLORS, HOME, get_pose, set_pose


@app.cell
def _(COLORS, HOME, math, set_pose):
    ASPECT = 240 / 320  # widget height / width, to put pinch y in frame widths
    FIST_GAIN = 1.5  # specimen movement per frame width of fist movement
    TURN_GAIN = 1.5  # specimen turn per turn of the fist


    def pinch_span(hands):
        """Vector from the left hand's pinch point to the right's, in frame widths."""
        (lx, ly), (rx, ry) = hands["Left"], hands["Right"]
        return rx - lx, ry - ly


    def on_clutch(event):
        """Make a fist with either hand and move it to drag the specimen around,
        or turn it (like a dial) to turn the specimen. Pinch with both hands,
        then spread apart or bring together to zoom, and turn the line between
        your hands to rotate. One pinching hand alone does nothing, and neither
        does a finger gun."""
        if event.gesture not in ("fist", "pinch"):
            return

        def update(pose):
            hands = dict(pose["hands"])
            fists = set(pose["fists"])
            pose = dict(pose, events=pose["events"] + 1)
            if event.gesture == "fist":
                if event.type == "start":
                    if not fists:
                        pose["grab"] = (pose["x"], pose["y"])
                    fists.add(event.hand)
                elif event.type == "end":
                    fists.discard(event.hand)
                else:
                    # Follow the fist's total movement since it grabbed; clamp only
                    # what's shown, so pushing into an edge and back doesn't drift.
                    gx, gy = pose["grab"]
                    gx, gy = gx + event.dx * FIST_GAIN, gy + event.dy * FIST_GAIN
                    pose["grab"] = (gx, gy)
                    pose["x"] = min(1.0, max(0.0, gx))
                    pose["y"] = min(0.75, max(0.0, gy))
                    # drotation is in screen coordinates, with z into the screen:
                    # turning about z is turning like a dial, clockwise positive.
                    pose["angle"] += TURN_GAIN * event.drotation[2]
            elif event.type == "start":
                hands[event.hand] = (event.x, event.y * ASPECT)
            elif event.type == "end":
                hands.pop(event.hand, None)
            else:
                # Track each pinch by adding up its movement rather than using
                # event.x/y, so a hand returning from off-screen doesn't jump.
                before = dict(hands)
                hx, hy = hands.get(event.hand, (event.x, event.y * ASPECT))
                hands[event.hand] = (hx + event.dx, hy + event.dy)
                if len(before) == 2:
                    bx, by = pinch_span(before)
                    ax, ay = pinch_span(hands)
                    if math.hypot(bx, by) > 0.02:
                        zoom = pose["zoom"] * math.hypot(ax, ay) / math.hypot(bx, by)
                        pose["zoom"] = min(4.0, max(0.25, zoom))
                        turn = math.atan2(ay, ax) - math.atan2(by, bx)
                        pose["angle"] += (turn + math.pi) % (2 * math.pi) - math.pi
            pose["hands"] = hands
            pose["fists"] = sorted(fists)
            pose["engaged"] = [f"{h} pinch" for h in sorted(hands)] + [
                f"{h} fist" for h in sorted(fists)
            ]
            return pose

        set_pose(update)


    def on_clap(event):
        """Double clap: put the specimen back where it started."""
        set_pose(lambda pose: dict(pose, **HOME, grab=(HOME["x"], HOME["y"])))


    def on_reel(event):
        """Reel: step through the colors."""
        set_pose(lambda pose: dict(pose, color=(pose["color"] + event.direction) % len(COLORS)))

    return on_clap, on_clutch, on_reel


@app.cell
def _(HandwaveWidget, mo, on_clap, on_clutch, on_reel):
    handwave_widget = HandwaveWidget(
        frame_of_reference="image",
        max_num_hands=2,
        model_complexity=1.0,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5,
        precision=3,
        debug=True,
        width=320,
        height=240,
    )
    handwave_widget.on_clutch(on_clutch)
    handwave_widget.on_clap(on_clap)
    handwave_widget.on_reel(on_reel)
    widget = mo.ui.anywidget(handwave_widget)
    widget
    return (widget,)


@app.cell
def _(COLORS, get_pose, math, mo):
    _pose = get_pose()
    # Highlight while a fist is grabbing, or both hands are pinching (zoom/rotate).
    _engaged = bool(_pose["fists"]) or len(_pose["hands"]) == 2
    _size = 60 * _pose["zoom"]
    _fill = COLORS[_pose["color"]]
    _opacity = 0.8 if _engaged else 0.35
    mo.vstack([
        mo.Html(f"""
        <svg viewBox="0 0 400 300" width="400" height="300"
             style="border: 2px solid #333; border-radius: 8px; background: #111">
          <g transform="translate({_pose["x"] * 400:.1f} {_pose["y"] * 400:.1f})
                        rotate({math.degrees(_pose["angle"]):.1f})">
            <rect x="{-_size / 2:.1f}" y="{-_size / 2:.1f}" width="{_size:.1f}" height="{_size:.1f}"
                  rx="8" fill="{_fill}" fill-opacity="{_opacity}" stroke="{_fill}" stroke-width="2"/>
            <line x1="0" y1="0" x2="0" y2="{-_size / 2:.1f}" stroke="white" stroke-width="3"/>
          </g>
        </svg>
        """),
        mo.md(
            "Make a fist and move it to drag the square around, or turn it like a "
            "dial to turn the square. Pinch with both hands, then spread them "
            "apart or bring them together to zoom, and turn the line between them "
            "to rotate. Clap twice (clap, brief pause, clap) to put the square "
            "back. To change its color, point double-barrelled finger guns (index "
            "and middle fingers out) at each other, hold your left hand still, "
            "and circle your right hand."
        ),
        mo.md(
            f"**Clutched:** {', '.join(_pose['engaged']) or 'none'} · "
            f"angle {math.degrees(_pose['angle']):.0f}° · zoom {_pose['zoom']:.2f}× · "
            f"{_pose['events']} events"
        ),
    ])
    return


@app.cell
def _(widget):
    widget.hand
    return


if __name__ == "__main__":
    app.run()
