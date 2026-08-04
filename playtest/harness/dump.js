/* =============================================================================
 * Result dumps — built for `diff`, not for reading pretty.
 *
 * Narrative-first, because all three answer_score_* arrays being empty means no
 * answer moves a vote; the thing that changes when you edit is the branch and
 * the text. Vote totals still go in, just below.
 *
 * Diff hygiene rules, all deliberate:
 *   - keys are emitted in a fixed order at every level (stableStringify)
 *   - no timestamps, no durations, no run ids anywhere in the body
 *   - floats are rounded to a fixed precision so harmless last-bit jitter
 *     does not show up as a diff
 *   - the seed and the engine commit are recorded, because a diff is
 *     meaningless without knowing those matched
 *
 * Nothing mod-specific: every field is derived from whatever the mod defined.
 * ============================================================================= */

'use strict';

const FLOAT_PRECISION = 6;

function roundFloats(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    return Number(value.toFixed(FLOAT_PRECISION));
  }
  if (Array.isArray(value)) return value.map(roundFloats);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = roundFloats(value[k]);
    return out;
  }
  return value;
}

/** JSON.stringify with keys sorted at every level, so diffs are line-stable. */
export function stableStringify(value, indent = 2) {
  const seen = new WeakSet();

  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
    return out;
  };

  return JSON.stringify(walk(roundFloats(value)), null, indent);
}

/**
 * Collect everything worth diffing out of a finished (or partway) session.
 *
 * `narrativeState` is whatever the mod exposed on the game window for
 * debugging — this harness looks for a small set of conventional names but does
 * not require any of them, and does not care what is inside.
 */
export function buildDump({ session, mod, seed, engineVersion, label }) {
  const t = session.temp;
  const params = t.global_parameter_json?.[0]?.fields ?? {};
  const election = t.election_json?.[0]?.fields ?? {};

  const results = session.finalResults();

  return {
    // ---- what produced this run
    run: {
      label: label || 'run',
      mod: mod.name,
      modFiles: {
        code1: mod.code1 ? { bytes: mod.code1.bytes, path: mod.code1.path } : null,
        code2: mod.code2 ? { bytes: mod.code2.bytes, path: mod.code2.path } : null,
        code3: mod.code3 ? { bytes: mod.code3.bytes, path: mod.code3.path } : null,
      },
      seed: seed ?? null,
      seededDraws: session.rng ? session.rng.draws : null,
      engineCommit: engineVersion?.commit ?? null,
      selection: session.selection ?? null,
      difficultyMultiplier: t.difficulty_level_multiplier ?? null,
      questionCount: params.question_count ?? null,
      finished: session.isFinished(),
    },

    // ---- the narrative: the part that actually changes when you edit
    narrative: {
      answerPath: (t.player_answers || []).filter((x) => x !== null),
      turns: session.transcript.map((entry) => ({
        questionIndex: entry.questionIndex,
        questionPk: entry.questionPk,
        answerPk: entry.answerPk,
        answerText: entry.answerText,
        feedback: entry.feedback,
      })),
      modState: captureModState(session.win),
    },

    // ---- the numbers
    results: results
      ? {
        national: results.national,
        totalVotes: results.totalVotes,
        electoralVotesToWin: election.winning_electoral_vote_number ?? null,
        states: results.states,
      }
      : null,
  };
}

/**
 * Grab any mod-authored debug state off the game window.
 *
 * Deliberately generic. Mods conventionally hang a state object on window under
 * a short name; rather than hardcode one, this snapshots every own enumerable
 * window property that is a plain, JSON-safe, non-engine object of modest size.
 * If your mod exposes nothing, this returns {} and nothing breaks.
 */
function captureModState(win) {
  // Names the engine and the browser own. Anything here is not mod state.
  const ENGINE_KEYS = new Set([
    'campaignTrail_temp', 'nct_stuff', 'jet_data', 'ree', 'PROPS', 'e',
    'res', 'nn2', 'nn3', 'rFuncRes', 'primary_breaks', 'corrr', 'customMod',
    'loadedMetadataMods', 'baseJSONPromises', 'stopSpacebar', 'results_timeout',
    'choose', 'getModFromDB', 'expandFavoriteSet', 'DEBUG',
  ]);

  const out = {};

  let names = [];
  try {
    names = Object.keys(win);
  } catch {
    return out;
  }

  for (const name of names) {
    if (ENGINE_KEYS.has(name)) continue;
    if (name.startsWith('webkit') || name.startsWith('on')) continue;

    let value;
    try {
      value = win[name];
    } catch {
      continue;
    }

    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) continue;
    // Skip DOM nodes, windows, and anything host-ish.
    try {
      if (value instanceof win.Node) continue;
      if (value === win || value instanceof win.Window) continue;
      if (value.constructor && value.constructor.name !== 'Object') continue;
    } catch {
      continue;
    }

    // Must be small and JSON-safe to be plausible mod state.
    let clone;
    try {
      const text = JSON.stringify(value);
      if (!text || text.length > 20000) continue;
      clone = JSON.parse(text);
    } catch {
      continue;
    }

    const keyCount = Object.keys(clone).length;
    if (keyCount === 0 || keyCount > 200) continue;

    out[name] = clone;
  }

  return out;
}

/** POST the dump to the server so it lands in playtest/runs/ for diffing. */
export async function writeDump(filename, dumpObject) {
  const body = JSON.stringify({
    filename,
    dump: stableStringify(dumpObject),
  });

  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `Server returned ${res.status}`);
  }
  return data;
}
