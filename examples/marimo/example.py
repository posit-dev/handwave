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
    # Accumulated "specimen" pose, driven by pinch clutch events.
    # `hands` tracks where each pinching hand is, for two-handed zoom.
    get_pose, set_pose = mo.state(
        {"x": 0.5, "y": 0.375, "angle": 0.0, "zoom": 1.0, "hands": {}, "engaged": [], "events": 0}
    )
    return get_pose, set_pose


@app.cell
def _(math, set_pose):
    ASPECT = 240 / 320  # widget height / width, to put pinch y in frame widths


    def pinch_span(hands):
        """Vector from the left hand's pinch point to the right's, in frame widths."""
        (lx, ly), (rx, ry) = hands["Left"], hands["Right"]
        return rx - lx, ry - ly


    def on_clutch(event):
        """Pinch with both hands, then spread apart or bring together to zoom, and
        turn the line between your hands to rotate. One hand alone does nothing."""

        def update(pose):
            hands = dict(pose["hands"])
            pose = dict(pose, events=pose["events"] + 1)
            if event.type == "start":
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
            pose["engaged"] = sorted(hands)
            return pose

        set_pose(update)

    return (on_clutch,)


@app.cell
def _(HandwaveWidget, mo, on_clutch):
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
    widget = mo.ui.anywidget(handwave_widget)
    widget
    return (widget,)


@app.cell
def _(get_pose, math, mo):
    _pose = get_pose()
    _engaged = bool(_pose["engaged"])
    _size = 60 * _pose["zoom"]
    _fill = "#00E5FF" if _engaged else "#9AA4AE"
    mo.vstack([
        mo.Html(f"""
        <svg viewBox="0 0 400 300" width="400" height="300"
             style="border: 2px solid #333; border-radius: 8px; background: #111">
          <g transform="translate({_pose["x"] * 400:.1f} {_pose["y"] * 400:.1f})
                        rotate({math.degrees(_pose["angle"]):.1f})">
            <rect x="{-_size / 2:.1f}" y="{-_size / 2:.1f}" width="{_size:.1f}" height="{_size:.1f}"
                  rx="8" fill="{_fill}" fill-opacity="0.7" stroke="{_fill}" stroke-width="2"/>
            <line x1="0" y1="0" x2="0" y2="{-_size / 2:.1f}" stroke="white" stroke-width="3"/>
          </g>
        </svg>
        """),
        mo.md(
            "Pinch with both hands, then spread them apart or bring them together "
            "to zoom, and turn the line between them to rotate."
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
