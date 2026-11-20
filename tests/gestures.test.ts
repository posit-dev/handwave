// Run with: npm test (Node 22.18+ runs TypeScript directly)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  dropGhostHands,
  GestureTracker,
  type ClutchEvent,
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
  const fixture = JSON.parse(
    readFileSync(`${import.meta.dirname}/fixtures/${name}`, "utf8")
  );
  const tracker = new GestureTracker(undefined, 2);
  const aspect = fixture.height / fixture.width;
  const events: ClutchEvent[] = [];
  for (const frame of fixture.frames) {
    const hands = frame.hands.map(
      (h: { label: string; landmarks: number[][] }) => ({
        label: h.label,
        landmarks: h.landmarks.map(([x, y, z]) => ({ x, y, z })),
      })
    );
    events.push(...tracker.update(hands, frame.t, aspect).events);
  }
  return events;
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
  assert.deepEqual(
    starts.map((e) => `${e.gesture}:${e.hand}`).sort(),
    ["pinch:Left", "pinch:Right"],
    starts.map((e) => `${e.gesture}:${e.hand}@${e.t}`).join(", ")
  );
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
