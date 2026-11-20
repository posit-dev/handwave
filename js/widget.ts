// Type-only: the MediaPipe scripts themselves are loaded at runtime (see
// assets.ts) and expose these APIs as globals on `window`.
import type * as CameraUtils from "@mediapipe/camera_utils";
import type * as DrawingUtils from "@mediapipe/drawing_utils";
import type * as Hands from "@mediapipe/hands";

import { AssetModel, loadHandsAssets, loadScript } from "./assets";
import {
  ClapEvent,
  ClutchOptions,
  ClutchVisual,
  defaultClutchOptions,
  GestureTracker,
} from "./gestures";

type MediaPipe = typeof CameraUtils & typeof DrawingUtils & typeof Hands;

async function loadMediaPipe(model: AssetModel): Promise<MediaPipe> {
  await Promise.all(
    ["hands.js", "camera_utils.js", "drawing_utils.js"].map((name) =>
      loadScript(model, name)
    )
  );
  return window as unknown as MediaPipe;
}

import "./widget.css";

interface Point {
  x: number;
  y: number;
  z: number;
}

/* Specifies attributes defined with traitlets in ../src/handwave/__init__.py */
interface WidgetModel extends AssetModel {
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
  get(key: "pinch_engage_threshold"): number;
  get(key: "pinch_release_threshold"): number;
  get(key: "clutched_hands"): string[];

  set(key: string, value: any): void;
  save_changes(): void;
  on(event: string, callback: (...args: any[]) => void): void;
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
  image: CanvasImageSource;
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

  function clutchOptions(): ClutchOptions {
    return {
      ...defaultClutchOptions,
      engageThreshold: model.get("pinch_engage_threshold"),
      releaseThreshold: model.get("pinch_release_threshold"),
    };
  }
  const tracker = new GestureTracker(
    clutchOptions(),
    model.get("max_num_hands")
  );
  const updateClutchOptions = () => {
    tracker.opts = clutchOptions();
  };
  model.on("change:pinch_engage_threshold", updateClutchOptions);
  model.on("change:pinch_release_threshold", updateClutchOptions);
  model.on("change:max_num_hands", () => {
    tracker.maxHands = model.get("max_num_hands");
  });

  /** The latest clap, while its flash is still showing on the preview. */
  let lastClap: ClapEvent | undefined;

  /** Runs gesture recognition; returns visuals to draw on the preview. */
  function updateGestures(results: HandTrackResults): ClutchVisual[] {
    const hands = (results.multiHandLandmarks ?? []).map((landmarks, i) => ({
      label: flipHand(results.multiHandedness?.[i]?.label ?? "Right"),
      landmarks,
    }));
    // MediaPipe normalizes landmarks by the camera frame's actual size,
    // which can differ from the requested width/height.
    const aspect =
      videoEl.videoWidth > 0
        ? videoEl.videoHeight / videoEl.videoWidth
        : canvasEl.height / canvasEl.width;
    const { events, visuals, claps } = tracker.update(
      hands,
      performance.now(),
      aspect
    );
    if (events.length > 0) {
      model.send({ type: "handwave:clutch", events });
    }
    if (claps.length > 0) {
      model.send({ type: "handwave:clap", events: claps });
      lastClap = claps[claps.length - 1];
    }
    const engaged = tracker.engagedHands();
    if (engaged.join(",") !== model.get("clutched_hands").join(",")) {
      model.set("clutched_hands", engaged);
    }
    return visuals;
  }

