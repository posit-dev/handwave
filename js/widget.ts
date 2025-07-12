import cameraUtils from "https://esm.sh/@mediapipe/camera_utils@0.3/camera_utils.js";
import drawingUtils from "https://esm.sh/@mediapipe/drawing_utils@0.3/drawing_utils.js";
import handslib from "https://esm.sh/@mediapipe/hands@0.4/hands.js";

import "./widget.css";

interface Point {
  x: number;
  y: number;
  z: number;
}

/* Specifies attributes defined with traitlets in ../src/handwave/__init__.py */
interface WidgetModel {
  get(key: "frame_of_reference"): "image" | "world";
  get(key: "max_num_hands"): number;
  get(key: "model_complexity"): number;
  get(key: "min_detection_confidence"): number;
  get(key: "min_tracking_confidence"): number;
  get(key: "precision"): number;
  get(key: "debug"): boolean;
  get(key: "width"): number;
  get(key: "height"): number;
  get(key: "hands_data"): any;
  get(key: "is_tracking"): boolean;
  get(key: "camera_active"): boolean;

  set(key: string, value: any): void;
  save_changes(): void;
  on(event: string, callback: () => void): void;
}

/**
 * These are the raw results returned by the MediaPipe Hands library.
 */
interface HandTrackResults {
  /**
   * Collection of detected/tracked hands, where each hand is represented as a
   * list of 21 hand landmarks and each landmark is composed of x, y and z. x
   * and y are normalized to [0.0, 1.0] by the image width and height
   * respectively. z represents the landmark depth with the depth at the wrist
   * being the origin, and the smaller the value the closer the landmark is to
   * the camera. The magnitude of z uses roughly the same scale as x.
   */
  multiHandLandmarks?: Array<Array<Point>>;

  /**
   * Collection of detected/tracked hands, where each hand is represented as a
   * list of 21 hand landmarks in world coordinates. Each landmark is composed
   * of x, y and z: real-world 3D coordinates in meters with the origin at the
   * hand’s approximate geometric center.
   */
  multiHandWorldLandmarks?: Array<Array<Point>>;

  /**
   * Collection of handedness of the detected/tracked hands (i.e. is it a left
   * or right hand). Each hand is composed of label and score. label is a
   * string of value either "Left" or "Right". score is the estimated
   * probability of the predicted handedness and is always greater than or
   * equal to 0.5 (and the opposite handedness has an estimated probability of
   * 1 - score).
   *
   * Note that handedness is determined assuming the input image is mirrored,
   * i.e., taken with a front-facing/selfie camera with images flipped
   * horizontally. If it is not the case, please swap the handedness output in
   * the application.
   */
  multiHandedness?: Array<{
    index: number;
    label: "Left" | "Right";
    score: number;
  }>;
  image: HTMLImageElement;
}

