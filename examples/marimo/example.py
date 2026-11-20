import marimo

__generated_with = "0.25.2"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo
    from handwave import HandwaveWidget

    return HandwaveWidget, mo


@app.cell
def _(HandwaveWidget, mo):
    widget = mo.ui.anywidget(HandwaveWidget(
        frame_of_reference="image",
        max_num_hands=2,
        model_complexity=1.0,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5,
        precision=3,
        debug=False,
        width=320,
        height=240,
    ))
    widget
    return (widget,)


@app.cell
def _(widget):
    widget.hand
    return


if __name__ == "__main__":
    app.run()
