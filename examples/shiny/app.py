from shiny import App, reactive, render, req, ui
from shinywidgets import output_widget, reactive_read, render_widget

from handwave import HandwaveWidget

app_ui = ui.page_sidebar(
    ui.sidebar(
        ui.input_numeric("hand_count", "Max hands", 2)
    ),
    output_widget("handwave", width="320px", height="242px"),
    ui.tags.br(),
    ui.output_data_frame("hand"),
)


def server(input, output, session):
    @render_widget
    def handwave():
        # Create a HandwaveWidget instance
        widget = HandwaveWidget(
            frame_of_reference="image",
            max_num_hands=input.hand_count(),
            model_complexity=1.0,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5,
            precision=3,
            debug=False,
            width=320,
            height=240,
        )
        return widget

    @render.data_frame
    def hand():
        # Use reactive_read to take a dependency on the widget's hands_data
        reactive_read(handwave.widget, "hands_data")
        return handwave.widget.hand


app = App(app_ui, server)
