/* =============================================================================
 * Headless map-target check.
 *
 *   node playtest/harness/checkmap.mjs [modFolder]
 *
 * Same assertion the harness runs on "Reload & validate", without the browser,
 * so it can be scripted or dropped into CI. Exits 1 if the map is off target.
 * ============================================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMapTargets, DEFAULT_TOLERANCE, DEFAULT_TIPPING_POINT } from './maptargets.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, '..', '..');

const modDir = process.argv[2] ? path.resolve(PROJECT_DIR, process.argv[2]) : PROJECT_DIR;

function readMod(dir) {
  const temp = {};
  globalThis.campaignTrail_temp = temp;
  const run = (src) => (0, eval)(src);

  const code2 = fs.readFileSync(path.join(dir, 'Code 2'), 'utf8');
  run(code2);

  // Code 1's data head only. Everything past //#startcode is the govern-phase
  // engine, which expects a DOM and is irrelevant to the starting map.
  const code1 = fs.readFileSync(path.join(dir, 'Code 1'), 'utf8');
  const cut = code1.indexOf('//#startcode');
  run(cut === -1 ? code1 : code1.slice(0, cut));

  return temp;
}

let targetsText = '';
try {
  targetsText = fs.readFileSync(path.join(PROJECT_DIR, 'CLAUDE.md'), 'utf8');
} catch { /* skipped inside checkMapTargets */ }

const temp = readMod(modDir);
const result = checkMapTargets(temp, targetsText);

const fmt = (v) => `${v >= 0 ? 'D+' : 'R+'}${Math.abs(v).toFixed(2)}`;

if (result.skipped) {
  for (const n of result.notes) console.log(`NOTE  ${n.msg}`);
  process.exit(0);
}

console.log(`Tolerance +-${DEFAULT_TOLERANCE} points; tipping point must be ${DEFAULT_TIPPING_POINT.join(' or ')}.`);
if (result.tippingPoint) {
  const ev = result.electoralVotes;
  console.log(`Tipping point: ${result.tippingPoint.name} (${result.tippingPoint.abbr}) at ${fmt(result.tippingPoint.margin)}`);
  console.log(`Electoral votes: ${ev.first}-${ev.second}, ${ev.needed} to win.`);
}
console.log('');

for (const n of result.notes) console.log(`NOTE  ${n.msg}\n`);
for (const e of result.errors) console.log(`FAIL  ${e.where}\n      ${e.msg}\n`);

if (!result.errors.length) console.log('PASS  map is on target.');
process.exit(result.errors.length ? 1 : 0);
