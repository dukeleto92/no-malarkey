/* =============================================================================
 * Seeded RNG
 *
 * Replaces Math.random on a target window with a deterministic stream so that a
 * changed result is attributable to your edit rather than to luck.
 *
 * WHY THIS IS DELICATE — read before changing anything here.
 *
 * The engine does not draw a fixed number of random values per turn. Two
 * reasons:
 *
 *   1. randomNormal() (campaign_trail.js:686) is Box-Muller with rejection
 *      sampling:  do { x=2*rand()-1; y=2*rand()-1; r2=x*x+y*y } while (r2>=1||r2===0)
 *      Each call consumes 2, 4, 6, ... values depending on how many samples
 *      land outside the unit circle. The count is itself random.
 *
 *   2. A(2) is called more than once per turn. Once synchronously at the top of
 *      nextQuestion() (line 1795), and once again from mapCache() (line 186)
 *      which nextQuestion schedules via setTimeout(..., 0) on most turns.
 *      Each A(2) draws randomNormal() per candidate per state, plus one plain
 *      Math.random() per state for the popular-vote jitter.
 *
 * Consequence: identical seed gives identical results ONLY IF the identical
 * sequence of engine calls happens in the identical order. Skip a map render,
 * open the electoral map mid-game, or click faster than the setTimeout fires,
 * and the stream desynchronises. That is why the harness runs the real
 * nextQuestion() with a real (if hidden) map container, and why it lets the
 * event loop drain between turns.
 *
 * The generator is mulberry32: tiny, fast, well-distributed enough for this,
 * and short enough that you can verify it by eye.
 * ============================================================================= */

'use strict';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Turns any string into a 32-bit seed, so you can use ?seed=parkland if you like.
export function hashSeed(input) {
  const s = String(input);
  if (/^-?\d+$/.test(s)) return Number(s) >>> 0;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Install a seeded Math.random onto a window (usually the game iframe's).
 * Returns a controller so the harness can report how many values were drawn —
 * a cheap way to spot a desync between two runs that should have matched.
 *
 * Call this AFTER the page has loaded and IMMEDIATELY BEFORE starting the game.
 * Page-load code (indexCode.js draws twice at load) must be outside the seeded
 * region, because on the real Showcase you cannot seed before page load either.
 * Matching that boundary is what makes the parity check meaningful.
 */
export function installSeededRandom(targetWindow, seedInput) {
  const seed = hashSeed(seedInput);
  const gen = mulberry32(seed);

  let draws = 0;
  const original = targetWindow.Math.random;

  const seeded = function random() {
    draws += 1;
    return gen();
  };

  targetWindow.Math.random = seeded;

  return {
    seed,
    seedInput: String(seedInput),
    get draws() { return draws; },
    isActive() { return targetWindow.Math.random === seeded; },
    restore() { targetWindow.Math.random = original; },
  };
}

/**
 * Yield to the event loop until it is quiet, so setTimeout(...,0) work the
 * engine scheduled (mapCache -> A(2)) has actually run and consumed its share
 * of the stream before the next turn begins. Without this the RNG consumption
 * order depends on how fast the harness clicks, which is exactly the
 * nondeterminism we are trying to remove.
 */
export function settle(win, rounds = 3) {
  return new Promise((resolve) => {
    let n = 0;
    const tick = () => {
      n += 1;
      if (n >= rounds) return resolve();
      return win.setTimeout(tick, 0);
    };
    win.setTimeout(tick, 0);
  });
}