function render({ model, el }: { model: WidgetModel; el: HTMLElement }) {
  let container = document.createElement("div");
  container.className = "hand-tracking-container";

  let videoEl = document.createElement("video");
  videoEl.style.display = "none";

  let canvasEl = document.createElement("canvas");
  canvasEl.className = "hand-tracking-canvas";
  canvasEl.width = model.get("width");
  canvasEl.height = model.get("height");

  let debugInfo = document.createElement("div");
  debugInfo.className = "hand-tracking-debug";
  debugInfo.style.display = model.get("debug") ? "block" : "none";

  container.appendChild(canvasEl);
  container.appendChild(debugInfo);
  el.appendChild(container);
  el.appendChild(videoEl);

  let canvasCtx = canvasEl.getContext("2d")!;

  function onResults(results: HandTrackResults) {
    // Update model with hand data
    const frameOfReference = model.get("frame_of_reference");
    const landmarks =
      frameOfReference === "world"
        ? results.multiHandWorldLandmarks
        : results.multiHandLandmarks;
    if (landmarks && landmarks.length > 0) {
      let precision = model.get("precision");
      let roundedResults: Array<Array<Point>> = JSON.parse(
        JSON.stringify(landmarks, (_key, value) => {
          if (typeof value === "number") {
            return +value.toFixed(precision);
          }
          return value;
        })
      );
      // Turn [[{x, y, z}, ...]] into [{x: [...], y: [...], z: [...]}]
      let columnarResults = roundedResults.map((hand: Array<Point>) => {
        const handColumnar: Record<string, Array<number>> = {
          x: [],
          y: [],
          z: [],
        };
        for (let landmark of hand) {
          handColumnar.x.push(landmark.x);
          handColumnar.y.push(landmark.y);
          handColumnar.z.push(landmark.z);
        }
        return handColumnar;
      });
      console.log(columnarResults);

      model.set("hands_data", columnarResults);
      model.set(
        "handedness",
        results.multiHandedness?.map((hand) => [flipHand(hand.label), hand.score])
      );
      model.set("is_tracking", true);

      // update debug info
      if (model.get("debug") && landmarks[0]) {
        let hand = landmarks[0];
        let wrist = hand[0];
        debugInfo.innerHTML = `
			<strong>Hand Detected</strong><br>
			Wrist: <tt>x=${pretty_coord(wrist.x)}, y=${pretty_coord(
          wrist.y
        )}, z=${pretty_coord(wrist.z)}</tt>
		`;
      }
    } else {
      model.set("hands_data", null);
      model.set("is_tracking", false);
      if (model.get("debug")) {
        debugInfo.innerHTML = "<strong>No hand detected</strong>";
      }
    }
    model.save_changes();

    // Always draw the camera feed
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasEl.width, canvasEl.height);

    // flip for selfie view
    canvasCtx.scale(-1, 1);
    canvasCtx.translate(-canvasEl.width, 0);

    canvasCtx.drawImage(results.image, 0, 0, canvasEl.width, canvasEl.height);

    // Only draw hand landmarks if debug is enabled
    if (model.get("debug")) {
      for (let landmarks of results.multiHandLandmarks ?? []) {
        drawingUtils.drawConnectors(
          canvasCtx,
          landmarks,
          handslib.HAND_CONNECTIONS,
          {
            color: "#00FF00",
            lineWidth: 2,
          }
        );
        drawingUtils.drawLandmarks(canvasCtx, landmarks, {
          color: "#FFFFFF",
          radius: 2,
        });
      }
    }

    canvasCtx.restore();
  }

  let hands = new handslib.Hands({
    locateFile: (file: string) => {
      // hack to load static assets...
      return `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/${file}`;
    },
  });

  hands.setOptions({
    maxNumHands: model.get("max_num_hands"),
    modelComplexity: model.get("model_complexity"),
    minDetectionConfidence: model.get("min_detection_confidence"),
    minTrackingConfidence: model.get("min_tracking_confidence"),
  });

  hands.onResults(onResults);

  let camera = new cameraUtils.Camera(videoEl, {
    onFrame: () => hands.send({ image: videoEl }),
    width: model.get("width"),
    height: model.get("height"),
  });

  camera.start().then(() => {
    model.set("camera_active", true);
    model.save_changes();
  });

  model.on("change:debug", () => {
    // Canvas always visible, only debug info is toggled
    debugInfo.style.display = model.get("debug") ? "block" : "none";
  });

  model.on("change:width", () => {
    canvasEl.width = model.get("width");
  });

  model.on("change:height", () => {
    canvasEl.height = model.get("height");
  });

  return () => {
    camera.stop();
    model.set("camera_active", false);
    model.save_changes();
  };
}

function pretty_coord(value: number, precision: number = 3): string {
  const prefix = value >= 0 ? "+" : "";
  const color = value < 0 ? "#FAA" : value == 0 ? "inherit" : "#FFA";
  return `<span style="color: ${color}">${prefix}${value.toFixed(
    precision
  )}</span>`;
}

function flipHand(label: "Left" | "Right"): "Right" | "Left" {
  return label === "Left" ? "Right" : label === "Right" ? "Left" : label;
}

export default { render };