  function onResults(results: HandTrackResults) {
    const clutchVisuals = updateGestures(results);

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

      model.set("hands_data", columnarResults);
      model.set(
        "handedness",
        results.multiHandedness?.map((hand) => [
          flipHand(hand.label),
          hand.score,
        ])
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
    for (let landmarks of results.multiHandLandmarks ?? []) {
      mp.drawConnectors(
        canvasCtx,
        landmarks,
        mp.HAND_CONNECTIONS,
        {
          color: "#00FF00",
          lineWidth: 2,
        }
      );
      mp.drawLandmarks(canvasCtx, landmarks, {
        color: "#FFFFFF",
        radius: 2,
      });
    }

    for (const visual of clutchVisuals) {
      drawClutch(canvasCtx, visual, canvasEl.width, canvasEl.height);
    }
    if (lastClap) {
      const age = (performance.now() - lastClap.t) / CLAP_FLASH_MS;
      if (age < 1) {
        drawClap(canvasCtx, lastClap, age, canvasEl.width, canvasEl.height);
      } else {
        lastClap = undefined;
      }
    }

    canvasCtx.restore();

    if (model.get("debug") && clutchVisuals.length > 0) {
      debugInfo.innerHTML +=
        "<br>" +
        clutchVisuals
          .map(
            (v) =>
              `${v.hand} pinch: <tt>${v.ratio.toFixed(2)}</tt> ` +
              `fingers: <tt>${v.straightness.toFixed(2)}</tt> ` +
              `reach: <tt>${v.reach.toFixed(2)}</tt> ${v.gesture} ${v.state}`
          )
          .join("<br>");
    }
  }

  let disposed = false;
  let mp: MediaPipe;
  let camera: CameraUtils.Camera | undefined;

  async function start() {
    debugInfo.style.display = "block";
    debugInfo.textContent = "Loading hand tracking model…";
    const [mediapipe, locateFile] = await Promise.all([
      loadMediaPipe(model),
      loadHandsAssets(model, model.get("model_complexity")),
    ]);
    mp = mediapipe;
    debugInfo.style.display = model.get("debug") ? "block" : "none";
    debugInfo.textContent = "";
    if (disposed) return;

    const hands = new mp.Hands({ locateFile });

    hands.setOptions({
      maxNumHands: model.get("max_num_hands"),
      modelComplexity: model.get("model_complexity") as 0 | 1,
      minDetectionConfidence: model.get("min_detection_confidence"),
      minTrackingConfidence: model.get("min_tracking_confidence"),
    });

    hands.onResults(onResults);

    camera = new mp.Camera(videoEl, {
      onFrame: () => hands.send({ image: videoEl }),
      width: model.get("width"),
      height: model.get("height"),
    });

    await camera.start();
    model.set("camera_active", true);
    model.save_changes();
  }

  start().catch((err) => {
    console.error(err);
    debugInfo.style.display = "block";
    debugInfo.textContent = `Error: ${err?.message ?? err}`;
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
    disposed = true;
    camera?.stop();
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

const CLUTCH_COLORS = {
  idle: "rgba(255, 255, 255, 0.8)",
  engaged: "#00E5FF",
  frozen: "#FFC400",
  suspended: "#FF9100",
};

/**
 * Draws clutch feedback in raw landmark coordinates (the caller has already
 * mirrored the context), at the pinch point (a circle), or the knuckles of a
 * fist (a larger rounded square) or finger gun (a diamond). Idle: a ring that fills as the fingers close.
 * Engaged: a solid marker with a tether back to where the gesture started.
 * Frozen (loosening, or first frame back in view): an amber outline.
 * Suspended (hand gone, or the gesture's fingers at the edge): a dashed
 * orange outline where the hand was, kept inside the frame.
 */
function drawClutch(
  ctx: CanvasRenderingContext2D,
  visual: ClutchVisual,
  width: number,
  height: number
) {
  const radius = visual.gesture === "pinch" ? 12 : 16;
  let x = visual.point.x * width;
  let y = visual.point.y * height;
  if (visual.state === "suspended") {
    const inset = radius + 3;
    x = Math.min(width - inset, Math.max(inset, x));
    y = Math.min(height - inset, Math.max(inset, y));
  }
  const color = CLUTCH_COLORS[visual.state];
  ctx.save();
  ctx.lineWidth = 3;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;

  const marker = () => {
    ctx.beginPath();
    if (visual.gesture === "fist") {
      ctx.roundRect(x - radius, y - radius, 2 * radius, 2 * radius, 5);
    } else if (visual.gesture === "gun") {
      ctx.moveTo(x, y - radius);
      ctx.lineTo(x + radius, y);
      ctx.lineTo(x, y + radius);
      ctx.lineTo(x - radius, y);
      ctx.closePath();
    } else {
      ctx.arc(x, y, radius, 0, 2 * Math.PI);
    }
  };

  if (visual.state === "suspended") {
    ctx.setLineDash([4, 3]);
    marker();
    ctx.stroke();
  } else if (visual.state === "idle") {
    if (visual.progress > 0) {
      ctx.beginPath();
      ctx.arc(
        x,
        y,
        radius,
        -Math.PI / 2,
        -Math.PI / 2 + visual.progress * 2 * Math.PI
      );
      ctx.stroke();
    }
  } else {
    if (visual.anchor) {
      const ax = visual.anchor.x * width;
      const ay = visual.anchor.y * height;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(ax, ay, 3, 0, 2 * Math.PI);
      ctx.fill();
    }
    marker();
    if (visual.state === "engaged") {
      ctx.globalAlpha = 0.6;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** How long a clap's flash shows on the preview. */
const CLAP_FLASH_MS = 400;

/**
 * Draws a clap as a ring expanding and fading from where the hands met, in
 * raw landmark coordinates (the caller has already mirrored the context).
 * `age` runs from 0 (just clapped) to 1 (gone).
 */
function drawClap(
  ctx: CanvasRenderingContext2D,
  clap: ClapEvent,
  age: number,
  width: number,
  height: number
) {
  ctx.save();
  ctx.globalAlpha = 1 - age;
  ctx.lineWidth = 4;
  ctx.strokeStyle = CLUTCH_COLORS.engaged;
  ctx.beginPath();
  ctx.arc((1 - clap.x) * width, clap.y * height, 15 + 45 * age, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.restore();
}

function flipHand(label: "Left" | "Right"): "Right" | "Left" {
  return label === "Left" ? "Right" : label === "Right" ? "Left" : label;
}

export default { render };
