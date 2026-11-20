import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createLiveMotion } from "../lib/fitting/live-motion.js";
import { handleStudioAi } from "../lib/fitting/studio-ai-service.mjs";

const source = new URL("../app/studio-models/male-landmarks.json", import.meta.url);
const standing = JSON.parse(await readFile(source, "utf8"));

test("a still wearer uses fewer pose measurements while animation stays responsive", () => {
  const motion = createLiveMotion();
  let nextMeasurement = 0;
  let measurements = 0;
  for (let time = 0; time <= 3000; time += 1000 / 60) {
    if (time >= nextMeasurement) {
      motion.push(standing, time, time + 5);
      nextMeasurement = time + motion.interval();
      measurements++;
    }
    assert.ok(motion.sample(time + 5));
  }
  assert.ok(measurements < 20);
  const restInterval = motion.interval();
  const shifted = standing.map((point) => ({ ...point, x: point.x + 0.065 }));
  motion.push(shifted, 3150, 3155);
  assert.ok(motion.interval() < restInterval);
  const inBetween = motion.sample(3180)[11].x;
  assert.ok(inBetween > standing[11].x && inBetween < shifted[11].x);
});

test("an empty or expired measurement removes the garment's pose", () => {
  const motion = createLiveMotion();
  motion.push(standing, 0, 5, 300);
  assert.ok(motion.sample(299));
  assert.equal(motion.sample(305), null);
  motion.push(standing, 320, 325);
  motion.push(null, 350, 355);
  assert.equal(motion.sample(356), null);
});

test("a local-only studio rejects paid jobs even with a configured provider", async () => {
  const env = { DRAPE_LOCAL_ONLY: "true", FASHN_API_KEY: "test-only" };
  const transport = () => assert.fail("Local-only fitting contacted a provider");
  const base = "https://example.test/api/ai-tryon";
  const info = await handleStudioAi(new Request(base), env, transport);
  assert.deepEqual(await info.json(), { configured: false, mode: "local-only" });
  const submit = await handleStudioAi(new Request(base, { method: "POST" }), env, transport);
  assert.equal(submit.status, 403);
  const poll = await handleStudioAi(new Request(base + "?job=test"), env, transport);
  assert.equal(poll.status, 403);
});

test("flat photo placement keeps the whole shirt box fixed when wrists cross or disappear", async () => {
  const { fitLandmarks } = await import("../lib/fitting/pose.js");
  const frame = { left: 0, top: 0, width: 480, height: 640 };
  const expected = fitLandmarks(standing, frame, "top", 0.8);
  assert.ok(expected);
  for (const confidence of [1, 0.1, 0]) {
    const points = structuredClone(standing);
    for (const i of [15, 16]) {
      points[i] = { x: i === 15 ? 0.09 : 0.92, y: 0.8, confidence };
    }
    assert.deepEqual(fitLandmarks(points, frame, "top", 0.8), expected);
  }
});
