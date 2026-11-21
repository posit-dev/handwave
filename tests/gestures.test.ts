// Run with: npm test (Node 22.18+ runs TypeScript directly)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  defaultClutchOptions,
  dropGhostHands,
  GestureTracker,
  rotationVector,
  type ClapEvent,
  type ClutchEvent,
  type ReelEvent,
  type Point,
} from "../js/gestures.ts";

const ASPECT = 0.75; // 640x480

/**
 * Synthetic hand: wrist 0.2 frame widths below (cx, cy), middle knuckle at
 * (cx, cy), thumb and index tips `gap` apart (in frame widths) around it.
 * Middle, ring and pinky extend straight up from their knuckles, unless
 * `curled`. `roll` rotates the whole hand in the image plane.
 */
function hand(
  cx: number,
  cy: number,
  gap: number,
  roll = 0,
  curled = false
): Point[] {
  // Build in isotropic frame-width units with y down, then convert.
  const up = { x: -Math.sin(roll), y: -Math.cos(roll) }; // wrist -> knuckle
  const side = { x: -up.y, y: up.x };
  const c = { x: cx, y: cy * ASPECT };
  const at = (along: number, across: number): Point => ({
    x: c.x + up.x * along + side.x * across,
    y: (c.y + up.y * along + side.y * across) / ASPECT,
    z: 0,
  });
  const lerp = (a: Point, b: Point, k: number): Point => ({
    x: a.x + (b.x - a.x) * k,
    y: a.y + (b.y - a.y) * k,
    z: 0,
  });
  const lm: Point[] = Array.from({ length: 21 }, () => at(0, 0));
  lm[0] = at(-0.2, 0);
  lm[4] = { x: cx - gap / 2, y: cy, z: 0 };
  lm[8] = { x: cx + gap / 2, y: cy, z: 0 };
  for (const k of [1, 2, 3]) lm[k] = lerp(lm[0], lm[4], k / 4);
  for (const k of [5, 6, 7]) lm[k] = lerp(lm[0], lm[8], 0.55 + (k - 5) * 0.15);
  [9, 13, 17].forEach((mcp, f) => {
    const across = f * 0.015;
    lm[mcp] = at(0, across);
    for (const j of [1, 2, 3]) {
      lm[mcp + j] = curled
        ? at([0.04, 0.03, 0.01][j - 1], across + [0, 0.02, 0.015][j - 1])
        : at(0.04 * j, across);
    }
  });
  return lm;
}

/** Frames needed to engage: the pose must be held for 100ms (frames are 33ms). */
const ENGAGE = 5;

/**
 * Frames for a hold longer than `bridgeMs` (200ms), after which a clutch
 * resumes without a jump instead of carrying on as if never lost.
 */
const LONG_HOLD = 8;

function run(tracker: GestureTracker, frames: Array<Point[] | null>) {
  const events: ClutchEvent[] = [];
  frames.forEach((lm, i) => {
    const hands = lm ? [{ label: "Right", landmarks: lm }] : [];
    events.push(...tracker.update(hands, i * 33, ASPECT).events);
  });
  return events;
}

const OPEN = 0.16; // ratio 0.8
const CLOSED = 0.02; // ratio 0.1

test("engages after debounce, moves, releases", () => {
  const tracker = new GestureTracker();
  const frames = [
    hand(0.5, 0.5, OPEN),
    // Pose first seen at 33ms; engages once held for 100ms
    ...Array.from({ length: ENGAGE }, () => hand(0.5, 0.5, CLOSED)),
    ...Array.from({ length: 30 }, (_, i) => hand(0.5 - 0.01 * (i + 1), 0.5, CLOSED)),
    hand(0.2, 0.5, OPEN),
    hand(0.2, 0.5, OPEN),
  ];
  const events = run(tracker, frames);
  assert.deepEqual(
    events.map((e) => e.type),
    ["start", ...Array(30).fill("move"), "end"]
  );
  assert.equal(events[0].t, 5 * 33);

  // Raw x decreasing = moving to the user's right in the mirrored view.
  const totalDx = events.reduce((sum, e) => sum + e.dx, 0);
  assert.ok(totalDx > 0.2 && totalDx <= 0.3 + 1e-9, `totalDx=${totalDx}`);
  assert.equal(tracker.engagedHands().length, 0);
});

test("single-frame dip does not engage", () => {
  const tracker = new GestureTracker();
  const events = run(tracker, [
    hand(0.5, 0.5, OPEN),
    hand(0.5, 0.5, CLOSED),
    hand(0.5, 0.5, OPEN),
    hand(0.5, 0.5, CLOSED),
    hand(0.5, 0.5, OPEN),
  ]);
  assert.deepEqual(events, []);
});

