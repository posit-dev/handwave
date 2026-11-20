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
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const RING_MCP = 13;
const PINKY_MCP = 17;
/** Palm landmarks, averaged to track how fast the hand is moving. */
const PALM = [WRIST, 5, MIDDLE_MCP, RING_MCP, PINKY_MCP];
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

export interface ClutchOptions {
  /** Pinch ratio below which a pinch engages. */
  engageThreshold: number;
  /** Pinch ratio above which an engaged pinch releases. */
  releaseThreshold: number;
  /**
   * How long (ms) the engage pose must be held before the clutch engages.
   *
   * Engaging takes a deliberate pose, so a relaxed hand can't engage by
   * accident: thumb and index fingertips touching, the other three fingers
   * extended (an "OK" sign), the whole hand in view, and the hand nearly
   * still. Staying engaged only needs the fingertips to stay together.
   */
  engageMs: number;
  /**
   * Minimum average straightness of the middle, ring and pinky fingers to
   * engage, from 0 (folded) to 1 (straight). In recorded data, deliberate
   * "OK" signs measured 0.91-1.0, relaxed or dropping hands 0.2-0.8.
   */
  engageStraightness: number;
  /**
   * Fastest the palm may move while engaging, in frame widths per second.
   * In recorded data, deliberate pinches engaged below 0.1; accidental ones
   * on a dropping hand at 0.7-4.
   */
  engageMaxSpeed: number;
  /** Consecutive frames above `releaseThreshold` required to release. */
  releaseFrames: number;
  /**
   * Consecutive frames above `releaseThreshold` required to release a clutch
   * that's on hold, once the hand is back in view. Higher than
   * `releaseFrames` because MediaPipe takes a moment to settle on a
   * re-entering hand, and a false release is costlier than a late one.
   */
  releaseFramesAfterHold: number;
}

export const defaultClutchOptions: ClutchOptions = {
  engageThreshold: 0.25,
  releaseThreshold: 0.4,
  engageMs: 100,
  engageStraightness: 0.85,
  engageMaxSpeed: 0.5,
  releaseFrames: 2,
  releaseFramesAfterHold: 5,
};

export interface ClutchEvent {
  type: "start" | "move" | "end";
  gesture: "pinch";
  hand: string;
  /**
   * Pinch point, normalized to [0, 1] across the frame. Mirrored like the
   * preview, so x increases toward the user's right; y increases downward.
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
  /** Milliseconds, from `performance.now()`. */
  t: number;
}

export interface ClutchVisual {
  hand: string;
  /**
   * "frozen": engaged, but movement is ignored (pinch loosening, or the
   * first frame back in view).
   * "suspended": engaged, but on hold because the hand is gone or part of
   * its thumb or index fingertip is at the edge; waiting for it to come back.
   */
  state: "idle" | "engaged" | "frozen" | "suspended";
  ratio: number;
  /** Idle: 0..1, how close the pinch is to engaging. */
  progress: number;
  /** Average straightness of the middle, ring and pinky fingers (0..1). */
  straightness: number;
  /** Pinch point and start point in raw (unmirrored) landmark coordinates. */
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
}

/**
 * Pinch clutch for one hand: thumb and index fingertips together = engaged.
 *
 * The pinch ratio is fingertip distance divided by palm length (wrist to
 * middle knuckle), so thresholds don't depend on distance from the camera.
 * Engage and release use different thresholds (hysteresis) so the state
 * doesn't flicker. Between "engaged" and "released" there is a dead band where
 * the pinch is loosening: movement there is ignored, which keeps the fingers
 * opening from dragging the data on release.
 *
 * If the hand leaves the frame (or tracking drops) mid-pinch, the clutch is
 * put on hold rather than ended, for as long as it takes: it resumes without
 * a jump if the hand comes back pinched, and releases if it comes back open
 * (and stays open for `releaseFramesAfterHold` frames). The same happens
 * while either fingertip (or the joint below it) is outside the frame or within
 * `EDGE_MARGIN` of it, where MediaPipe guesses at landmarks: neither their
 * movement nor whether they look pinched can be trusted.
 */
export class PinchClutch {
  readonly hand: string;
  opts: ClutchOptions;
  state: "idle" | "engaged" | "suspended" = "idle";

