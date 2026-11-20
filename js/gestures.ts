// Gesture recognition on top of MediaPipe hand landmarks.
//
// This module is pure (no DOM, no MediaPipe) so it can be unit tested with
// synthetic landmarks. Keep it free of TypeScript-only runtime syntax (enums,
// parameter properties) so Node can run it directly with type stripping.

export interface Point {
  x: number;
  y: number;
  z: number;
}

// MediaPipe hand landmark indices
const WRIST = 0;
const THUMB_IP = 3;
const THUMB_TIP = 4;
const INDEX_DIP = 7;
const INDEX_MCP = 5;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const RING_MCP = 13;
const PINKY_MCP = 17;
/** Palm landmarks, averaged to track how fast the hand is moving. */
const PALM = [WRIST, INDEX_MCP, MIDDLE_MCP, RING_MCP, PINKY_MCP];
/** Knuckles (MCP joints) of the index, middle, ring and pinky fingers. */
const FINGER_MCPS = [INDEX_MCP, MIDDLE_MCP, RING_MCP, PINKY_MCP];
/** How far back (ms) to look when measuring palm speed. */
const SPEED_WINDOW_MS = 100;

/**
 * Landmarks that must be in view for the clutch to judge a pinch: the thumb
 * and index fingertips and the joint just below each. When part of the hand
 * is out of frame MediaPipe still reports every landmark, but guesses the
 * hidden ones. Only the pinching end of the fingers is checked, so the rest
 * of the hand (knuckles, wrist) can be off the edge without putting the
 * clutch on hold.
 */
const PINCH_LANDMARKS = [THUMB_IP, THUMB_TIP, INDEX_DIP, INDEX_TIP];

/**
 * Landmarks that must be in view for the clutch to judge a fist: the four
 * fingers, knuckles to tips. The thumb and wrist can be off the edge.
 */
const FIST_LANDMARKS = FINGER_MCPS.flatMap((mcp) => [mcp, mcp + 1, mcp + 2, mcp + 3]);

/**
 * How far inside the frame edge (as a fraction of width or height) those
 * landmarks must be. MediaPipe's estimates degrade near the edge even for
 * points that are technically inside the frame.
 */
const EDGE_MARGIN = 0.04;

/**
 * One Euro filter (Casiez et al., CHI 2012): a low-pass filter whose cutoff
 * rises with speed, so slow movements are smoothed heavily (no jitter) while
 * fast movements stay responsive (little lag).
 */
export class OneEuroFilter {
  minCutoff: number;
  beta: number;
  dCutoff: number;
  private xPrev: number | undefined;
  private dxPrev = 0;
  private tPrev: number | undefined;