test("hysteresis: ratio between thresholds stays engaged but frozen", () => {
  const tracker = new GestureTracker();
  const loose = 0.07; // ratio 0.35: above midpoint, below release
  const events = run(tracker, [
    ...Array.from({ length: ENGAGE }, () => hand(0.5, 0.5, CLOSED)),
    // Loosen and move: should be ignored, not released.
    ...Array.from({ length: 10 }, (_, i) => hand(0.5, 0.5 + 0.01 * (i + 1), loose)),
    hand(0.5, 0.6, CLOSED),
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["start", "move"]
  );
  assert.ok(Math.abs(events[1].dy) < 0.01, `dy jumped: ${events[1].dy}`);
});

test("clutch stays on hold however long the hand is gone", () => {
  const tracker = new GestureTracker();
  const events = run(tracker, [
    ...Array.from({ length: ENGAGE }, () => hand(0.5, 0.5, CLOSED)),
    ...Array(600).fill(null), // ~20 s off screen
    hand(0.3, 0.5, CLOSED),
    hand(0.29, 0.5, CLOSED),
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["start", "move"]
  );
  assert.deepEqual(tracker.engagedHands(), ["Right"]);
});

test("hand that comes back pinched resumes without a jump", () => {
  const tracker = new GestureTracker();
  const events = run(tracker, [
    ...Array.from({ length: ENGAGE }, () => hand(0.5, 0.5, CLOSED)),
    ...Array(10).fill(null), // ~330ms off screen
    // Comes back somewhere else, then keeps moving
    ...Array.from({ length: 10 }, (_, i) => hand(0.2 - 0.01 * i, 0.3, CLOSED)),
  ]);
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ["start", ...Array(9).fill("move")]);
  assert.deepEqual(tracker.engagedHands(), ["Right"]);
  // No jump from (0.5, 0.5) to (0.2, 0.3): only the post-return motion counts.
  const totalDx = events.reduce((s, e) => s + e.dx, 0);
  const totalDy = events.reduce((s, e) => s + e.dy, 0);
  assert.ok(totalDx > 0 && totalDx <= 0.09 + 1e-9, `totalDx=${totalDx}`);
  assert.ok(Math.abs(totalDy) < 1e-9, `totalDy=${totalDy}`);
});

test("clutch counts as engaged while on hold", () => {
  const tracker = new GestureTracker();
  run(tracker, [...Array.from({ length: ENGAGE }, () => hand(0.5, 0.5, CLOSED)), null]);
  assert.deepEqual(tracker.engagedHands(), ["Right"]);
  const { visuals } = tracker.update([], 400, ASPECT);
  assert.equal(visuals[0].state, "suspended");
});

test("hand that comes back open releases once it stays open", () => {
  const tracker = new GestureTracker();
  const events = run(tracker, [
    ...Array.from({ length: ENGAGE }, () => hand(0.5, 0.5, CLOSED)),
    ...Array(5).fill(null),
    ...Array.from({ length: 4 }, () => hand(0.3, 0.5, OPEN)),
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["start"],
    "released before 5 open frames"
  );
  const more = run(tracker, [hand(0.3, 0.5, OPEN)]);
  assert.deepEqual(
    more.map((e) => e.type),
    ["end"]
  );
});

test("hand that comes back looking open briefly, then pinched, resumes", () => {
  const tracker = new GestureTracker();
  const events = run(tracker, [
    ...Array.from({ length: ENGAGE }, () => hand(0.5, 0.5, CLOSED)),
    ...Array(5).fill(null),
    // MediaPipe settling on the re-entering hand
    ...Array.from({ length: 4 }, () => hand(0.3, 0.5, OPEN)),
    hand(0.3, 0.5, CLOSED),
    hand(0.29, 0.5, CLOSED),
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["start", "move"]
  );
});

test("clutch goes on hold while the fingertips are off the edge of the frame", () => {
  const tracker = new GestureTracker();
  const events = run(tracker, [
    ...Array.from({ length: ENGAGE }, () => hand(0.8, 0.5, CLOSED)),
    hand(0.85, 0.5, CLOSED),
    // Fingertips past the edge (longer than bridgeMs): MediaPipe
    // extrapolates these
    hand(1.05, 0.5, CLOSED),
    ...Array.from({ length: LONG_HOLD - 2 }, () => hand(1.2, 0.5, CLOSED)),
    hand(1.1, 0.5, CLOSED),
    // Back in view, still pinched: the first frame back only re-anchors
    hand(0.88, 0.5, CLOSED),
    hand(0.87, 0.5, CLOSED),
    hand(0.86, 0.5, CLOSED),
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["start", "move", "move", "move"]
  );
  // Raw x 0.8 -> 0.85 is 0.05 toward the user's left (dx < 0); then
  // 0.88 -> 0.86 is 0.02 back to the right. The off-screen excursion and the
  // jump back from it don't count.
  const totalDx = events.reduce((s, e) => s + e.dx, 0);
  assert.ok(totalDx > -0.05 + 1e-9 && totalDx < -0.01, `totalDx=${totalDx}`);
});

test("twist reports roll; vertical moves are scaled to frame widths", () => {
  const tracker = new GestureTracker();
  const steps = 40;
  const events = run(tracker, [
    ...Array.from({ length: ENGAGE }, () => hand(0.5, 0.5, CLOSED)),
    ...Array.from({ length: steps }, (_, i) =>
      hand(0.5, 0.5 + (0.2 * (i + 1)) / steps, CLOSED, (Math.PI / 2) * ((i + 1) / steps))
    ),
    ...Array.from({ length: 20 }, () => hand(0.5, 0.7, CLOSED, Math.PI / 2)),
  ]);
  const dtheta = events.reduce((s, e) => s + e.dtheta, 0);
  const dy = events.reduce((s, e) => s + e.dy, 0);
  // Wrist swinging to raw +x = to the user's left = knuckle direction turns
  // clockwise on the mirrored screen.
  assert.ok(Math.abs(dtheta - Math.PI / 2) < 0.05, `dtheta=${dtheta}`);
  assert.ok(Math.abs(dy - 0.2 * ASPECT) < 0.005, `dy=${dy}`);
});

test("two hands are tracked independently", () => {
  const tracker = new GestureTracker();
  const both = (lgap: number, rgap: number) => [
    { label: "Left", landmarks: hand(0.7, 0.5, lgap) },
    { label: "Right", landmarks: hand(0.3, 0.5, rgap) },
  ];
  let t = 0;
  for (let i = 0; i < ENGAGE; i++) tracker.update(both(CLOSED, OPEN), (t += 33), ASPECT);
  assert.deepEqual(tracker.engagedHands(), ["Left"]);
  for (let i = 0; i < ENGAGE; i++) tracker.update(both(CLOSED, CLOSED), (t += 33), ASPECT);
  assert.deepEqual(tracker.engagedHands(), ["Left", "Right"]);
});
test("recorded side-on pinch (thumb hidden behind index) engages", async () => {
  const fixture = JSON.parse(
    readFileSync(`${import.meta.dirname}/fixtures/side-on-pinch.json`, "utf8")
  );
  const tracker = new GestureTracker();
  const aspect = fixture.height / fixture.width;
  const events: ClutchEvent[] = [];
  for (const frame of fixture.frames) {
    const landmarks = frame.landmarks.map(([x, y, z]: number[]) => ({ x, y, z }));
    events.push(
      ...tracker.update([{ label: fixture.hand, landmarks }], frame.t, aspect).events
    );
  }
  assert.equal(events[0]?.type, "start");
  assert.ok(events[0].t < 200, `engaged late, at ${events[0].t}ms`);
  assert.ok(!events.some((e) => e.type === "end"), "released mid-pinch");
  assert.deepEqual(tracker.engagedHands(), [fixture.hand]);
});

test("fingertips that line up in the image but are far apart in depth don't engage", () => {
  const tracker = new GestureTracker();
  const deep = () => {
    const lm = hand(0.5, 0.5, 0);
    lm[4] = { ...lm[4], z: 0.2 }; // one palm length behind the index tip
    return lm;
  };
  const events = run(tracker, [deep(), deep(), deep(), deep()]);
  assert.deepEqual(events, []);
});

test("fingertips off the edge that look open don't release the clutch", () => {
  const tracker = new GestureTracker();
  const events = run(tracker, [
    ...Array.from({ length: ENGAGE }, () => hand(0.9, 0.5, CLOSED)),
    // Partly off the edge: MediaPipe's extrapolated fingertips look open
    hand(1.05, 0.5, OPEN),
    ...Array.from({ length: LONG_HOLD }, () => hand(1.1, 0.5, OPEN)),
    // Back in frame, still pinched
    hand(0.95, 0.5, CLOSED),
    hand(0.94, 0.5, CLOSED),
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["start", "move"]
  );
  assert.deepEqual(tracker.engagedHands(), ["Right"]);
});

test("leaving and re-entering twice keeps one clutch", () => {
  const tracker = new GestureTracker();
  const away = (n: number) => Array(n).fill(null);
  const edge = (n: number) => Array.from({ length: n }, () => hand(1.1, 0.5, OPEN));
  const events = run(tracker, [
    ...Array.from({ length: ENGAGE }, () => hand(0.5, 0.5, CLOSED)),
    hand(0.9, 0.5, CLOSED),
    ...edge(3),
    ...away(5),
    hand(0.9, 0.5, CLOSED),
    hand(0.85, 0.5, CLOSED),
    ...edge(3),
    ...away(5),
    ...edge(2),
    hand(0.9, 0.5, CLOSED),
    hand(0.85, 0.5, CLOSED),
  ]);
  assert.equal(events.filter((e) => e.type === "start").length, 1);
  assert.equal(events.filter((e) => e.type === "end").length, 0);
});

test("fingertips held off the edge stay on hold", () => {
  const tracker = new GestureTracker();
  const events = run(tracker, [
    ...Array.from({ length: ENGAGE }, () => hand(0.9, 0.5, CLOSED)),
    ...Array.from({ length: 300 }, () => hand(1.1, 0.5, OPEN)), // ~10 s
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["start"]
  );
  assert.deepEqual(tracker.engagedHands(), ["Right"]);
});

/** Pinched hand whose thumb (base to tip) is at raw x = `thumbX`. */
function handWithThumbAt(cx: number, thumbX: number): Point[] {
  const lm = hand(cx, 0.5, CLOSED);
  for (const i of [1, 2, 3, 4]) lm[i] = { ...lm[i], x: thumbX };
  // A real pinch keeps the tips together; this one reports the thumb tip
  // wherever MediaPipe guesses, so the ratio looks wide open.
  return lm;
}

test("one finger back in view before the other doesn't release", () => {
  const tracker = new GestureTracker();
  const events = run(tracker, [
    ...Array.from({ length: ENGAGE }, () => hand(0.8, 0.5, CLOSED)),
    ...Array(5).fill(null),
    // Index finger back in view; thumb still past the edge, and MediaPipe's
    // guess for it makes the hand look open.
    ...Array.from({ length: 10 }, () => handWithThumbAt(0.88, 1.08)),
    // Thumb in frame but inside the edge margin (ratio 0.5: looks open)
    ...Array.from({ length: 10 }, () => handWithThumbAt(0.88, 0.98)),
    // Whole hand in view, pinched
    hand(0.88, 0.5, CLOSED),
    hand(0.87, 0.5, CLOSED),
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["start", "move"]
  );
});

test("fingers within the edge margin put the clutch on hold", () => {
  const tracker = new GestureTracker();
  const events = run(tracker, [
    ...Array.from({ length: ENGAGE }, () => hand(0.9, 0.5, CLOSED)),
    // Index tip at 0.97: in frame, but within the 4% margin, and the
    // hand looks open
    ...Array.from({ length: 5 }, () => hand(0.89, 0.5, OPEN)),
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["start"]
  );
  const { visuals } = tracker.update([{ label: "Right", landmarks: hand(0.89, 0.5, OPEN) }], 1000, ASPECT);
  assert.equal(visuals[0].state, "suspended");
});

test("can't engage with part of the hand out of view", () => {
  const tracker = new GestureTracker();
  const events = run(tracker, [
    ...Array.from({ length: 5 }, () => hand(0.98, 0.5, CLOSED)),
  ]);
  assert.deepEqual(events, []);
});

test("wrist going below the frame doesn't interrupt the clutch", () => {
  const tracker = new GestureTracker();
  // Engage with the whole hand in view, then lower it until the wrist is
  // out of frame; the fingertips stay in view.
  const at = (cy: number) => hand(0.5, cy, CLOSED);
  const events = run(tracker, [
    ...Array.from({ length: ENGAGE }, () => at(0.6)),
    ...Array.from({ length: 10 }, (_, i) => at(0.62 + 0.03 * i)),
  ]);
  assert.ok(at(0.89)[0].y > 1, "wrist should be out of frame by the end");
  assert.deepEqual(
    events.map((e) => e.type),
    ["start", ...Array(10).fill("move")]
  );
});
test("thumb joint next to the tip off the edge puts the clutch on hold", () => {
  const tracker = new GestureTracker();
  // Thumb tip in view (and apart from the index tip, so the hand looks
  // open) while the thumb's last joint is past the edge.
  const thumbJointOut = () => {
    const lm = hand(0.85, 0.5, CLOSED);
    lm[3] = { ...lm[3], x: 1.05 };
    lm[4] = { x: 0.94, y: 0.4, z: 0 };
    return lm;
  };
  const events = run(tracker, [
    ...Array.from({ length: ENGAGE }, () => hand(0.85, 0.5, CLOSED)),
    ...Array.from({ length: 10 }, thumbJointOut),
    hand(0.85, 0.5, CLOSED),
    hand(0.84, 0.5, CLOSED),
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["start", "move"]
  );
});

test("knuckles going off the edge don't interrupt the clutch", () => {
  const tracker = new GestureTracker();
  // Engage with the whole hand in view; then the thumb base, index
  // knuckles and middle knuckle go past the edge while the fingertips
  // stay well inside the frame.
  const knucklesOut = (cx: number, gap: number) => {
    const lm = hand(cx, 0.5, gap);
    for (const i of [1, 2, 5, 6, 9]) lm[i] = { ...lm[i], x: 1.05 };
    return lm;
  };
  const events = run(tracker, [
    ...Array.from({ length: ENGAGE }, () => hand(0.85, 0.5, CLOSED)),
    knucklesOut(0.84, CLOSED),
    knucklesOut(0.83, CLOSED),
    knucklesOut(0.83, OPEN),
    knucklesOut(0.83, OPEN),
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["start", "move", "move", "end"]
  );
});

test("can't engage with the knuckles out of view", () => {
  const tracker = new GestureTracker();
  const knucklesOut = () => {
    const lm = hand(0.85, 0.5, CLOSED);
    for (const i of [1, 2, 5, 6, 9]) lm[i] = { ...lm[i], x: 1.05 };
    return lm;
  };
  assert.deepEqual(run(tracker, Array.from({ length: 10 }, knucklesOut)), []);
});
/** Like run(), but each frame names its hands: [label, landmarks] pairs. */
function runLabeled(
  tracker: GestureTracker,
  frames: Array<Array<[string, Point[]]>>
) {
  const events: ClutchEvent[] = [];
  frames.forEach((hands, i) => {
    const input = hands.map(([label, landmarks]) => ({ label, landmarks }));
    events.push(...tracker.update(input, i * 33, ASPECT).events);
  });
  return events;
}

const R = (lm: Point[]): [string, Point[]] => ["Right", lm];
const L = (lm: Point[]): [string, Point[]] => ["Left", lm];

test("one hand that comes back with the other label resumes its clutch", () => {
  const tracker = new GestureTracker(); // maxHands 1
  const events = runLabeled(tracker, [
    ...Array.from({ length: ENGAGE }, () => [R(hand(0.5, 0.5, CLOSED))]),
    ...Array.from({ length: LONG_HOLD }, () => []),
    // Back somewhere else, now labelled Left, still pinched
    [L(hand(0.2, 0.3, CLOSED))],
    ...Array.from({ length: 5 }, (_, i) => [L(hand(0.19 - 0.01 * i, 0.3, CLOSED))]),
    // Let go
    [L(hand(0.14, 0.3, OPEN))],
    [L(hand(0.14, 0.3, OPEN))],
    // A new pinch belongs to the hand's current label
    ...Array.from({ length: ENGAGE }, () => [L(hand(0.14, 0.3, CLOSED))]),
  ]);
  assert.deepEqual(
    events.map((e) => [e.type, e.hand]),
    [
      ["start", "Right"],
      ...Array(5).fill(["move", "Right"]),
      ["end", "Right"],
      ["start", "Left"],
    ]
  );
  assert.deepEqual(tracker.engagedHands(), ["Left"]);
});

test("relabeled hand that comes back open releases the held clutch", () => {
  const tracker = new GestureTracker();
  const events = runLabeled(tracker, [
    ...Array.from({ length: ENGAGE }, () => [R(hand(0.5, 0.5, CLOSED))]),
    [],
    ...Array.from({ length: 5 }, () => [L(hand(0.3, 0.5, OPEN))]),
  ]);
  assert.deepEqual(
    events.map((e) => [e.type, e.hand]),
    [
      ["start", "Right"],
      ["end", "Right"],
    ]
  );
  assert.deepEqual(tracker.engagedHands(), []);
});

test("with two hands, a relabeled hand near the held clutch takes it over", () => {
  const tracker = new GestureTracker(undefined, 2);
  const events = runLabeled(tracker, [
    ...Array.from({ length: ENGAGE }, () => [R(hand(0.8, 0.5, CLOSED))]),
    ...Array.from({ length: LONG_HOLD }, () => []),
    [L(hand(0.75, 0.55, CLOSED))],
    [L(hand(0.74, 0.55, CLOSED))],
  ]);
  assert.deepEqual(
    events.map((e) => [e.type, e.hand]),
    [
      ["start", "Right"],
      ["move", "Right"],
    ]
  );
  assert.deepEqual(tracker.engagedHands(), ["Right"]);
});

test("with two hands, the other hand far away doesn't steal a held clutch", () => {
  const tracker = new GestureTracker(undefined, 2);
  const events = runLabeled(tracker, [
    ...Array.from({ length: ENGAGE }, () => [R(hand(0.8, 0.5, CLOSED))]),
    [],
    ...Array.from({ length: ENGAGE }, () => [L(hand(0.2, 0.5, CLOSED))]),
  ]);
  assert.deepEqual(
    events.map((e) => [e.type, e.hand]),
    [
      ["start", "Right"],
      ["start", "Left"],
    ]
  );
  assert.deepEqual(tracker.engagedHands(), ["Left", "Right"]);
});

test("a hand that's been in view all along doesn't take over a held clutch", () => {
  const tracker = new GestureTracker(undefined, 2);
  // Right pinches and goes off screen; Left stays in view, open, right next
  // to where Right left. Left is a different hand: Right's hold must survive.
  const events = runLabeled(tracker, [
    ...Array.from({ length: ENGAGE }, () => [R(hand(0.8, 0.5, CLOSED)), L(hand(0.7, 0.5, OPEN))]),
    ...Array.from({ length: 10 }, () => [L(hand(0.7, 0.5, OPEN))]),
    [R(hand(0.8, 0.5, CLOSED)), L(hand(0.7, 0.5, OPEN))],
    [R(hand(0.79, 0.5, CLOSED)), L(hand(0.7, 0.5, OPEN))],
  ]);
  assert.deepEqual(
    events.map((e) => [e.type, e.hand]),
    [
      ["start", "Right"],
      ["move", "Right"],
    ]
  );
  assert.deepEqual(tracker.engagedHands(), ["Right"]);
});

test("one hand relabeled while in view keeps its clutch", () => {
  const tracker = new GestureTracker(); // maxHands 1
  const events = runLabeled(tracker, [
    ...Array.from({ length: ENGAGE }, () => [R(hand(0.5, 0.5, CLOSED))]),
    [L(hand(0.49, 0.5, CLOSED))],
    [L(hand(0.48, 0.5, CLOSED))],
    [R(hand(0.47, 0.5, CLOSED))],
    [R(hand(0.46, 0.5, CLOSED))],
  ]);
  assert.ok(events.every((e) => e.hand === "Right"), JSON.stringify(events.map((e) => e.hand)));
  assert.equal(events.filter((e) => e.type === "start").length, 1);
  assert.equal(events.filter((e) => e.type === "end").length, 0);
});

test("a pinch with the other fingers curled doesn't engage", () => {
  const tracker = new GestureTracker();
  const lazy = () => hand(0.5, 0.5, CLOSED, 0, true);
  assert.deepEqual(run(tracker, Array.from({ length: 20 }, lazy)), []);
});

test("curling the other fingers after engaging keeps the clutch", () => {
  const tracker = new GestureTracker();
  const events = run(tracker, [
    ...Array.from({ length: ENGAGE }, () => hand(0.5, 0.5, CLOSED)),
    ...Array.from({ length: 5 }, (_, i) => hand(0.49 - 0.01 * i, 0.5, CLOSED, 0, true)),
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["start", ...Array(5).fill("move")]
  );
});

test("a pinch on a fast-moving hand doesn't engage until it slows", () => {
  const tracker = new GestureTracker();
  const events = run(tracker, [
    // 0.05 frame widths per 33ms frame: ~1.5 frame widths per second
    ...Array.from({ length: 10 }, (_, i) => hand(0.2 + 0.05 * i, 0.5, CLOSED)),
    ...Array.from({ length: ENGAGE + 3 }, () => hand(0.7, 0.5, CLOSED)),
  ]);
  assert.equal(events[0]?.type, "start");
  // Engages only once the hand has been still for the speed window and
  // then held for the engage time.
  assert.ok(events[0].t > 10 * 33, `engaged at ${events[0].t}ms, while moving`);
});

function replay(name: string) {
  return replayAll(name).events;
}

function replayAll(name: string) {
  const fixture = JSON.parse(
    readFileSync(`${import.meta.dirname}/fixtures/${name}`, "utf8")
  );
  const tracker = new GestureTracker(undefined, 2);
  const aspect = fixture.height / fixture.width;
  const events: ClutchEvent[] = [];
  const claps: ClapEvent[] = [];
  /** Every single clap: first claps, and the second of each double clap. */
  const singleClaps: ClapEvent[] = [];
  const reels: ReelEvent[] = [];
  for (const frame of fixture.frames) {
    const hands = frame.hands.map(
      (h: { label: string; landmarks: number[][] }) => ({
        label: h.label,
        landmarks: h.landmarks.map(([x, y, z]) => ({ x, y, z })),
      })
    );
    const result = tracker.update(hands, frame.t, aspect);
    events.push(...result.events);
    claps.push(...result.claps);
    singleClaps.push(...result.firstClaps, ...result.claps);
    reels.push(...result.reels);
  }
  return { events, claps, singleClaps, reels };
}

test("recorded: dropping a relaxed hand never engages", () => {
  const starts = replay("hand-drops.json").filter((e) => e.type === "start");
  assert.deepEqual(starts.map((e) => `${e.hand}@${e.t}`), []);
});

test("recorded: every deliberate OK sign engages", () => {
  const events = replay("ok-signs.json");
  const starts = events.filter((e) => e.type === "start");
  assert.equal(starts.length, 7, starts.map((e) => `${e.hand}@${e.t}`).join(", "));
});

/**
 * Synthetic fist: the `hand()` skeleton with all four fingers curled, the
 * index one finger's width beside the middle.
 */
function fist(cx: number, cy: number): Point[] {
  const lm = hand(cx, cy, 0.02, 0, true);
  const dx = lm[9].x - lm[13].x;
  const dy = lm[9].y - lm[13].y;
  for (const k of [5, 6, 7, 8]) {
    lm[k] = { x: lm[k + 4].x + dx, y: lm[k + 4].y + dy, z: 0 };
  }
  return lm;
}

/** Frames needed to engage a fist: held for 150ms (frames are 33ms). */
const FIST_ENGAGE = 6;

test("fist engages, moves with the knuckles, releases when the hand opens", () => {
  const tracker = new GestureTracker();
  const frames = [
    ...Array.from({ length: FIST_ENGAGE }, () => fist(0.5, 0.5)),
    ...Array.from({ length: 20 }, (_, i) => fist(0.5 + 0.01 * (i + 1), 0.5)),
    // Releasing a fist takes 3 open frames
    hand(0.7, 0.5, OPEN),
    hand(0.7, 0.5, OPEN),
    hand(0.7, 0.5, OPEN),
  ];
  const events = run(tracker, frames);
  assert.deepEqual(
    events.filter((e) => e.type !== "move").map((e) => `${e.type}:${e.gesture}`),
    ["start:fist", "end:fist"]
  );
  const moves = events.filter((e) => e.type === "move");
  assert.ok(moves.every((e) => e.gesture === "fist"));
  // Raw x increases to the right of the image, which is the user's left.
  const dx = moves.reduce((sum, e) => sum + e.dx, 0);
  assert.ok(dx < -0.1, `dx ${dx}`);
  // The fist point is the middle of the knuckles.
  const start = events[0];
  const lm = fist(0.5, 0.5);
  const knuckles = [5, 9, 13, 17].reduce((sum, i) => sum + lm[i].x, 0) / 4;
  assert.ok(Math.abs(start.x - (1 - knuckles)) < 1e-6);
});

test("fist doesn't engage until held for 150ms", () => {
  const tracker = new GestureTracker();
  const frames = [
    ...Array.from({ length: FIST_ENGAGE - 1 }, () => fist(0.5, 0.5)),
    hand(0.5, 0.5, OPEN),
  ];
  assert.deepEqual(run(tracker, frames), []);
});

test("a fist with its fingers at the edge goes on hold; the wrist off the edge doesn't", () => {
  const tracker = new GestureTracker();
  // Knuckles at y=0.85: the wrist (0.2 frame widths lower) is off the
  // bottom, but the fingers are in view.
  const low = fist(0.5, 0.5);
  const shift = (lm: Point[], dy: number) => lm.map((p) => ({ ...p, y: p.y + dy }));
  const events = run(tracker, [
    ...Array.from({ length: FIST_ENGAGE }, () => low),
    shift(low, 0.35),
    shift(low, 0.36),
  ]);
  assert.deepEqual(events.map((e) => e.type), ["start", "move", "move"]);
  const { visuals } = tracker.update(
    [{ label: "Right", landmarks: shift(low, 0.5) }],
    1000,
    ASPECT
  );
  assert.equal(visuals[0].state, "suspended");
  assert.equal(visuals[0].gesture, "fist");
});

test("an engaged pinch stays a pinch when the hand curls into a fist", () => {
  const tracker = new GestureTracker();
  const events = run(tracker, [
    ...Array.from({ length: ENGAGE }, () => hand(0.5, 0.5, CLOSED)),
    ...Array.from({ length: 10 }, () => fist(0.5, 0.5)),
  ]);
  assert.deepEqual(
    [...new Set(events.map((e) => `${e.type === "start" ? "start" : "other"}:${e.gesture}`))],
    ["start:pinch", "other:pinch"]
  );
});

test("a smaller hand mostly on top of a bigger one is dropped as a ghost", () => {
  const real = { label: "Right", landmarks: hand(0.5, 0.5, OPEN) };
  const shrink = (lm: Point[], k: number) =>
    lm.map((p) => ({ x: 0.5 + (p.x - 0.5) * k, y: 0.5 + (p.y - 0.5) * k, z: p.z }));
  const ghost = { label: "Right", landmarks: shrink(real.landmarks, 0.5) };
  // The ghost is listed first, as MediaPipe sometimes does.
  assert.deepEqual(dropGhostHands([ghost, real]), [real]);
  const other = { label: "Left", landmarks: hand(0.15, 0.5, OPEN) };
  assert.deepEqual(dropGhostHands([real, other]), [real, other]);
});

test("recorded: fists from every angle engage as fists, and nothing gets stuck", () => {
  const events = replay("fists.json");
  const starts = events.filter((e) => e.type === "start");
  const desc = starts.map((e) => `${e.gesture}:${e.hand}@${e.t}`).join(", ");
  assert.ok(starts.every((e) => e.gesture === "fist" && e.hand === "Right"), desc);
  // One start within each of the three fists (MediaPipe loses the side-on
  // fist for half a second, so that one may release and re-engage).
  for (const [from, to] of [[1500, 3000], [16000, 18000], [29000, 31000]]) {
    assert.ok(starts.some((e) => e.t >= from && e.t <= to), `${from}-${to}: ${desc}`);
  }
  // Every clutch released when the hand opened: none left engaged by a ghost.
  const open = new Map<string, number>();
  for (const e of events) {
    if (e.type === "start") open.set(e.hand, (open.get(e.hand) ?? 0) + 1);
    if (e.type === "end") open.set(e.hand, (open.get(e.hand) ?? 0) - 1);
  }
  assert.ok([...open.values()].every((n) => n === 0), desc);
});

test("recorded: relaxed hands, dropping hands and finger guns don't engage a fist", () => {
  const starts = replay("not-fists.json").filter((e) => e.type === "start");
  const desc = starts.map((e) => `${e.gesture}:${e.hand}@${e.t}`).join(", ");
  assert.ok(starts.every((e) => e.gesture !== "fist"), desc);
  // The two-hand pinches engage as pinches, the finger guns as guns.
  assert.deepEqual(
    starts.filter((e) => e.gesture === "pinch").map((e) => e.hand).sort(),
    ["Left", "Right"],
    desc
  );
  assert.ok(starts.some((e) => e.gesture === "gun" && e.t > 30600), desc);
});

test("recorded: OK signs and dropping hands never engage a fist", () => {
  for (const name of ["ok-signs.json", "hand-drops.json"]) {
    assert.ok(replay(name).every((e) => e.gesture === "pinch"), name);
  }
});

test("a brief dropout mid-move keeps the movement made meanwhile", () => {
  for (const gesture of ["pinch", "fist"] as const) {
    const pose = (x: number) => (gesture === "fist" ? fist(x, 0.5) : hand(x, 0.5, CLOSED));
    const tracker = new GestureTracker();
    const events = run(tracker, [
      ...Array.from({ length: gesture === "fist" ? FIST_ENGAGE : ENGAGE }, () => pose(0.5)),
      pose(0.52),
      null, // lost for one frame while moving
      pose(0.6),
      pose(0.62),
    ]);
    assert.deepEqual(events.map((e) => e.type), ["start", "move", "move", "move"], gesture);
    // Every raw-x step counts, including the one across the gap: 0.5 -> 0.62
    // is 0.12 toward the user's left. Smoothing lags a little at the end.
    const dx = events.reduce((sum, e) => sum + e.dx, 0);
    assert.ok(dx < -0.1 && dx > -0.12 - 1e-9, `${gesture}: dx=${dx}`);
  }
});

test("after a long hold, a clutch resumes from where the hand is, without a jump", () => {
  const tracker = new GestureTracker();
  const events = run(tracker, [
    ...Array.from({ length: FIST_ENGAGE }, () => fist(0.5, 0.5)),
    ...Array.from({ length: LONG_HOLD }, () => null),
    fist(0.3, 0.5),
    fist(0.29, 0.5),
  ]);
  assert.deepEqual(events.map((e) => e.type), ["start", "move"]);
  // 0.3 -> 0.29 is a small step right; the 0.2 jump while gone doesn't count.
  assert.ok(events[1].dx > 0 && events[1].dx < 0.011, `dx=${events[1].dx}`);
});

test("a fist that looks open for a single frame keeps moving", () => {
  // Motion blur on a fast fist can make the fingers look open for a frame.
  // The fist's point (the knuckles) doesn't move as fingers open, so that
  // frame's movement still counts (a pinch would freeze it instead).
  const tracker = new GestureTracker();
  const frames = [
    ...Array.from({ length: FIST_ENGAGE }, () => fist(0.5, 0.5)),
    fist(0.52, 0.5),
    hand(0.54, 0.5, OPEN),
    fist(0.56, 0.5),
  ];
  // Put the open hand's knuckles where a fist at 0.54 would have them.
  const k = (lm: Point[]) => [5, 9, 13, 17].reduce((s, i) => s + lm[i].x, 0) / 4;
  const shift = k(fist(0.54, 0.5)) - k(frames[FIST_ENGAGE + 1]);
  frames[FIST_ENGAGE + 1] = frames[FIST_ENGAGE + 1].map((p) => ({ ...p, x: p.x + shift }));
  const events = run(tracker, frames);
  assert.deepEqual(events.map((e) => e.type), ["start", "move", "move", "move"]);
});

test("recorded: fast fist shakes don't drift", () => {
  const fixture = JSON.parse(
    readFileSync(`${import.meta.dirname}/fixtures/fist-shakes.json`, "utf8")
  );
  const tracker = new GestureTracker(undefined, 2);
  const aspect = fixture.height / fixture.width;
  const knuckles = (lm: number[][]) => 1 - [5, 9, 13, 17].reduce((s, i) => s + lm[i][0], 0) / 4;
  let start: number | undefined;
  let last = 0;
  let sum = 0;
  const errors: string[] = [];
  let fists = 0;
  for (const frame of fixture.frames) {
    const hands = frame.hands.map((h: { label: string; landmarks: number[][] }) => ({
      label: h.label,
      landmarks: h.landmarks.map(([x, y, z]) => ({ x, y, z })),
    }));
    const { events, visuals } = tracker.update(hands, frame.t, aspect);
    const right = frame.hands.find((h: { label: string }) => h.label === "Right");
    const engaged = visuals.some((v) => v.hand === "Right" && v.state !== "idle" && v.state !== "suspended");
    for (const e of events.filter((e) => e.hand === "Right" && e.gesture === "fist")) {
      if (e.type === "start") {
        start = knuckles(right.landmarks);
        last = start;
        sum = 0;
        fists += 1;
      } else if (e.type === "move") {
        sum += e.dx;
      } else if (start !== undefined) {
        // Compare with the knuckles' last position while engaged.
        if (Math.abs(sum - (last - start)) > 0.1) {
          errors.push(`fist at ${e.t}ms: moved ${(last - start).toFixed(3)}, events say ${sum.toFixed(3)}`);
        }
        start = undefined;
      }
    }
    if (start !== undefined && right && engaged) last = knuckles(right.landmarks);
  }
  assert.ok(fists >= 3, `only ${fists} fists`);
  assert.deepEqual(errors, []);
});

test("recorded: a fist pointed at the camera stays a fist", () => {
  // Fingers pointing down, then a fist turned through several orientations
  // (including straight at the camera) from 3.3 to 18.9 s, then fingers
  // pointing down again. The fist must engage once and hold throughout.
  const events = replay("punch.json").filter((e) => e.type !== "move");
  assert.equal(events[0]?.type, "start");
  assert.ok(events[0].t < 4000, `started at ${events[0].t}`);
  assert.equal(events[0].gesture, "fist");
  const ends = events.filter((e) => e.type === "end");
  assert.ok(ends.length === 0 || ends[0].t > 18900, events.map((e) => `${e.type}@${e.t}`).join(", "));
  assert.equal(events.filter((e) => e.type === "start").length, 1);
});

test("recorded: a fist with its fingers curled toward the camera isn't a pinch", () => {
  const starts = replay("fists-facing-camera.json").filter((e) => e.type === "start");
  assert.ok(
    starts.every((e) => e.gesture !== "pinch"),
    starts.map((e) => `${e.gesture}@${e.t}`).join(", ")
  );
});

test("recorded: a finger gun engages, holds while aimed anywhere, and isn't a pointing hand", () => {
  const starts = replay("finger-gun.json")
    .filter((e) => e.type === "start")
    .map((e) => `${e.gesture}@${(e.t / 1000).toFixed(1)}`);
  // Gun, held through all the aiming (toward the camera included) until the
  // fist; gun again; the OK sign. Pointing with the thumb tucked in (36.6-40.3
  // s) engages nothing.
  assert.deepEqual(
    starts.map((s) => s.split("@")[0]),
    ["gun", "fist", "gun", "pinch"],
    starts.join(", ")
  );
  const [gun1, fist, gun2] = starts.map((s) => Number(s.split("@")[1]));
  assert.ok(gun1 < 3 && fist > 27 && fist < 28.5 && gun2 > 29 && gun2 < 30, starts.join(", "));
});

/** Rotation matrix (row-major) from a rotation vector. */
function fromRotationVector(w: number[]): number[] {
  const t = Math.hypot(...w);
  if (t < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [x, y, z] = w.map((c) => c / t);
  const c = Math.cos(t), s = Math.sin(t), C = 1 - c;
  return [
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
  ];
}

function multiply(a: number[], b: number[]): number[] {
  return [0, 1, 2].flatMap((r) =>
    [0, 1, 2].map((c) => a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c])
  );
}

test("rotationVector inverts fromRotationVector", () => {
  for (const w of [[0.3, -0.2, 0.5], [0, 0, 1e-4], [2.5, 0.1, -0.4]]) {
    const back = rotationVector(fromRotationVector(w));
    back.forEach((c, i) => assert.ok(Math.abs(c - w[i]) < 1e-9, `${back} vs ${w}`));
  }
});

test("recorded: a finger gun's rotation follows the hand", () => {
  // Composing every drotation should reproduce how the hand turned, from
  // the user's point of view (x right, y down, z toward the screen). From
  // pointing up (4 s) to pointing left (6 s) is a quarter turn
  // counterclockwise on screen: about -z. From pointing up to pointing down
  // (12.5 s), the barrel swings forward, past the screen: about -x.
  let rotation = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const at: Record<string, number[]> = {};
  const fixture = JSON.parse(
    readFileSync(`${import.meta.dirname}/fixtures/finger-gun.json`, "utf8")
  );
  const tracker = new GestureTracker(undefined, 2);
  for (const frame of fixture.frames) {
    const hands = frame.hands.map((h: { label: string; landmarks: number[][] }) => ({
      label: h.label,
      landmarks: h.landmarks.map(([x, y, z]) => ({ x, y, z })),
    }));
    for (const e of tracker.update(hands, frame.t, fixture.height / fixture.width).events) {
      if (e.gesture === "gun" && e.type === "move") {
        rotation = multiply(fromRotationVector(e.drotation), rotation);
      }
    }
    if (frame.t >= 4000 && !at.up) at.up = rotation;
    if (frame.t >= 6000 && !at.left) at.left = rotation;
    if (frame.t >= 12500 && !at.down) at.down = rotation;
  }
  const upT = [0, 3, 6, 1, 4, 7, 2, 5, 8].map((i) => at.up[i]);
  const w = rotationVector(multiply(at.left, upT));
  const degrees = (Math.hypot(...w) * 180) / Math.PI;
  assert.ok(degrees > 70 && degrees < 100, `turned ${degrees.toFixed(0)} degrees`);
  assert.ok(w[2] / Math.hypot(...w) < -0.9, `axis ${w.map((c) => c.toFixed(2))}`);
  const tilt = rotationVector(multiply(at.down, upT));
  assert.ok(tilt[0] / Math.hypot(...tilt) < -0.9, `axis ${tilt.map((c) => c.toFixed(2))}`);
});

test("recorded: fast twists don't release a finger gun, and it comes back home", () => {
  // Motion blur made the index look curled for 20-40 ms at a time while
  // the hand turned fast; released then, the next gun started from a turned
  // pose and the view never came back.
  const events = replay("gun-twists.json");
  assert.deepEqual(
    events.filter((e) => e.type !== "move").map((e) => `${e.type}@${Math.round(e.t / 100) / 10}`),
    ["start@1.6", "end@26.8"]
  );
  // Back at the starting orientation between turns, the total turn is back
  // near zero (it's the hand's pose, measured: a few degrees off).
  let rotation = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const pauses = [5.2, 8.2, 12.0, 17.4, 25.0];
  const turnAt: number[] = [];
  for (const e of events) {
    if (e.type === "move") rotation = multiply(fromRotationVector(e.drotation), rotation);
    if (turnAt.length < pauses.length && e.t >= pauses[turnAt.length] * 1000) {
      turnAt.push((Math.hypot(...rotationVector(rotation)) * 180) / Math.PI);
    }
  }
  assert.ok(turnAt.every((d) => d < 12), `turned ${turnAt.map((d) => d.toFixed(0))} degrees`);
});

test("a finger gun's rotation holds while it releases", () => {
  // Curling the index to release swings the hand's orientation; no moves
  // in the gunReleaseMs before a gun ends.
  const events = replay("finger-gun.json");
  const ends = events.filter((e) => e.gesture === "gun" && e.type === "end");
  assert.equal(ends.length, 2);
  for (const end of ends) {
    const late = events.filter(
      (e) => e.type === "move" && e.t < end.t && e.t > end.t - defaultClutchOptions.gunReleaseMs
    );
    assert.deepEqual(late, [], `moves just before the end at ${end.t}`);
  }
});

test("pinch events carry no rotation, fist events do", () => {
  const pinches = replay("ok-signs.json").filter((e) => e.gesture === "pinch");
  assert.ok(pinches.length > 0);
  assert.ok(pinches.every((e) => e.drotation.every((c) => c === 0)));
  // Holding a fist knuckles toward the camera (2-9.5 s; see the fixture's
  // description), its orientation (from the palm and knuckles, since the
  // index is curled) barely moves from frame to frame.
  const fistMoves = replay("fists.json").filter(
    (e) => e.gesture === "fist" && e.type === "move" && e.t < 9500
  );
  const degrees = fistMoves.map((e) => (Math.hypot(...e.drotation) * 180) / Math.PI);
  assert.ok(degrees.some((d) => d > 0));
  assert.ok(Math.max(...degrees) < 5, `turned up to ${Math.max(...degrees).toFixed(1)} degrees`);
});

/**
 * Single claps seen by a two-hand tracker (whether or not they make a
 * double clap), for frames of (unlabelled) hands 33ms apart.
 */
function runClaps(frames: Point[][][], tracker = new GestureTracker(undefined, 2)) {
  return runDoubleClaps(frames, tracker).singleClaps;
}

function runDoubleClaps(frames: Point[][][], tracker = new GestureTracker(undefined, 2)) {
  const claps: ClapEvent[] = [];
  const singleClaps: ClapEvent[] = [];
  frames.forEach((hands, i) => {
    const labelled = hands.map((landmarks, k) => ({ label: k ? "Left" : "Right", landmarks }));
    const result = tracker.update(labelled, i * 33, ASPECT);
    claps.push(...result.claps);
    singleClaps.push(...result.firstClaps, ...result.claps);
  });
  return { claps, singleClaps };
}

/** Two open hands `span` frame widths apart, centered at x = 0.5. */
const apart = (span: number) => [hand(0.5 - span / 2, 0.6, OPEN), hand(0.5 + span / 2, 0.6, OPEN)];

test("two hands coming together quickly into one is a clap", () => {
  // Hand size (wrist to middle knuckle) is 0.2 frame widths.
  const claps = runClaps([apart(0.8), apart(0.6), apart(0.3), [hand(0.5, 0.6, OPEN)]]);
  assert.equal(claps.length, 1);
  assert.ok(Math.abs(claps[0].x - 0.5) < 0.05, `x = ${claps[0].x}`);
  // Hands stay clasped: still one clap.
  assert.equal(
    runClaps([apart(0.8), apart(0.3), ...Array(10).fill([hand(0.5, 0.6, OPEN)])]).length,
    1
  );
});

test("hands that were already close when they merged aren't a clap", () => {
  // 1.5 hand sizes apart, closing slowly
  assert.deepEqual(runClaps([apart(0.3), apart(0.28), apart(0.26), [hand(0.5, 0.6, OPEN)]]), []);
});

test("hands that were far apart a while before merging aren't a clap", () => {
  const slow = [apart(0.8), ...Array(10).fill(apart(0.3)), [hand(0.5, 0.6, OPEN)]];
  assert.deepEqual(runClaps(slow), []);
});

test("malformed hands from MediaPipe are skipped, not fatal", () => {
  // A hand short of landmarks (or with a hole) once threw while measuring
  // a clap, which froze the widget's camera loop.
  const tracker = new GestureTracker(undefined, 2);
  const [left, right] = apart(0.8);
  const short = right.slice(0, 10);
  const holey = right.map((p, i) => (i === 9 ? undefined : p)) as Point[];
  const nan = right.map((p, i) => (i === 0 ? { ...p, x: NaN } : p));
  for (const bad of [short, holey, nan, [] as Point[]]) {
    const result = tracker.update(
      [
        { label: "Left", landmarks: left },
        { label: "Right", landmarks: bad },
      ],
      0,
      ASPECT
    );
    assert.deepEqual(result.visuals.map((v) => v.hand), ["Left"]);
  }
});

test("one hand leaving the frame isn't a clap", () => {
  const [left] = apart(0.8);
  assert.deepEqual(runClaps([apart(0.8), apart(0.8), [left], [left]]), []);
});

test("a sliver of hand left between where two were isn't a clap", () => {
  // Both hands dropping out of frame: one goes first, and what's left of
  // the other is much smaller than a hand.
  const sliver = hand(0.5, 0.6, OPEN).map((p) => ({ x: 0.5 + (p.x - 0.5) * 0.25, y: 0.6 + (p.y - 0.6) * 0.25, z: p.z }));
  assert.deepEqual(runClaps([apart(0.8), apart(0.6), [sliver]]), []);
});

/** One clap: hands apart, then together for `heldFrames`, then apart again (33 ms frames). */
const clap = (heldFrames = 3) => [apart(0.8), apart(0.4), ...Array(heldFrames).fill([hand(0.5, 0.6, OPEN)])];

test("two claps with a brief pause between are a double clap", () => {
  // Second clap 6 frames (200 ms, too soon), 18 frames (600 ms) or 45
  // frames (1.5 s, too late) after the first.
  const twice = (gapFrames: number) => [...clap(gapFrames - 2), ...clap()];
  assert.deepEqual(runDoubleClaps(twice(18)).claps.map((c) => c.t), [20 * 33]);
  assert.deepEqual(runDoubleClaps(twice(6)).claps, []);
  assert.deepEqual(runDoubleClaps(twice(45)).claps, []);
  // A single clap does nothing; three quick ones (330 ms apart) are one
  // double clap, then the start of another.
  assert.deepEqual(runDoubleClaps(clap()).claps, []);
  assert.equal(runDoubleClaps([...clap(8), ...clap(8), ...clap()]).claps.length, 1);
});

test("recorded: double claps count, single claps don't", () => {
  const { claps, singleClaps } = replayAll("double-claps.json");
  // Seven double claps in the first 19.5 s; see the fixture's description.
  assert.equal(claps.length, 7, claps.map((c) => c.t).join());
  assert.ok(claps.every((c) => c.t < 19500));
  // Every clap was seen, including the four single ones.
  assert.equal(singleClaps.length, 18);
});

test("recorded: hands dropping out of frame after a clap aren't a second clap", () => {
  // After releasing the gun the user clapped (26.9 s), then dropped both
  // hands out of view; what was left of one drifted between where the two
  // had been, 450 ms later.
  const { claps, singleClaps } = replayAll("gun-twists.json");
  assert.deepEqual(claps, []);
  assert.deepEqual(singleClaps.map((c) => Math.round(c.t / 100) / 10), [0.2, 26.9]);
});

test("recorded: claps count once each, and pressing palms together slowly doesn't", () => {
  const { events, claps: doubles, singleClaps: claps } = replayAll("claps.json");
  // The claps are in the first 14.1 s; see the fixture's description. They're
  // too far apart (1.7 s or more) to make double claps.
  assert.deepEqual(doubles, []);
  assert.equal(claps.length, 8);
  assert.ok(claps.every((c) => c.t < 14100), claps.map((c) => c.t).join());
  assert.ok(claps.every((c) => c.x > 0.4 && c.x < 0.65));
  // Nothing engages during the claps.
  assert.deepEqual(events.filter((e) => e.t < 14100), []);
});

test("recorded: no claps in two-handed use or when one hand leaves", () => {
  for (const name of [
    "finger-gun.json",
    "fist-shakes.json",
    "fists-facing-camera.json",
    "fists.json",
    "hand-drops.json",
    "not-fists.json",
    "ok-signs.json",
    "punch.json",
  ]) {
    assert.deepEqual(replayAll(name).singleClaps, [], name);
  }
});

/**
 * Synthetic double-barrelled finger gun: palm centered near (cx, cy), the
 * barrel pointing along `dir` (+1: toward larger x in raw image
 * coordinates). Each finger is extended along the barrel or curled back to
 * its knuckle, as given by `fingers` (index, middle, ring, pinky). The
 * barrel points along `up` instead when that's given, as a unit vector.
 */
function doubleGun(
  cx: number,
  cy: number,
  dir: number,
  fingers = [true, true, false, false],
  up?: { x: number; y: number }
): Point[] {
  // Isotropic frame-width units with y down, then converted.
  const along = up ?? { x: dir, y: 0 };
  const across = { x: -along.y, y: along.x };
  const c = { x: cx, y: cy * ASPECT };
  const at = (a: number, b: number): Point => ({
    x: c.x + along.x * a + across.x * b,
    y: (c.y + along.y * a + across.y * b) / ASPECT,
    z: 0,
  });
  const lm: Point[] = Array.from({ length: 21 }, () => at(0, 0));
  lm[0] = at(-0.08, 0); // wrist, 0.1 behind the knuckles
  for (const k of [1, 2, 3, 4]) lm[k] = at(-0.06 + 0.02 * k, -0.04 - 0.01 * k); // thumb
  [5, 9, 13, 17].forEach((mcp, f) => {
    const side = -0.03 + 0.02 * f;
    lm[mcp] = at(0.02, side);
    for (const j of [1, 2, 3]) {
      lm[mcp + j] = fingers[f] ? at(0.02 + 0.027 * j, side) : at(0.02 - 0.01 * j, side);
    }
  });
  return lm;
}

/** Frames (33ms apart) of `turns` turns of the right hand around (0.3, 0.5), forward if positive. */
function reeling(
  turns: number,
  opts: { left?: (i: number) => Point[]; right?: (x: number, y: number) => Point[]; start?: number } = {}
): Point[][][] {
  const frames: Point[][][] = [];
  const n = Math.round(Math.abs(turns) * 30); // one turn a second
  const left = opts.left ?? (() => doubleGun(0.7, 0.5, -1));
  const right = opts.right ?? ((x: number, y: number) => doubleGun(x, y, 1));
  for (let i = 0; i <= n; i++) {
    // Forward is clockwise in the mirrored preview: decreasing angle in raw
    // image coordinates (y down).
    const a = (opts.start ?? 0) - Math.sign(turns) * (2 * Math.PI * i) / 30;
    frames.push([right(0.3 + 0.06 * Math.cos(a), 0.5 + (0.06 * Math.sin(a)) / ASPECT), left(i)]);
  }
  return frames;
}

/** Hold still for `ms`: repeats the last frame. */
const hold = (frames: Point[][][], ms: number) =>
  Array.from({ length: Math.round(ms / 33) }, () => frames[frames.length - 1]);

function runReels(frames: Point[][][]) {
  const tracker = new GestureTracker(undefined, 2);
  const reels: ReelEvent[] = [];
  frames.forEach((hands, i) => {
    const labelled = hands.map((landmarks, k) => ({ label: k ? "Left" : "Right", landmarks }));
    reels.push(...tracker.update(labelled, i * 33, ASPECT).reels);
  });
  return reels.map((e) => e.direction);
}

test("each turn of reeling is one step, forward or backward", () => {
  assert.deepEqual(runReels(reeling(2.2)), [1, 1]);
  assert.deepEqual(runReels(reeling(-1)), [-1]);
  // The first step comes most of the way around the first turn.
  assert.deepEqual(runReels(reeling(0.5)), []);
});

test("stopping partway through a turn starts the count over", () => {
  const first = reeling(0.5);
  const again = reeling(0.5, { start: -Math.PI });
  assert.deepEqual(runReels([...first, ...hold(first, 500), ...again]), []);
  // Without the pause, that's most of a turn.
  assert.deepEqual(runReels(reeling(1)), [1]);
});

test("hands dropping out partway through a turn start the count over", () => {
  const first = reeling(0.5);
  // Back from the other side of the circle, so the hand hasn't just stopped.
  const again = reeling(0.5);
  const gone = Array.from({ length: 15 }, () => [first[first.length - 1][1]]);
  assert.deepEqual(runReels([...first, ...gone, ...again]), []);
});

test("wobbling back just past a step doesn't step back", () => {
  // 0.75 turns forward steps once; 0.6 back doesn't undo it.
  const forward = reeling(0.75);
  const back = reeling(-0.6, { start: -2 * Math.PI * 0.75 });
  assert.deepEqual(runReels([...forward, ...back]), [1]);
});

test("jiggling back and forth isn't reeling", () => {
  const frames: Point[][][] = [];
  for (let i = 0; i < 90; i++) {
    const y = 0.5 + 0.08 * Math.sin((2 * Math.PI * i) / 10);
    frames.push([doubleGun(0.3, y, 1), doubleGun(0.7, 0.5, -1)]);
  }
  assert.deepEqual(runReels(frames), []);
});

test("reeling needs the left hand still", () => {
  const swinging = (i: number) => doubleGun(0.7, 0.5 + 0.1 * Math.sin(i / 2), -1);
  assert.deepEqual(runReels(reeling(2.2, { left: swinging })), []);
});

test("reeling needs both hands as double guns, pointed at each other", () => {
  const variants: Array<[string, (x: number, y: number) => Point[]]> = [
    ["index curled", (x, y) => doubleGun(x, y, 1, [false, true, false, false])],
    ["middle curled (a finger gun)", (x, y) => doubleGun(x, y, 1, [true, false, false, false])],
    ["ring out", (x, y) => doubleGun(x, y, 1, [true, true, true, false])],
    ["pinky out", (x, y) => doubleGun(x, y, 1, [true, true, false, true])],
    ["pointing up", (x, y) => doubleGun(x, y, 1, undefined, { x: 0, y: -1 })],
  ];
  for (const [name, right] of variants) {
    assert.deepEqual(runReels(reeling(2.2, { right })), [], name);
  }
  // One hand on its own
  assert.deepEqual(runReels(reeling(2.2).map(([right]) => [right])), []);
});

test("recorded: each turn of reeling is one step, and near misses aren't", () => {
  const { events, reels } = replayAll("reels.json");
  // Segments (seconds) and the turns made in each; see the fixture's description.
  const segments: Array<[number, number, number | undefined]> = [
    [2.1, 3.7, 1],
    [4.4, 6.9, 2],
    [7.5, 11.1, 3],
    [11.9, 18.1, undefined], // forward variations: about 10 turns
    [21.5, 23.4, -1],
    [23.8, 26.2, -2],
    [26.6, 29.7, -3],
    [30.1, 36.1, undefined], // backward variations: about 5 turns
    [41.7, 63.4, 0], // held still, a single finger gun, one hand circling
  ];
  for (const [from, to, turns] of segments) {
    const steps = reels.filter((e) => e.t >= from * 1000 && e.t <= to * 1000);
    if (turns === undefined) {
      assert.ok(steps.length >= 5, `${from}-${to}: ${steps.length} steps`);
      assert.ok(steps.every((e) => e.direction === steps[0].direction));
    } else {
      assert.deepEqual(
        steps.map((e) => e.direction),
        Array(Math.abs(turns)).fill(Math.sign(turns)),
        `${from}-${to} s`
      );
    }
  }
  // Forward variations are forward, backward ones backward.
  assert.ok(reels.filter((e) => e.t > 11900 && e.t < 18100).every((e) => e.direction === 1));
  assert.ok(reels.filter((e) => e.t > 30100 && e.t < 36100).every((e) => e.direction === -1));
  // No clutch engages while reeling.
  assert.deepEqual(events.filter((e) => e.t < 36100), []);
});

test("recorded: no reeling in other gestures", () => {
  for (const name of [
    "claps.json",
    "finger-gun.json",
    "fist-shakes.json",
    "fists-facing-camera.json",
    "fists.json",
    "hand-drops.json",
    "not-fists.json",
    "ok-signs.json",
    "punch.json",
  ]) {
    assert.deepEqual(replayAll(name).reels, [], name);
  }
});

/** The claws in claws.json (seconds); see the fixture's description. */
const CLAWS: Array<[number, number]> = [
  [0.9, 4.8],
  [6.5, 10.7],
  [12.0, 15.7],
];

test("recorded: each doorknob claw engages once as a claw, and turns with the hand", () => {
  const events = replay("claws.json");
  const starts = events.filter((e) => e.type === "start");
  const desc = starts.map((e) => `${e.gesture}@${e.t}`).join(", ");
  assert.deepEqual(
    starts.map((e) => e.gesture),
    ["claw", "claw", "claw", "fist"],
    desc
  );
  CLAWS.forEach(([from, to], i) => {
    const claw = events.filter((e) => e.t >= from * 1000 && e.t <= to * 1000);
    assert.equal(claw[0].type, "start", `claw ${i + 1}`);
    assert.equal(claw.at(-1)!.type, "end", `claw ${i + 1}`);
    assert.ok(claw.every((e) => e.gesture === "claw"), `claw ${i + 1}`);
    // Each was twisted about 50 degrees each way and back.
    let turn = 0;
    let min = 0;
    let max = 0;
    for (const e of claw) {
      turn += e.dtheta;
      min = Math.min(min, turn);
      max = Math.max(max, turn);
    }
    const deg = (r: number) => (r * 180) / Math.PI;
    assert.ok(deg(min) < -40 && deg(max) > 40, `claw ${i + 1}: ${deg(min)}..${deg(max)} degrees`);
  });
});

test("recorded: nothing else is a claw (relaxed or dropping hands, guns, fists, claps)", () => {
  for (const name of [
    "claps.json",
    "double-claps.json",
    "finger-gun.json",
    "fist-shakes.json",
    "fists-facing-camera.json",
    "fists.json",
    "gun-twists.json",
    "hand-drops.json",
    "not-fists.json",
    "ok-signs.json",
    "punch.json",
    "reels.json",
  ]) {
    const claws = replay(name).filter((e) => e.gesture === "claw" && e.type === "start");
    assert.deepEqual(claws.map((e) => `${e.hand}@${e.t}`), [], name);
  }
});

test("recorded: closing a claw straight into a fist releases the claw", () => {
  // The third claw, then (skipping the open hand between) the fist.
  const fixture = JSON.parse(
    readFileSync(`${import.meta.dirname}/fixtures/claws.json`, "utf8")
  );
  const claw = fixture.frames.filter((f: { t: number }) => f.t >= 12000 && f.t <= 15400);
  const fist = fixture.frames.filter((f: { t: number }) => f.t >= 16900 && f.t <= 20600);
  const shift = claw.at(-1).t + 33 - fist[0].t;
  const tracker = new GestureTracker(undefined, 2);
  const events: ClutchEvent[] = [];
  for (const frame of [...claw, ...fist.map((f: { t: number }) => ({ ...f, t: f.t + shift }))]) {
    const hands = frame.hands.map((h: { label: string; landmarks: number[][] }) => ({
      label: h.label,
      landmarks: h.landmarks.map(([x, y, z]) => ({ x, y, z })),
    }));
    events.push(...tracker.update(hands, frame.t, fixture.height / fixture.width).events);
  }
  assert.deepEqual(
    events.filter((e) => e.type !== "move").map((e) => `${e.gesture} ${e.type}`),
    ["claw start", "claw end", "fist start"]
  );
});
