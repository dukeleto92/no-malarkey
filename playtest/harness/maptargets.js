/* =============================================================================
 * Map-target assertion — "is the starting map where the design says it is?"
 *
 * This is deliberately NOT part of validate.js. That file is mod-agnostic by
 * contract ("no hardcoded pks, no candidate ids, no year"), and a table of
 * Biden-era state margins is the opposite of that. So the mechanism lives here
 * and the DATA lives in the project's CLAUDE.md, which the v0.10 section
 * declares the authoritative source for map work. One source of truth, and a
 * mod with no such section simply skips the check.
 *
 * WHAT "STARTING POPULARITY" MEANS HERE
 *
 * The engine's A() (campaign_trail.js:3694) scores a state as
 *
 *     score_c = max(0, state_multiplier_c * SUM_issues( vote_variable
 *                        - |S_c - E_state,issue| * weight ))
 *
 * with S = issue_score*|issue_score| for the candidate and E the same shape for
 * the state. Margin is the two-way share of those scores. This module evaluates
 * that at the start of a run, which pins five things:
 *
 *   - no answers      -> answer_score_global/_issue/_state contribute nothing
 *   - no visits       -> the per-visit state boost is zero
 *   - RNG at its mean -> both (1 + randomNormal()*variance) terms are 1
 *   - difficulty 1.0  -> the player's global multiplier is not scaled
 *   - matchup         -> opponents_default_json, normally [player, opponent]
 *
 * The running-mate home-state boost (A() line ~3889) IS applied, because the
 * engine applies it unconditionally on every call, visits or not.
 *
 * WHY THIS IS A MIRROR AND NOT A CALL INTO THE ENGINE
 *
 * The real A() only exists inside the game iframe, which is not booted until
 * you press Start run. Validation happens on file load, before any of that. So
 * the arithmetic above is re-implemented, and that means it can drift if the
 * pinned engine is ever re-pinned to a version that scores differently.
 * assertEngineShape() below is the tripwire for the most likely drift: it
 * checks that the global parameters this mirror reads still exist and are
 * numbers. It cannot catch a changed FORMULA — if you re-pin the engine, diff
 * A() against the block comment above.
 * ============================================================================= */

'use strict';

/* ----------------------------------------------------------------- parsing */

// "D+10" -> +10 ; "R+0.5" -> -0.5 ; "R+20+" -> -20 with floor semantics.
// The trailing "+" means "at least this much", not "this much give or take" —
// Utah is written "R+20+ / exact figure irrelevant" and a +-1.5 band around it
// would fail a map that is correctly deeper than the target.
function parseMargin(text) {
  const m = String(text).trim().match(/^([DR])\s*\+\s*([0-9]+(?:\.[0-9]+)?)\s*(\+?)$/i);
  if (!m) return null;
  const sign = m[1].toUpperCase() === 'D' ? 1 : -1;
  return { value: sign * Number(m[2]), floor: m[3] === '+' };
}

// Targets use display names ("Maine-02"); states_json uses "Maine-2". Fold both
// to the same key so the two can never drift apart on a leading zero.
function normaliseStateName(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/-0*(\d+)$/, '-$1');
}

/**
 * Pull the margin targets out of a CLAUDE.md. Looks for a heading containing
 * "electoral map targets" and reads the first markdown table under it.
 *
 * @param {string} markdown
 * @returns {{targets: Map<string, {name: string, margin: number, floor: boolean}>,
 *            heading: string|null}}
 */