  /** When the engage pose was first seen, if it's been held since. */
  private engageSince: number | undefined;
  /** Recent palm positions (frame widths) for measuring speed. */
  private palmTrail: Array<{ t: number; x: number; y: number }> = [];
  private aboveCount = 0;
  // Positions are in frame units; speeds of ~1 frame/sec are typical.
  private fu = new OneEuroFilter(1.5, 8);
  private fy = new OneEuroFilter(1.5, 8);
  private fAngle = new OneEuroFilter(1.5, 0.5);
  private fScale = new OneEuroFilter(1.5, 0.5);
  private rawAngle: number | undefined;
  private unwrappedAngle = 0;
  private last: Features | undefined;
  private anchor: { x: number; y: number } | undefined;
  private lastPoint = { x: 0.5, y: 0.5 };
  private lastRatio = 0;
  private outOfFrame = false;
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

    const ratio =
      dist3(lm[THUMB_TIP], lm[INDEX_TIP], aspect, PINCH_DEPTH_WEIGHT) /
      Math.max(dist3(lm[WRIST], lm[MIDDLE_MCP], aspect), 1e-6);
    const point = {
      x: (lm[THUMB_TIP].x + lm[INDEX_TIP].x) / 2,
      y: (lm[THUMB_TIP].y + lm[INDEX_TIP].y) / 2,
    };
    const visible = PINCH_LANDMARKS.every((i) => insideMargin(lm[i]));
    const wholeHandVisible = lm.every((p) => insideMargin(p));
    const straightness =
      (fingerStraightness(lm, MIDDLE_MCP, aspect) +
        fingerStraightness(lm, RING_MCP, aspect) +
        fingerStraightness(lm, PINKY_MCP, aspect)) /
      3;
    const speed = this.palmSpeed(lm, tMs, aspect);
    const reenteredFrame = visible && this.outOfFrame;
    this.outOfFrame = !visible;
    if (this.state === "suspended" || reenteredFrame) {
      // The hand jumped while it was out of view (or its landmarks were
      // extrapolated off the edge); don't smooth across that.
      this.resetFilters();
    }
    const f = this.features(lm, point, tMs / 1000, aspect);
    this.lastPoint = point;
    this.lastRatio = ratio;

    let frozen = false;
    if (this.state === "suspended") {
      if (!visible) {
        // Still (partly) off the edge: the pinch can't be judged yet.
      } else if (ratio < opts.releaseThreshold) {
        // Back, still pinched: resume from here, without a jump.
        this.state = "engaged";
        this.aboveCount = 0;
        this.last = f;
        frozen = true;
      } else {
        // Back, but open: that's a release, if it stays open.
        this.aboveCount += 1;
        if (this.aboveCount >= opts.releaseFramesAfterHold) {
          events.push(this.event("end", f, tMs));
          this.disengage();
        }
      }
    } else if (this.state === "idle") {
      const ready =
        ratio < opts.engageThreshold &&
        wholeHandVisible &&
        straightness >= opts.engageStraightness &&
        speed < opts.engageMaxSpeed;
      if (!ready) {
        this.engageSince = undefined;
      } else {
        this.engageSince ??= tMs;
      }
      if (
        this.engageSince !== undefined &&
        tMs - this.engageSince >= opts.engageMs
      ) {
        this.engageSince = undefined;
        this.state = "engaged";
        this.aboveCount = 0;
        this.last = f;
        this.anchor = point;
        events.push(this.event("start", f, tMs));
      }
    } else if (!visible) {
      // A fingertip (or the joint below it) went off or near the edge.
      // MediaPipe still tracks the hand but guesses those landmarks, so the
      // pinch point and ratio can't be trusted: put the clutch on hold, as
      // if the hand was lost.
      this.suspend();
    } else {
      this.aboveCount =
        ratio > opts.releaseThreshold ? this.aboveCount + 1 : 0;
      if (this.aboveCount >= opts.releaseFrames) {
        events.push(this.event("end", f, tMs));
        this.disengage();
      } else if (ratio > (opts.engageThreshold + opts.releaseThreshold) / 2) {
        // Loosening pinch: rebase so nothing jumps if it firms up again.
        frozen = true;
        this.last = f;
      } else {
        events.push(this.event("move", f, tMs));
        this.last = f;
      }
    }

