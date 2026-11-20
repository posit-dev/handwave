// Run with: npm test (Node 22.18+ runs TypeScript directly)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
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
    // Fingertips past the edge: MediaPipe extrapolates these
    hand(1.05, 0.5, CLOSED),
    hand(1.2, 0.5, CLOSED),
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
    hand(1.1, 0.5, OPEN),
    hand(1.1, 0.5, OPEN),
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
    [],
    [],
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
    [],
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