export function parseTargets(markdown) {
  const targets = new Map();
  if (typeof markdown !== 'string' || !markdown) return { targets, heading: null };

  const lines = markdown.split(/\r?\n/);
  let i = lines.findIndex((l) => /^#{1,6}\s+.*electoral map targets/i.test(l));
  if (i === -1) return { targets, heading: null };

  const heading = lines[i].replace(/^#+\s*/, '').trim();

  // Walk to the first table row, then consume rows until the table ends.
  let started = false;
  for (i += 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (/^#{1,6}\s/.test(line)) break;          // next section, table never came
    if (!line.startsWith('|')) {
      if (started) break;                        // table finished
      continue;
    }
    started = true;

    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.length < 2) continue;
    if (/^:?-{2,}:?$/.test(cells[0])) continue;  // separator row
    if (/^state$/i.test(cells[0])) continue;     // header row

    const margin = parseMargin(cells[1]);
    if (!margin) continue;                       // not a target row

    targets.set(normaliseStateName(cells[0]), {
      name: cells[0],
      margin: margin.value,
      floor: margin.floor,
    });
  }

  return { targets, heading };
}

/* --------------------------------------------------------------- the mirror */

function assertEngineShape(temp) {
  const gp = temp?.global_parameter_json?.[0]?.fields;
  if (!gp) return 'global_parameter_json[0].fields is missing.';
  for (const key of ['vote_variable', 'candidate_issue_weight', 'running_mate_issue_weight']) {
    if (typeof gp[key] !== 'number') return `global_parameter "${key}" is not a number.`;
  }
  return null;
}

function removeIssueDuplicates(array) {
  return array.filter((f, i) => array.findIndex((g) => g.issue === f.issue) === i);
}

function resolveMatchup(temp) {
  const def = (temp.opponents_default_json || [])[0];
  if (def && Array.isArray(def.candidates) && def.candidates.length >= 2) return def.candidates.slice();

  // Fall back to the two active, non-running-mate candidates by priority.
  const cands = (temp.candidate_json || [])
    .filter((c) => !c.fields.running_mate)
    .sort((a, b) => (a.fields.priority ?? 0) - (b.fields.priority ?? 0))
    .map((c) => c.pk);
  return cands.slice(0, 2);
}

/**
 * Every state's two-way margin at starting popularity, positive = first
 * candidate in the matchup.
 *
 * @param {object} temp - campaignTrail_temp
 * @returns {{rows: Array, error: string|null}}
 */
export function startingMargins(temp) {
  const shapeError = assertEngineShape(temp);
  if (shapeError) return { rows: [], error: shapeError };

  const gp = temp.global_parameter_json[0].fields;
  const voteVar = gp.vote_variable;
  const CIW = gp.candidate_issue_weight;
  const RMIW = gp.running_mate_issue_weight;

  const matchup = resolveMatchup(temp);
  if (matchup.length < 2) return { rows: [], error: 'Could not resolve a two-candidate matchup.' };
  const playerId = matchup[0];

  // -- candidate issue scores, running mate blended into the player only -----
  const issueByCand = new Map();
  for (const it of (temp.candidate_issue_score_json || [])) {
    const c = it.fields.candidate;
    if (!issueByCand.has(c)) issueByCand.set(c, []);
    issueByCand.get(c).push(it);
  }
  const rmByIssue = new Map((temp.running_mate_issue_score_json || []).map((x) => [x.fields.issue, x]));

  const candIssues = matchup.map((c) => {
    const own = removeIssueDuplicates(
      (issueByCand.get(c) || []).map((it) => ({ issue: it.fields.issue, issue_score: it.fields.issue_score })),
    );
    if (c !== playerId) return own;
    return own.map((it) => {
      const ri = rmByIssue.get(it.issue);
      if (!ri) return it;
      return {
        ...it,
        issue_score: (it.issue_score * CIW + ri.fields.issue_score * RMIW) / (CIW + RMIW),
      };
    });
  });

  // -- state issue scores ---------------------------------------------------
  const stateIssue = new Map();
  for (const s of (temp.state_issue_score_json || [])) {
    const f = s.fields;
    if (!stateIssue.has(f.state)) stateIssue.set(f.state, new Map());
    if (!stateIssue.get(f.state).has(f.issue)) stateIssue.get(f.state).set(f.issue, f);
  }

  // -- state multipliers, global multiplier 1 and RNG at its mean -----------
  const multByCandState = new Map();
  for (const it of (temp.candidate_state_multiplier_json || [])) {
    if (it.model && it.model !== 'campaign_trail.candidate_state_multiplier') continue;
    multByCandState.set(`${it.fields.candidate}|${Number(it.fields.state)}`, it.fields.state_multiplier);
  }

  const stateFields = new Map((temp.states_json || []).map((s) => [s.pk, s.fields]));
  const rmStateId = temp.running_mate_state_id;

  const rows = [];
  for (const [pk, sf] of stateFields.entries()) {
    const scores = matchup.map((candId, r) => {
      let sm = multByCandState.get(`${candId}|${pk}`);
      if (sm == null) return null;
      // Running-mate home state: A() applies this on every call, not only when
      // the player has visited.
      if (r === 0 && rmStateId === pk) sm += 0.004 * sm;

      let score = 0;
      for (let idx = 0; idx < candIssues[r].length; idx += 1) {
        const iss = candIssues[r][idx];
        const refIssue = candIssues[0][idx] && candIssues[0][idx].issue;
        const sim = stateIssue.get(pk);
        let stateScore = 0;
        let weight = 1;
        if (sim && sim.has(refIssue)) {
          stateScore = sim.get(refIssue).state_issue_score;
          weight = sim.get(refIssue).weight;
        }
        const S = iss.issue_score * Math.abs(iss.issue_score);
        const E = stateScore * Math.abs(stateScore);
        score += voteVar - Math.abs((S - E) * weight);
      }
      return Math.max(score * sm, 0);
    });

    if (scores.some((s) => s == null)) continue;
    const total = scores.reduce((a, b) => a + b, 0);
    if (!(total > 0)) continue;

    rows.push({
      pk,
      name: sf.name,
      abbr: sf.abbr,
      electoral_votes: sf.electoral_votes,
      margin: ((scores[0] - scores[1]) / total) * 100,
    });
  }

  rows.sort((a, b) => b.margin - a.margin);
  return { rows, error: null };
}

/* ------------------------------------------------------------- the assertion */

export const DEFAULT_TOLERANCE = 1.5;
export const DEFAULT_TIPPING_POINT = ['Iowa', 'North Carolina'];

/**
 * Assert the starting map against the CLAUDE.md targets.
 *
 * Skips cleanly (no errors) when the project has no targets table, so the
 * harness stays usable for a mod that has never heard of this check.
 *
 * @param {object} temp        - campaignTrail_temp
 * @param {string} targetsText - the contents of CLAUDE.md, or '' / null
 * @param {object} [opts]
 * @param {number} [opts.tolerance]     - points, default 1.5
 * @param {string[]} [opts.tippingPoint]- acceptable tipping-point state names
 * @returns {{errors: Array, notes: Array, skipped: boolean, rows: Array,
 *            tippingPoint: object|null, electoralVotes: object|null}}
 */
export function checkMapTargets(temp, targetsText, opts = {}) {
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
  const wanted = opts.tippingPoint ?? DEFAULT_TIPPING_POINT;
  const errors = [];
  const notes = [];
  const WHERE = 'map targets';

  const { targets, heading } = parseTargets(targetsText);
  if (!targets.size) {
    return {
      errors: [],
      notes: [{
        where: WHERE,
        msg: targetsText
          ? 'No "Electoral map targets" table found in CLAUDE.md — map assertion skipped.'
          : 'CLAUDE.md was not readable — map assertion skipped.',
      }],
      skipped: true,
      rows: [],
      tippingPoint: null,
      electoralVotes: null,
    };
  }

  const { rows, error } = startingMargins(temp);
  if (error) {
    return {
      errors: [{ where: WHERE, msg: `Could not compute starting margins: ${error}` }],
      notes: [],
      skipped: false,
      rows: [],
      tippingPoint: null,
      electoralVotes: null,
    };
  }

  const byName = new Map(rows.map((r) => [normaliseStateName(r.name), r]));

  /* -- per-state tolerance ------------------------------------------------- */

  const offTarget = [];
  const missing = [];
  for (const [key, target] of targets.entries()) {
    const row = byName.get(key);
    if (!row) { missing.push(target.name); continue; }

    // A "floor" target (written "R+20+") passes when the map is at least that
    // far in the stated direction; only the near side is a failure.
    const delta = row.margin - target.margin;
    const outOfBand = target.floor
      ? (target.margin < 0 ? delta > tolerance : delta < -tolerance)
      : Math.abs(delta) > tolerance;

    if (outOfBand) {
      offTarget.push({
        name: row.name,
        abbr: row.abbr,
        actual: row.margin,
        target: target.margin,
        floor: target.floor,
        delta,
      });
    }
  }

  if (missing.length) {
    notes.push({
      where: WHERE,
      msg: `${missing.length} target(s) name a state that is not in states_json and were not checked: ${missing.join(', ')}.`,
    });
  }

  const untargeted = rows.filter((r) => !targets.has(normaliseStateName(r.name)));
  if (untargeted.length) {
    notes.push({
      where: WHERE,
      msg: `${untargeted.length} of ${rows.length} units have no target in "${heading}" and were not checked: ${untargeted.map((r) => r.abbr).join(', ')}.`,
    });
  }

  if (offTarget.length) {
    offTarget.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    const fmt = (v) => `${v >= 0 ? 'D+' : 'R+'}${Math.abs(v).toFixed(2)}`;
    const list = offTarget.map((s) => {
      const want = `${fmt(s.target)}${s.floor ? ' or deeper' : ''}`;
      const off = `${s.delta >= 0 ? '+' : ''}${s.delta.toFixed(2)}`;
      return `      ${s.name} (${s.abbr})  is ${fmt(s.actual)}  want ${want}  off by ${off}`;
    });
    errors.push({
      where: WHERE,
      msg: `${offTarget.length} of ${targets.size} targeted state(s) are outside the +-${tolerance} point tolerance `
        + `at starting popularity:\n${list.join('\n')}`,
    });
  }

  /* -- tipping point ------------------------------------------------------- */

  const totalEV = rows.reduce((a, r) => a + r.electoral_votes, 0);
  const needed = Math.floor(totalEV / 2) + 1;
  let run = 0;
  let tippingPoint = null;
  for (const r of rows) {
    run += r.electoral_votes;
    if (run >= needed) { tippingPoint = r; break; }
  }

  const electoralVotes = {
    first: rows.filter((r) => r.margin > 0).reduce((a, r) => a + r.electoral_votes, 0),
    second: rows.filter((r) => r.margin <= 0).reduce((a, r) => a + r.electoral_votes, 0),
    needed,
    total: totalEV,
  };

  const wantedKeys = new Set(wanted.map(normaliseStateName));
  if (!tippingPoint) {
    errors.push({ where: WHERE, msg: `No state reached ${needed} electoral votes; the map has no tipping point.` });
  } else if (!wantedKeys.has(normaliseStateName(tippingPoint.name))) {
    const fmt = (v) => `${v >= 0 ? 'D+' : 'R+'}${Math.abs(v).toFixed(2)}`;
    errors.push({
      where: WHERE,
      msg: `Tipping point is ${tippingPoint.name} (${tippingPoint.abbr}) at ${fmt(tippingPoint.margin)}, `
        + `but must be one of: ${wanted.join(', ')}. `
        + `Electoral votes ${electoralVotes.first}-${electoralVotes.second}, ${needed} to win.`,
    });
  }

  return { errors, notes, skipped: false, rows, tippingPoint, electoralVotes };
}