  constructor(minCutoff = 1.0, beta = 0.0, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  reset() {
    this.xPrev = undefined;
    this.tPrev = undefined;
    this.dxPrev = 0;
  }

  /** `t` is in seconds. */
  filter(x: number, t: number): number {
    if (this.xPrev === undefined || this.tPrev === undefined) {
      this.xPrev = x;
      this.tPrev = t;
      this.dxPrev = 0;
      return x;
    }
    const dt = Math.max(t - this.tPrev, 1e-3);
    const dx = (x - this.xPrev) / dt;
    const dxHat = lerp(this.dxPrev, dx, smoothingAlpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const xHat = lerp(this.xPrev, x, smoothingAlpha(cutoff, dt));
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    this.tPrev = t;
    return xHat;
  }
}

function smoothingAlpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

function lerp(a: number, b: number, alpha: number): number {
  return a + alpha * (b - a);
}

export type Gesture = "pinch" | "fist" | "gun";

export interface ClutchOptions {
  /** Pinch ratio below which a pinch engages. */
  engageThreshold: number;
  /** Pinch ratio above which an engaged pinch releases. */
  releaseThreshold: number;
  /**
   * How long (ms) the engage pose must be held before the clutch engages.
   *
   * Engaging takes a deliberate pose, so a relaxed hand can't engage by
   * accident. For a pinch: thumb and index fingertips touching, the other
   * three fingers extended (an "OK" sign). For a fist: all four fingers
   * curled in. Either way, the whole hand in view and nearly still. Staying
   * engaged only needs the pinch (or the fist) to stay closed.
   */
  engageMs: number;
  /**
   * Minimum average straightness of the middle, ring and pinky fingers to
   * engage a pinch, from 0 (folded) to 1 (straight). In recorded data,
   * deliberate "OK" signs measured 0.91-1.0, relaxed or dropping hands
   * 0.2-0.8.
   */
  engageStraightness: number;
  /**
   * Minimum reach (3D; see `fistEngageReach`) of each of the middle, ring
   * and pinky fingers to engage a pinch. With a fist's fingers curled toward
   * the camera they look straight in the image (0.85-0.9), but their tips
   * are close to the wrist: in recorded data such fists measured 0.46-0.65
   * and twice engaged as pinches, while "OK" signs measured 1.7 or more.
   */
  engageReach: number;
  /**
   * Fastest the palm may move while engaging, in frame widths per second.
   * In recorded data, deliberate pinches engaged below 0.1; accidental ones
   * on a dropping hand at 0.7-4.
   */
  engageMaxSpeed: number;
  /**
   * A clutch back from a hold no longer than this (ms) carries on as if the
   * hand was never lost, movement included; after a longer hold it resumes
   * from where the hand is, without a jump. During fast movement MediaPipe
   * often loses the hand for a frame or two, or it swings briefly past the
   * edge; in recorded data, dropping the movement from those gaps made a
   * fist shaken back and forth drift by up to 0.4 frame widths.
   */
  bridgeMs: number;
  /** Consecutive frames above the release threshold required to release. */
  releaseFrames: number;
  /**
   * Consecutive frames above the release threshold required to release a
   * clutch that's on hold, once the hand is back in view. Higher than
   * `releaseFrames` because MediaPipe takes a moment to settle on a
   * re-entering hand, and a false release is costlier than a late one.
   */
  releaseFramesAfterHold: number;
  /**
   * Fist reach below which a fist engages. A finger's reach is how far its
   * tip is from the wrist, divided by how far its knuckle is from the wrist,
   * in 3D (MediaPipe's depth estimate included); the fist's reach is the
   * largest of the four fingers'. Measuring in the image alone failed for a
   * fist pointed at the camera, where the knuckles hide the wrist: reach
   * shot up to 4-18. In recorded data, held fists measured 0.8-1.2 (a fist
   * pointed at the camera up to 1.7), and open hands 1.9-2.4.
   */
  fistEngageReach: number;
  /**
   * Like `engageMs`, for a fist. Longer, because a hand curls up briefly as
   * it drops; in recorded data one did for 100ms.
   */
  fistEngageMs: number;
  /**
   * An engaged fist releases when some finger is extended: its reach above
   * `fistReleaseReach` and its straightness (in the image) above
   * `fistReleaseStraightness`. Reach alone wasn't enough: from some angles
   * MediaPipe sees a fist's index finger half uncurled (reach up to 1.9,
   * straightness 0.6-0.85). In recorded data, fists had an extended finger
   * in 0-1% of frames (never two in a row), open hands and finger guns in
   * 98-100%.
   */
  fistReleaseReach: number;
  fistReleaseStraightness: number;
  /**
   * Like `releaseFrames`, for a fist. Higher, because from some angles
   * MediaPipe sees a fist's index finger flick out straight for a couple of
   * frames.
   */
  fistReleaseFrames: number;
  /**
   * Maximum average straightness of all four fingers to engage a fist.
   * Recorded fists measured 0.2-0.5 when held still. This mostly rejects
   * MediaPipe's ghost hands, whose foreshortened fingers have a fist-like
   * reach but read as straight.
   */
  fistEngageStraightness: number;
  /**
   * Finger gun: index finger out, thumb out, the other three curled. To
   * engage, the index's reach (see `fistEngageReach`) must be at least
   * `gunEngageIndexReach`; the middle, ring and pinky's reach at most
   * `fistEngageReach`; and the thumb tip at least `gunEngageThumb` palm
   * lengths from the middle finger's middle joint. Pointed at the camera,
   * the index is foreshortened: its reach dropped to 1.4-1.7 (2.0 sideways)
   * and its straightness in the image to 0.3-0.6, so only 3D measures work.
   * In recorded data the thumb measured 0.82 or more for a gun, 0.45 or
   * less when tucked in to point, and about 0.2 in a fist. Held for
   * `fistEngageMs`.
   */
  gunEngageIndexReach: number;
  gunEngageThumb: number;
  /**
   * An engaged gun releases when the index curls (3D straightness below
   * this; recorded guns stayed above 0.69 from every angle, fists measured
   * 0.35-0.44) or another finger is extended (see `fistReleaseReach`), for
   * `fistReleaseFrames` frames.
   */
  gunReleaseIndexStraightness: number;
  /**
   * Clap: two hands become one (MediaPipe reports clasped hands as a single
   * hand) between where the two were, within `clapWindowMs` of their being
   * at least `clapMinSpan` hand sizes apart (palm center to palm center;
   * hand size is wrist to middle knuckle). In recorded claps the hands
   * closed from 4-6 hand sizes apart, merging (or vanishing for up to 80 ms
   * of motion blur, then reappearing as one) within 100-250 ms. Pressed
   * together slowly, palm to palm, the two palm centers stay about 1.2 hand
   * sizes apart before merging.
   */
  clapMinSpan: number;
  clapWindowMs: number;
}

export const defaultClutchOptions: ClutchOptions = {
  engageThreshold: 0.25,
  releaseThreshold: 0.4,
  engageMs: 100,
  engageStraightness: 0.85,
  engageReach: 1.4,
  engageMaxSpeed: 0.5,
  bridgeMs: 200,
  releaseFrames: 2,
  releaseFramesAfterHold: 5,
  fistEngageReach: 1.3,
  fistEngageMs: 150,
  fistReleaseReach: 1.6,
  fistReleaseStraightness: 0.9,
  fistReleaseFrames: 3,
  fistEngageStraightness: 0.6,
  gunEngageIndexReach: 1.4,
  gunEngageThumb: 0.6,
  gunReleaseIndexStraightness: 0.6,
  clapMinSpan: 2,
  clapWindowMs: 300,
};

/** Two hands clapping together. */
export interface ClapEvent {
  type: "clap";
  /** Where the hands met, 0 (user's left) to 1 (user's right), mirrored like the preview. */
  x: number;
  /** Where the hands met, 0 (top) to 1 (bottom). */
  y: number;
  t: number;
}

export interface ClutchEvent {
  type: "start" | "move" | "end";
  /** Which pose holds the clutch: "pinch", "fist" or "gun". */
  gesture: Gesture;
  hand: string;
  /**
   * Gesture point, normalized to [0, 1] across the frame: between the
   * fingertips for a pinch, the middle of the knuckles for a fist or gun. Mirrored
   * like the preview, so x increases toward the user's right; y increases
   * downward.
   */
  x: number;
  y: number;
  /**
   * Movement since the previous event, in units of the frame width (so
   * horizontal and vertical movement are scaled equally).
   */
  dx: number;
  dy: number;
  /** Change in hand roll, in radians; positive is clockwise on screen. */
  dtheta: number;
  /** Multiplicative change in apparent hand size; > 1 means moving closer. */
  dscale: number;
  /**
   * Finger gun only (zero otherwise): change in the hand's 3D orientation,
   * as a rotation vector (axis times angle in radians) in screen
   * coordinates: x toward the user's right, y down, z into the screen.
   * This is the hand's physical turn, from the user's point of view; a
   * clockwise twist (as seen on screen, like `dtheta`) is positive about z.
   * Turning a 3D view by it needs depth cues (perspective, axes) to read
   * correctly: without them a rotating volume looks the same turning
   * either way.
   */
  drotation: [number, number, number];
  /** Milliseconds, from `performance.now()`. */
  t: number;
}

export interface ClutchVisual {
  hand: string;
  /**
   * The engaged gesture or, when idle, the one the hand looks closest to
   * (curled fingers: fist, or gun with the index out; otherwise pinch).
   */
  gesture: Gesture;
  /**
   * "frozen": engaged, but movement is ignored (pinch or fist loosening, or
   * the first frame back in view).
   * "suspended": engaged, but on hold because the hand is gone or the
   * landmarks the gesture depends on are at the edge; waiting for it to come
   * back.
   */
  state: "idle" | "engaged" | "frozen" | "suspended";
  /** Pinch ratio. */
  ratio: number;
  /** Fist reach. */
  reach: number;
  /** Idle: 0..1, how close the gesture is to engaging. */
  progress: number;
  /** Average straightness of the middle, ring and pinky fingers (0..1). */
  straightness: number;
  /** Gesture point and start point in raw (unmirrored) landmark coordinates. */
  point: { x: number; y: number };
  anchor?: { x: number; y: number };
}

interface Features {
  /** Mirrored x, normalized [0, 1]. */
  u: number;
  /** y, normalized [0, 1]. */
  y: number;
  /** Continuous (unwrapped) roll angle in radians. */
  angle: number;
  /** log of apparent palm length. */
  logScale: number;
  /** Smoothed hand orientation (see `handFrame`), row-major 3x3. */
  orientation: number[];
}

/** Everything the clutch needs to know about one frame of one hand. */
interface Measures {
  /** Fingertip distance / palm length. */
  ratio: number;
  /** Largest finger reach (see `fistEngageReach`). */
  reach: number;
  /** Smallest reach of the middle, ring and pinky fingers. */
  otherFingersReach: number;
  /** Largest reach of the middle, ring and pinky fingers. */
  otherFingersMaxReach: number;
  /** Like `extension`, for the middle, ring and pinky fingers only. */
  otherFingersExtension: number;
  /** Index finger reach. */
  indexReach: number;
  /** Index finger straightness, in 3D. */
  indexStraightness3d: number;
  /** Thumb tip to the middle finger's middle joint, in palm lengths. */
  thumbOut: number;
  /**
   * How extended the most extended finger is: above 1 when both its reach
   * and its straightness pass the fist's release thresholds.
   */
  extension: number;
  /** Average straightness of the middle, ring and pinky fingers. */
  straightness: number;
  /** Average straightness of all four fingers. */
  fingersStraightness: number;
  wholeHandVisible: boolean;
}

/**
 * Clutch for one hand: a pinch (thumb and index fingertips together) or a
 * fist engages it, and the same pose must be held to stay engaged.
 *
 * A pinch's openness is the pinch ratio (fingertip distance divided by palm
 * length, wrist to middle knuckle). A fist engages on its reach and releases
 * when a finger is extended (see `fistEngageReach` and `fistReleaseReach`).
 * All are ratios of hand measurements, so thresholds don't depend on
 * distance from the camera. Engage and release use different thresholds
 * (hysteresis) so the state doesn't flicker. For a pinch, between "engaged" and "released" there is a
 * dead band where the pinch is loosening: movement there is ignored, which
 * keeps the fingers opening from dragging the data on release.
 *
 * If the hand leaves the frame (or tracking drops) mid-gesture, the clutch is
 * put on hold rather than ended, for as long as it takes: it releases if the
 * hand comes back open (and stays open for `releaseFramesAfterHold` frames).
 * If it comes back still closed, it resumes without a jump, or, after a
 * brief dropout (`bridgeMs`), carries on as if the hand was never lost.
 * The same hold happens while landmarks the gesture depends on are outside the frame or within
 * `EDGE_MARGIN` of it, where MediaPipe guesses at landmarks: neither their
 * movement nor whether they look closed can be trusted. For a pinch that's
 * the thumb and index fingertips and the joint below each; for a fist, the
 * four fingers (knuckles to tips).
 */
export class HandClutch {
  readonly hand: string;
  opts: ClutchOptions;
  state: "idle" | "engaged" | "suspended" = "idle";
  /** The engaged gesture; undefined while idle. */
  gesture: Gesture | undefined;

  /** The gesture whose engage pose is being held, and since when. */
  private engageGesture: Gesture | undefined;
  private engageSince: number | undefined;
  /** Recent palm positions (frame widths) for measuring speed. */
  private palmTrail: Array<{ t: number; x: number; y: number }> = [];
  private aboveCount = 0;
  // Positions are in frame units; speeds of ~1 frame/sec are typical.
  private fu = new OneEuroFilter(1.5, 8);
  private fy = new OneEuroFilter(1.5, 8);
  private fAngle = new OneEuroFilter(1.5, 0.5);
  private fScale = new OneEuroFilter(1.5, 0.5);
  /** Smooths the two vectors that define the hand's orientation. */
  private fOrient = Array.from({ length: 6 }, () => new OneEuroFilter(1.5, 0.5));
  /** Which gesture's point the position filters are tracking. */
  private filterGesture: Gesture | undefined;
  private rawAngle: number | undefined;
  private unwrappedAngle = 0;
  private last: Features | undefined;
  private anchor: { x: number; y: number } | undefined;
  private lastPoint = { x: 0.5, y: 0.5 };
  private lastRatio = 0;
  private lastReach = 0;
  private outOfFrame = false;
  /** When the clutch last went on hold. */
  private suspendedAt = 0;
  /** Frame height / width, from the most recent update(). */
  private aspect = 1;

  constructor(hand: string, opts: ClutchOptions) {
    this.hand = hand;
    this.opts = opts;
  }

  /**
   * @param lm 21 MediaPipe image landmarks (normalized, unmirrored)
   * @param tMs timestamp in milliseconds
   * @param aspect frame height / width
   */
  update(
    lm: Point[],
    tMs: number,
    aspect: number
  ): { events: ClutchEvent[]; visual: ClutchVisual } {
    const { opts } = this;
    const events: ClutchEvent[] = [];
    this.aspect = aspect;

    const m = measure(lm, aspect, opts);
    const speed = this.palmSpeed(lm, tMs, aspect);
    // While idle, follow whichever gesture the hand looks closest to, so the
    // filters are already settled on its point when it engages.
    const curled =
      m.straightness <
      (opts.fistEngageStraightness + opts.engageStraightness) / 2;
    const gesture: Gesture =
      this.gesture ??
      (!curled
        ? "pinch"
        : m.indexReach >= opts.gunEngageIndexReach
          ? "gun"
          : "fist");
    const point = gesturePoint(lm, gesture);
    const visible = this.gesture
      ? gestureVisible(lm, this.gesture)
      : m.wholeHandVisible;
    const reenteredFrame = visible && this.outOfFrame;
    this.outOfFrame = !visible;
    if (this.state === "suspended" || reenteredFrame) {
      // The hand jumped while it was out of view (or its landmarks were
      // extrapolated off the edge); don't smooth across that.
      this.resetFilters();
    }
    this.lastRatio = m.ratio;
    this.lastReach = m.reach;

    let frozen = false;
    if (this.state === "idle") {
      const pinchReady =
        m.ratio < opts.engageThreshold &&
        m.straightness >= opts.engageStraightness &&
        m.otherFingersReach >= opts.engageReach;
      const fistReady =
        m.reach < opts.fistEngageReach &&
        m.fingersStraightness < opts.fistEngageStraightness;
      const gunReady =
        m.indexReach >= opts.gunEngageIndexReach &&
        m.otherFingersMaxReach <= opts.fistEngageReach &&
        m.thumbOut >= opts.gunEngageThumb;
      const ready: Gesture | undefined =
        !m.wholeHandVisible || speed >= opts.engageMaxSpeed
          ? undefined
          : pinchReady
            ? "pinch"
            : fistReady
              ? "fist"
              : gunReady
                ? "gun"
                : undefined;
      if (ready !== this.engageGesture) {
        this.engageGesture = ready;
        this.engageSince = ready ? tMs : undefined;
      }
      const f = this.features(lm, gesture, point, tMs / 1000, aspect);
      if (
        ready !== undefined &&
        this.engageSince !== undefined &&
        tMs - this.engageSince >=
          (ready === "pinch" ? opts.engageMs : opts.fistEngageMs)
      ) {
        this.engageGesture = undefined;
        this.engageSince = undefined;
        this.state = "engaged";
        this.gesture = ready;
        this.aboveCount = 0;
        const p = gesturePoint(lm, ready);
        const fe =
          ready === gesture
            ? f
            : this.features(lm, ready, p, tMs / 1000, aspect);
        this.last = fe;
        this.anchor = p;
        this.lastPoint = p;
        events.push(this.event("start", fe, tMs));
      } else {
        this.lastPoint = point;
      }
    } else {
      const g = this.gesture!;
      const f = this.features(lm, g, point, tMs / 1000, aspect);
      this.lastPoint = point;
      // How open the pose is; it releases above `releaseAt`.
      const open =
        g === "pinch"
          ? m.ratio
          : g === "fist"
            ? m.extension
            : Math.max(
                m.otherFingersExtension,
                opts.gunReleaseIndexStraightness /
                  Math.max(m.indexStraightness3d, 1e-6)
              );
      const releaseAt = g === "pinch" ? opts.releaseThreshold : 1;
      if (this.state === "suspended") {
        if (!visible) {
          // Still (partly) off the edge: the pose can't be judged yet.
        } else if (open < releaseAt) {
          this.state = "engaged";
          this.aboveCount = 0;
          if (tMs - this.suspendedAt <= opts.bridgeMs) {
            // Back after a brief dropout: carry on as if the hand was never
            // lost, so the movement made meanwhile isn't dropped.
            events.push(this.event("move", f, tMs));
          } else {
            // Back after a while: resume from here, without a jump.
            frozen = true;
          }
          this.last = f;
        } else {
          // Back, but open: that's a release, if it stays open.
          this.aboveCount += 1;
          if (this.aboveCount >= opts.releaseFramesAfterHold) {
            events.push(this.event("end", f, tMs));
            this.disengage();
          }
        }
      } else if (!visible) {
        // Landmarks the gesture depends on went off or near the edge.
        // MediaPipe still tracks the hand but guesses those landmarks, so
        // the point and openness can't be trusted: put the clutch on hold,
        // as if the hand was lost.
        this.suspend(tMs);
      } else {
        this.aboveCount = open > releaseAt ? this.aboveCount + 1 : 0;
        if (
          this.aboveCount >=
          (g === "pinch" ? opts.releaseFrames : opts.fistReleaseFrames)
        ) {
          events.push(this.event("end", f, tMs));
          this.disengage();
        } else if (
          g === "pinch" &&
          open > (opts.engageThreshold + releaseAt) / 2
        ) {
          // Loosening pinch: rebase so nothing jumps if it closes up again.
          // Fists don't need this: their point (the knuckles) stays put as
          // the fingers open, while motion blur on a fast-moving fist often
          // makes it look loose for a frame, and freezing then drops the
          // movement.
          frozen = true;
          this.last = f;
        } else {
          events.push(this.event("move", f, tMs));
          this.last = f;
        }
      }
    }

    if (this.state === "suspended") {
      return { events, visual: this.suspendedVisual() };
    }
    const shown = this.gesture ?? gesture;
    const progress =
      shown === "fist"
        ? clamp01(
            (FIST_OPEN_REACH - m.reach) /
              (FIST_OPEN_REACH - opts.fistEngageReach)
          )
        : shown === "gun"
          ? clamp01(m.thumbOut / opts.gunEngageThumb) *
            clamp01(
              (FIST_OPEN_REACH - m.otherFingersMaxReach) /
                (FIST_OPEN_REACH - opts.fistEngageReach)
            )
          : clamp01(
            (PINCH_OPEN_RATIO - m.ratio) /
              (PINCH_OPEN_RATIO - opts.engageThreshold)
          );
    return {
      events,
      visual: {
        hand: this.hand,
        gesture: shown,
        state: this.state === "idle" ? "idle" : frozen ? "frozen" : "engaged",
        ratio: m.ratio,
        reach: m.reach,
        progress,
        straightness: m.straightness,
        point: this.lastPoint,
        anchor: this.state === "engaged" ? this.anchor : undefined,
      },
    };
  }

  /**
   * Call when the hand is no longer detected. An engaged clutch goes on hold
   * until the hand comes back; there's no timeout.
   */
  lost(tMs: number) {
    if (this.state === "engaged") {
      this.suspend(tMs);
    } else if (this.state === "idle") {
      this.engageGesture = undefined;
      this.engageSince = undefined;
      this.resetFilters();
    }
    this.palmTrail = [];
  }

  /** Gesture point where the hand was last seen, in raw landmark coordinates. */
  get lastSeen(): { x: number; y: number } {
    return this.lastPoint;
  }

  /** Feedback for a suspended clutch: where the hand was last seen. */
  suspendedVisual(): ClutchVisual {
    return {
      hand: this.hand,
      gesture: this.gesture ?? "pinch",
      state: "suspended",
      ratio: this.lastRatio,
      reach: this.lastReach,
      progress: 0,
      straightness: 0,
      point: this.lastPoint,
      anchor: this.anchor,
    };
  }

  private suspend(tMs: number) {
    this.state = "suspended";
    this.suspendedAt = tMs;
    this.aboveCount = 0;
  }

  /** Palm speed over the last SPEED_WINDOW_MS, in frame widths per second. */
  private palmSpeed(lm: Point[], tMs: number, aspect: number): number {
    let x = 0;
    let y = 0;
    for (const i of PALM) {
      x += lm[i].x / PALM.length;
      y += (lm[i].y * aspect) / PALM.length;
    }
    this.palmTrail.push({ t: tMs, x, y });
    while (this.palmTrail.length > 1 && tMs - this.palmTrail[0].t > SPEED_WINDOW_MS) {
      this.palmTrail.shift();
    }
    const first = this.palmTrail[0];
    const dt = (tMs - first.t) / 1000;
    return dt > 0 ? Math.hypot(x - first.x, y - first.y) / dt : 0;
  }

  private disengage() {
    this.state = "idle";
    this.gesture = undefined;
    this.engageGesture = undefined;
    this.engageSince = undefined;
    this.aboveCount = 0;
    this.last = undefined;
    this.anchor = undefined;
  }

  private resetFilters() {
    this.fu.reset();
    this.fy.reset();
    this.fAngle.reset();
    this.fScale.reset();
    for (const f of this.fOrient) f.reset();
    this.rawAngle = undefined;
  }

  private features(
    lm: Point[],
    gesture: Gesture,
    point: { x: number; y: number },
    t: number,
    aspect: number
  ): Features {
    if (gesture !== this.filterGesture) {
      // Switching to another gesture's point: don't smooth across the jump.
      this.fu.reset();
      this.fy.reset();
      this.filterGesture = gesture;
    }
    // Roll: direction from wrist to middle knuckle, in mirrored, isotropic
    // screen space (y down), so positive change = clockwise on screen.
    const ax = -(lm[MIDDLE_MCP].x - lm[WRIST].x);
    const ay = (lm[MIDDLE_MCP].y - lm[WRIST].y) * aspect;
    const raw = Math.atan2(ay, ax);
    if (this.rawAngle !== undefined) {
      this.unwrappedAngle += wrapToPi(raw - this.rawAngle);
    } else {
      this.unwrappedAngle = raw;
    }
    this.rawAngle = raw;

    const palm2d = Math.hypot(ax, ay);
    const [along, across] = handVectors(lm, aspect);
    const v = [...along, ...across].map((c, i) => this.fOrient[i].filter(c, t));
    return {
      u: this.fu.filter(1 - point.x, t),
      y: this.fy.filter(point.y, t),
      angle: this.fAngle.filter(this.unwrappedAngle, t),
      logScale: this.fScale.filter(Math.log(Math.max(palm2d, 1e-6)), t),
      orientation: orthonormalFrame(v.slice(0, 3), v.slice(3)),
    };
  }

  private event(
    type: ClutchEvent["type"],
    f: Features,
    tMs: number
  ): ClutchEvent {
    const last = type === "move" && this.last ? this.last : f;
    return {
      type,
      gesture: this.gesture!,
      hand: this.hand,
      x: f.u,
      y: f.y,
      dx: f.u - last.u,
      dy: (f.y - last.y) * this.aspect,
      dtheta: f.angle - last.angle,
      dscale: Math.exp(f.logScale - last.logScale),
      drotation:
        this.gesture === "gun"
          ? rotationVector(mulTranspose(f.orientation, last.orientation))
          : [0, 0, 0],
      t: tMs,
    };
  }
}

/** Pinch ratio at which the idle progress ring is empty. */
const PINCH_OPEN_RATIO = 0.8;
/** Fist reach at which the idle progress ring is empty. */
const FIST_OPEN_REACH = 2.0;

function measure(lm: Point[], aspect: number, opts: ClutchOptions): Measures {
  const fingers = FINGER_MCPS.map((mcp) =>
    fingerStraightness(lm, mcp, aspect)
  );
  const reaches = FINGER_MCPS.map(
    (mcp) =>
      dist3(lm[mcp + 3], lm[WRIST], aspect) /
      Math.max(dist3(lm[mcp], lm[WRIST], aspect), 1e-6)
  );
  return {
    ratio:
      dist3(lm[THUMB_TIP], lm[INDEX_TIP], aspect, PINCH_DEPTH_WEIGHT) /
      Math.max(dist3(lm[WRIST], lm[MIDDLE_MCP], aspect), 1e-6),
    reach: Math.max(...reaches),
    otherFingersReach: Math.min(reaches[1], reaches[2], reaches[3]),
    otherFingersMaxReach: Math.max(reaches[1], reaches[2], reaches[3]),
    otherFingersExtension: Math.max(
      ...[1, 2, 3].map((i) =>
        Math.min(
          reaches[i] / opts.fistReleaseReach,
          fingers[i] / opts.fistReleaseStraightness
        )
      )
    ),
    indexReach: reaches[0],
    indexStraightness3d: fingerStraightness3d(lm, INDEX_MCP, aspect),
    thumbOut:
      dist3(lm[THUMB_TIP], lm[MIDDLE_MCP + 1], aspect) /
      Math.max(dist3(lm[WRIST], lm[MIDDLE_MCP], aspect), 1e-6),
    extension: Math.max(
      ...reaches.map((r, i) =>
        Math.min(
          r / opts.fistReleaseReach,
          fingers[i] / opts.fistReleaseStraightness
        )
      )
    ),
    straightness: (fingers[1] + fingers[2] + fingers[3]) / 3,
    fingersStraightness: (fingers[0] + fingers[1] + fingers[2] + fingers[3]) / 4,
    wholeHandVisible: lm.every((p) => insideMargin(p)),
  };
}

/**
 * Where a gesture is, in raw landmark coordinates: between the thumb and
 * index fingertips for a pinch, the middle of the four knuckles for a fist.
 */
function gesturePoint(lm: Point[], gesture: Gesture): { x: number; y: number } {
  const ids = gesture === "pinch" ? [THUMB_TIP, INDEX_TIP] : FINGER_MCPS;
  let x = 0;
  let y = 0;
  for (const i of ids) {
    x += lm[i].x / ids.length;
    y += lm[i].y / ids.length;
  }
  return { x, y };
}

/** Whether the landmarks a gesture depends on are safely inside the frame. */
function gestureVisible(lm: Point[], gesture: Gesture): boolean {
  const ids = gesture === "pinch" ? PINCH_LANDMARKS : FIST_LANDMARKS;
  return ids.every((i) => insideMargin(lm[i]));
}

/**
 * How much of a hand's bounding box may overlap a bigger hand's before it's
 * dropped as a ghost. With `max_num_hands` 2, MediaPipe sometimes reports a
 * second, smaller "hand" on top of a real one: it did in 30% of frames of a
 * recorded side-on fist, sometimes with the same label and listed first.
 * In recorded data ghosts overlapped by 0.44 or more, while two real hands
 * held close together (fingertips almost touching) didn't overlap at all.
 */
const GHOST_OVERLAP = 0.3;

/**
 * Drops hands that mostly overlap a bigger hand (see `GHOST_OVERLAP`).
 * Exported for testing.
 */
export function dropGhostHands<H extends { landmarks: Point[] }>(
  hands: H[]
): H[] {
  if (hands.length < 2) return hands;
  const boxes = hands.map((h) => boundingBox(h.landmarks));
  const order = hands.map((_, i) => i).sort(
    (a, b) => boxArea(boxes[b]) - boxArea(boxes[a])
  );
  const kept: number[] = [];
  for (const i of order) {
    const b = boxes[i];
    const ghost = kept.some(
      (k) => boxArea(intersect(b, boxes[k])) > GHOST_OVERLAP * boxArea(b)
    );
    if (!ghost) kept.push(i);
  }
  // Keep MediaPipe's order.
  return hands.filter((_, i) => kept.includes(i));
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function boundingBox(lm: Point[]): Box {
  const xs = lm.map((p) => p.x);
  const ys = lm.map((p) => p.y);
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
}

function boxArea(b: Box): number {
  return Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
}

function intersect(a: Box, b: Box): Box {
  return {
    x0: Math.max(a.x0, b.x0),
    y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
  };
}

/**
 * How close (in frame widths) a returning hand must be to where a held
 * clutch was last seen to take it over, when two hands may be in view.
 */
const ADOPT_RADIUS = 0.3;

/**
 * Tracks a clutch (pinch or fist) per hand, keyed by MediaPipe's handedness label.
 *
 * MediaPipe sometimes swaps the label when a hand comes back into view. A
 * held clutch would then never see its hand again (and, with no timeout,
 * stay on hold forever) while the same hand starts a second clutch under the
 * other label. To avoid that, a hand that has just appeared (its label
 * wasn't in the previous frame) and has no active clutch takes over a held
 * clutch with the other label, provided that label isn't in view. With
 * `maxHands` 1 that's always the same hand; with 2, it must also appear near
 * where the held clutch was last seen. A hand that's been in view all along
 * is a different hand, so it never takes over. The adopted clutch keeps
 * its original label, so event consumers see one continuous gesture.
 */
export class GestureTracker {
  opts: ClutchOptions;
  /** Most hands MediaPipe will report (the widget's `max_num_hands`). */
  maxHands: number;
  private clutches = new Map<string, HandClutch>();
  /** Incoming label -> label of the held clutch that hand took over. */
  private aliases = new Map<string, string>();
  /** Labels MediaPipe reported in the previous frame. */
  private prevLabels = new Set<string>();
  private claps = new ClapDetector();

  constructor(opts: ClutchOptions = { ...defaultClutchOptions }, maxHands = 1) {
    this.opts = opts;
    this.maxHands = maxHands;
  }

  update(
    hands: Array<{ label: string; landmarks: Point[] }>,
    tMs: number,
    aspect: number
  ): { events: ClutchEvent[]; visuals: ClutchVisual[]; claps: ClapEvent[] } {
    const events: ClutchEvent[] = [];
    const visuals: ClutchVisual[] = [];
    const seen = new Set<string>();
    hands = dropGhostHands(hands);
    const clap = this.claps.update(
      hands.map((h) => h.landmarks),
      tMs,
      aspect,
      this.opts
    );
    const labels = new Set(hands.map((h) => h.label));

    // An alias ends when its clutch is released, or when the clutch's own
    // label is back in view (then that's the hand it belongs to).
    for (const [from, to] of this.aliases) {
      if (labels.has(to) || this.clutches.get(to)?.state === "idle") {
        this.aliases.delete(from);
      }
    }

    for (const { label, landmarks } of hands) {
      let key = this.aliases.get(label) ?? label;
      let clutch = this.clutches.get(key);
      if ((!clutch || clutch.state === "idle") && !this.prevLabels.has(label)) {
        const orphan = this.findOrphan(label, landmarks, labels, seen, aspect);
        if (orphan) {
          this.aliases.set(label, orphan.hand);
          key = orphan.hand;
          clutch = orphan;
        }
      }
      // If MediaPipe labels both hands the same, only track the first.
      if (seen.has(key)) continue;
      seen.add(key);
      if (!clutch) {
        clutch = new HandClutch(key, this.opts);
        this.clutches.set(key, clutch);
      }
      clutch.opts = this.opts;
      const result = clutch.update(landmarks, tMs, aspect);
      events.push(...result.events);
      visuals.push(result.visual);
    }

    for (const [key, clutch] of this.clutches) {
      if (!seen.has(key)) {
        clutch.lost(tMs);
        if (clutch.state === "suspended") {
          visuals.push(clutch.suspendedVisual());
        }
      }
    }

    this.prevLabels = labels;
    // A hand holding a clutch isn't clapping (opening the hands to clap
    // releases it first). This also stops a fist that's moving toward where
    // the other hand just left the frame from counting as one.
    const holding = [...this.clutches.values()].some((c) => c.state === "engaged");
    return { events, visuals, claps: clap && !holding ? [clap] : [] };
  }

  /**
   * An active clutch this hand (labelled `label`) should take over, if any:
   * one whose own label isn't in view this frame, either already on hold or
   * about to be (its label just vanished as this one appeared).
   */
  private findOrphan(
    label: string,
    lm: Point[],
    labels: Set<string>,
    seen: Set<string>,
    aspect: number
  ): HandClutch | undefined {
    for (const clutch of this.clutches.values()) {
      if (
        clutch.state === "idle" ||
        clutch.hand === label ||
        labels.has(clutch.hand) ||
        seen.has(clutch.hand)
      ) {
        continue;
      }
      if (this.maxHands <= 1) return clutch;
      const point = gesturePoint(lm, clutch.gesture ?? "pinch");
      const last = clutch.lastSeen;
      const d = Math.hypot(point.x - last.x, (point.y - last.y) * aspect);
      if (d < ADOPT_RADIUS) return clutch;
    }
    return undefined;
  }

  /**
   * Labels of hands whose clutch is engaged, including clutches on hold
   * waiting for their hand to come back.
   */
  engagedHands(): string[] {
    return [...this.clutches.values()]
      .filter((c) => c.state !== "idle")
      .map((c) => c.hand)
      .sort();
  }
}

/**
 * How much the fingertips' depth difference counts toward the pinch ratio.
 *
 * In a side-on pinch the thumb tip hides behind the index finger, and
 * MediaPipe guesses its depth badly: in recorded data, tips that touched in
 * the image were reported ~0.6 palm lengths apart in depth. Counting depth
 * fully kept those pinches from engaging; ignoring it entirely would let any
 * fingertips that line up in the image count as a pinch. A quarter weight
 * keeps occluded pinches well under the engage threshold while still
 * rejecting large depth gaps.
 */
const PINCH_DEPTH_WEIGHT = 0.25;

/**
 * How far along the line between two hands (from either end, as a fraction
 * of its length) a merged hand must be to count as a clap. When one hand
 * just leaves the frame, the one left is at an end of the line.
 */
const CLAP_MIDDLE = 0.2;

/** Recognizes claps (see `ClutchOptions.clapMinSpan`). */
export class ClapDetector {
  /** Recent frames with two hands: their palm centers, and how far apart. */
  private pairs: Array<{ t: number; a: number[]; b: number[]; span: number }> = [];

  /** `hands` must already be free of ghosts (see `dropGhostHands`). */
  update(
    hands: Point[][],
    tMs: number,
    aspect: number,
    opts: ClutchOptions
  ): ClapEvent | null {
    this.pairs = this.pairs.filter((p) => tMs - p.t <= opts.clapWindowMs);
    if (hands.length === 2) {
      const [a, b] = hands.map((lm) => palmCenter(lm, aspect));
      const size = (palmLength(hands[0], aspect) + palmLength(hands[1], aspect)) / 2;
      this.pairs.push({ t: tMs, a, b, span: Math.hypot(b[0] - a[0], b[1] - a[1]) / size });
      return null;
    }
    if (hands.length !== 1 || this.pairs.length === 0) return null;
    const widest = this.pairs.reduce((m, p) => (p.span > m.span ? p : m));
    if (widest.span < opts.clapMinSpan) return null;
    // Where the remaining hand is along the line between the two.
    const [ax, ay] = widest.a;
    const [bx, by] = widest.b;
    const [px, py] = palmCenter(hands[0], aspect);
    const along =
      ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) /
      ((bx - ax) ** 2 + (by - ay) ** 2);
    if (along < CLAP_MIDDLE || along > 1 - CLAP_MIDDLE) return null;
    this.pairs = [];
    return { type: "clap", x: 1 - px, y: py / aspect, t: tMs };
  }
}

/** Center of the palm, in frame widths (y rescaled by `aspect`). */
function palmCenter(lm: Point[], aspect: number): number[] {
  const n = PALM.length;
  return [
    PALM.reduce((s, i) => s + lm[i].x, 0) / n,
    (PALM.reduce((s, i) => s + lm[i].y, 0) / n) * aspect,
  ];
}

/** Wrist to middle knuckle, in frame widths, ignoring depth. */
function palmLength(lm: Point[], aspect: number): number {
  return Math.hypot(lm[MIDDLE_MCP].x - lm[WRIST].x, (lm[MIDDLE_MCP].y - lm[WRIST].y) * aspect);
}

function dist3(a: Point, b: Point, aspect: number, zWeight = 1): number {
  // MediaPipe normalizes x by width and y by height; z is roughly on the
  // same scale as x. Rescale y so all three axes are in frame-width units.
  return Math.hypot(a.x - b.x, (a.y - b.y) * aspect, (a.z - b.z) * zWeight);
}

function insideMargin(p: Point): boolean {
  return (
    p.x >= EDGE_MARGIN &&
    p.x <= 1 - EDGE_MARGIN &&
    p.y >= EDGE_MARGIN &&
    p.y <= 1 - EDGE_MARGIN
  );
}

/**
 * How straight a finger is, from its knuckle (MCP) to its tip: the
 * knuckle-to-tip distance divided by the length along its joints, in the
 * image plane. 1 when straight, lower as it curls. Projection keeps a
 * straight finger straight, so this works whichever way the finger points.
 */
/** Like `fingerStraightness`, in 3D (MediaPipe's depth estimate included). */
function fingerStraightness3d(lm: Point[], mcp: number, aspect: number): number {
  const d = (a: number, b: number) => dist3(lm[a], lm[b], aspect);
  const along = d(mcp, mcp + 1) + d(mcp + 1, mcp + 2) + d(mcp + 2, mcp + 3);
  return along > 1e-6 ? d(mcp, mcp + 3) / along : 0;
}

/**
 * Two vectors that fix the hand's orientation, in the user's own frame: x
 * toward the user's right, y down, z toward the screen (mirroring x and
 * flipping MediaPipe's depth keeps the axes right-handed). "along" points
 * out of the hand, averaging the index finger's direction with the palm's
 * (wrist to middle knuckle), and "across" runs from the index knuckle to
 * the pinky's. Holding a gun still, the resulting orientation jittered by
 * about 0.4 degrees per frame before smoothing.
 */
function handVectors(lm: Point[], aspect: number): [number[], number[]] {
  const s = (i: number) => [-lm[i].x, lm[i].y * aspect, -lm[i].z];
  const sub = (a: number[], b: number[]) => a.map((v, k) => v - b[k]);
  const unit = (v: number[]) => {
    const n = Math.hypot(...v) || 1;
    return v.map((c) => c / n);
  };
  const index = unit(sub(s(INDEX_TIP), s(INDEX_MCP)));
  const palm = unit(sub(s(MIDDLE_MCP), s(WRIST)));
  return [
    unit(index.map((c, k) => c + palm[k])),
    sub(s(PINKY_MCP), s(INDEX_MCP)),
  ];
}

/**
 * Rotation matrix (row-major 3x3) whose columns are `along`, `across` made
 * perpendicular to it, and their cross product.
 */
function orthonormalFrame(along: number[], across: number[]): number[] {
  const unit = (v: number[]) => {
    const n = Math.hypot(...v) || 1;
    return v.map((c) => c / n);
  };
  const e1 = unit(along);
  const dot = across.reduce((s, c, k) => s + c * e1[k], 0);
  const e2 = unit(across.map((c, k) => c - dot * e1[k]));
  const e3 = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
  return [0, 1, 2].flatMap((r) => [e1[r], e2[r], e3[r]]);
}

/** a * b^T, for row-major 3x3 matrices. */
function mulTranspose(a: number[], b: number[]): number[] {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += a[r * 3 + k] * b[c * 3 + k];
      out.push(sum);
    }
  }
  return out;
}

/** Rotation vector (axis times angle) of a row-major 3x3 rotation matrix. */
export function rotationVector(m: number[]): [number, number, number] {
  const cos = Math.min(1, Math.max(-1, (m[0] + m[4] + m[8] - 1) / 2));
  const angle = Math.acos(cos);
  const w = [m[7] - m[5], m[2] - m[6], m[3] - m[1]];
  const sin = Math.sin(angle);
  // Small angles: w / 2 is accurate (sin ~ angle).
  const k = sin > 1e-6 ? angle / (2 * sin) : 0.5;
  return [w[0] * k, w[1] * k, w[2] * k];
}

function fingerStraightness(lm: Point[], mcp: number, aspect: number): number {
  const p = (i: number) => ({ x: lm[i].x, y: lm[i].y * aspect });
  const d = (a: number, b: number) =>
    Math.hypot(p(a).x - p(b).x, p(a).y - p(b).y);
  const along = d(mcp, mcp + 1) + d(mcp + 1, mcp + 2) + d(mcp + 2, mcp + 3);
  return along > 1e-6 ? d(mcp, mcp + 3) / along : 0;
}

function wrapToPi(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