    if (this.state === "suspended") {
      return { events, visual: this.suspendedVisual() };
    }
    const openRatio = 0.8;
    const progress = clamp01(
      (openRatio - ratio) / (openRatio - opts.engageThreshold)
    );
    return {
      events,
      visual: {
        hand: this.hand,
        state: this.state === "idle" ? "idle" : frozen ? "frozen" : "engaged",
        ratio,
        progress,
        straightness,
        point,
        anchor: this.state === "engaged" ? this.anchor : undefined,
      },
    };
  }

  /**
   * Call when the hand is no longer detected. An engaged clutch goes on hold
   * until the hand comes back; there's no timeout.
   */
  lost() {
    if (this.state === "engaged") {
      this.suspend();
    } else if (this.state === "idle") {
      this.engageSince = undefined;
      this.resetFilters();
    }
    this.palmTrail = [];
  }

  /** Pinch point where the hand was last seen, in raw landmark coordinates. */
  get lastSeen(): { x: number; y: number } {
    return this.lastPoint;
  }

  /** Feedback for a suspended clutch: where the hand was last seen. */
  suspendedVisual(): ClutchVisual {
    return {
      hand: this.hand,
      state: "suspended",
      ratio: this.lastRatio,
      progress: 0,
      straightness: 0,
      point: this.lastPoint,
      anchor: this.anchor,
    };
  }

  private suspend() {
    this.state = "suspended";
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
    this.rawAngle = undefined;
  }

  private features(
    lm: Point[],
    point: { x: number; y: number },
    t: number,
    aspect: number
  ): Features {
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
    return {
      u: this.fu.filter(1 - point.x, t),
      y: this.fy.filter(point.y, t),
      angle: this.fAngle.filter(this.unwrappedAngle, t),
      logScale: this.fScale.filter(Math.log(Math.max(palm2d, 1e-6)), t),
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
      gesture: "pinch",
      hand: this.hand,
      x: f.u,
      y: f.y,
      dx: f.u - last.u,
      dy: (f.y - last.y) * this.aspect,
      dtheta: f.angle - last.angle,
      dscale: Math.exp(f.logScale - last.logScale),
      t: tMs,
    };
  }
}

/**
 * How close (in frame widths) a returning hand must be to where a held
 * clutch was last seen to take it over, when two hands may be in view.
 */
const ADOPT_RADIUS = 0.3;

/**
 * Tracks a pinch clutch per hand, keyed by MediaPipe's handedness label.
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
  private clutches = new Map<string, PinchClutch>();
  /** Incoming label -> label of the held clutch that hand took over. */
  private aliases = new Map<string, string>();
  /** Labels MediaPipe reported in the previous frame. */
  private prevLabels = new Set<string>();

  constructor(opts: ClutchOptions = { ...defaultClutchOptions }, maxHands = 1) {
    this.opts = opts;
    this.maxHands = maxHands;
  }

  update(
    hands: Array<{ label: string; landmarks: Point[] }>,
    tMs: number,
    aspect: number
  ): { events: ClutchEvent[]; visuals: ClutchVisual[] } {
    const events: ClutchEvent[] = [];
    const visuals: ClutchVisual[] = [];
    const seen = new Set<string>();
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
        clutch = new PinchClutch(key, this.opts);
        this.clutches.set(key, clutch);
      }
      clutch.opts = this.opts;
      const result = clutch.update(landmarks, tMs, aspect);
      events.push(...result.events);
      visuals.push(result.visual);
    }

    for (const [key, clutch] of this.clutches) {
      if (!seen.has(key)) {
        clutch.lost();
        if (clutch.state === "suspended") {
          visuals.push(clutch.suspendedVisual());
        }
      }
    }

    this.prevLabels = labels;
    return { events, visuals };
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
  ): PinchClutch | undefined {
    const point = {
      x: (lm[THUMB_TIP].x + lm[INDEX_TIP].x) / 2,
      y: (lm[THUMB_TIP].y + lm[INDEX_TIP].y) / 2,
    };
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
