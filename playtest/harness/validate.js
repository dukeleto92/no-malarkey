/* =============================================================================
 * Mod data validator — FORWARD COMPATIBLE BY DESIGN
 *
 * The rule, in one line: unknown things are warnings, missing known-required
 * things are errors. Adding a field or a whole new array to your mod must never
 * stop you from playing.
 *
 * Specifically:
 *   - A field this file has never heard of  -> NEW FIELD warning, listing
 *     model / pk / field name / the value it saw. Never an error.
 *   - A whole array this file has never heard of -> NEW ARRAY warning with a
 *     record count. Never an error.
 *   - A known-required field that is missing or the wrong type -> error.
 *   - A foreign key pointing at a pk that does not exist -> error.
 *   - Duplicate pks within one array -> error.
 *   - Everything else that looks off but is survivable -> warning.
 *
 * Nothing in this file is specific to any one mod. There are no hardcoded pks,
 * no candidate ids, no question counts, no year. The schema table below names
 * fields and types only; every id is resolved from the data itself.
 * ============================================================================= */

'use strict';

/* ------------------------------------------------------------------ schema */

// Per model: which fields are required, and their expected coarse type.
// 'num'  -> typeof number, or a string that coerces cleanly (the engine is
//           loose about this and so are we)
// 'str'  -> typeof string
// 'bool' -> boolean, or 0/1, since the engine's own data mixes them
// 'any'  -> must be present, type unchecked
//
// Fields NOT listed here are not errors. They produce NEW FIELD warnings.
const SCHEMA = {
  'campaign_trail.election': {
    array: 'election_json',
    required: { year: 'num', winning_electoral_vote_number: 'num' },
    optional: {
      summary: 'str', image_url: 'str', advisor_url: 'str', recommended_reading: 'str',
      has_visits: 'bool', no_electoral_majority_image: 'str', creator: 'str',
      display_year: 'any', site_image: 'str', site_description: 'str',
      display_name: 'str', title: 'str', premium: 'bool', is_premium: 'bool',
    },
  },
  'campaign_trail.candidate': {
    array: 'candidate_json',
    required: { first_name: 'str', last_name: 'str', election: 'num' },
    optional: {
      party: 'str', state: 'str', priority: 'num', description: 'str',
      color_hex: 'str', secondary_color_hex: 'str', is_active: 'bool',
      image_url: 'str', electoral_victory_message: 'str', electoral_loss_message: 'str',
      no_electoral_majority_message: 'str', description_as_running_mate: 'str',
      candidate_score: 'num', running_mate: 'bool', popular_victory_message: 'str',
      popular_loss_message: 'str',
    },
  },
  'campaign_trail.running_mate': {
    array: 'running_mate_json',
    required: { candidate: 'num', running_mate: 'num' },
    optional: {},
  },
  'campaign_trail.global_parameter': {
    array: 'global_parameter_json',
    required: {
      vote_variable: 'num', max_swing: 'num', start_point: 'num',
      candidate_issue_weight: 'num', running_mate_issue_weight: 'num',
      global_variance: 'num', question_count: 'num',
    },
    optional: {
      issue_stance_1_max: 'num', issue_stance_2_max: 'num', issue_stance_3_max: 'num',
      issue_stance_4_max: 'num', issue_stance_5_max: 'num', issue_stance_6_max: 'num',
      state_variance: 'num', default_map_color_hex: 'str', no_state_map_color_hex: 'str',
    },
  },
  'campaign_trail.question': {
    array: 'questions_json',
    required: { description: 'str' },
    optional: { priority: 'num', likelihood: 'num', image_url: 'str', question_image: 'str' },
  },
  'campaign_trail.answer': {
    array: 'answers_json',
    required: { question: 'num', description: 'str' },
    optional: { priority: 'num' },
  },
  'campaign_trail.state': {
    array: 'states_json',
    required: { name: 'str', abbr: 'str', electoral_votes: 'num', popular_votes: 'num' },
    optional: { poll_closing_time: 'num', winner_take_all_flg: 'bool', election: 'num' },
  },
  'campaign_trail.issue': {
    array: 'issues_json',
    required: { name: 'str' },
    optional: {
      description: 'str', election: 'num',
      stance_1: 'str', stance_2: 'str', stance_3: 'str', stance_4: 'str',
      stance_5: 'str', stance_6: 'str', stance_7: 'str',
      stance_desc_1: 'str', stance_desc_2: 'str', stance_desc_3: 'str', stance_desc_4: 'str',
      stance_desc_5: 'str', stance_desc_6: 'str', stance_desc_7: 'str',
    },
  },
  'campaign_trail.state_issue_score': {
    array: 'state_issue_score_json',
    required: { state: 'num', issue: 'num', state_issue_score: 'num' },
    optional: { weight: 'num' },
  },
  'campaign_trail.candidate_issue_score': {
    // NOTE: this model name is reused by running_mate_issue_score_json upstream,
    // so it is resolved per-array rather than per-model. See ARRAY_MODEL below.
    array: 'candidate_issue_score_json',
    required: { candidate: 'num', issue: 'num', issue_score: 'num' },
    optional: {},
  },
  'campaign_trail.candidate_state_multiplier': {
    array: 'candidate_state_multiplier_json',
    required: { candidate: 'num', state: 'num', state_multiplier: 'num' },
    optional: {},
  },
  'campaign_trail.answer_feedback': {
    array: 'answer_feedback_json',
    required: { answer: 'num', answer_feedback: 'str' },
    optional: { candidate: 'num' },
  },
  'campaign_trail.answer_score_global': {
    array: 'answer_score_global_json',
    required: { answer: 'num', global_multiplier: 'num' },
    optional: { candidate: 'num', affected_candidate: 'num' },
  },
  'campaign_trail.answer_score_issue': {
    array: 'answer_score_issue_json',
    required: { answer: 'num', issue: 'num', issue_score: 'num' },
    optional: { candidate: 'num', state: 'num', tag: 'str', issue_importance: 'num' },
  },
  'campaign_trail.answer_score_state': {
    array: 'answer_score_state_json',
    required: { answer: 'num', state: 'num', state_multiplier: 'num' },
    optional: { candidate: 'num' },
  },
};

// Arrays the harness recognises, mapped to the schema key used to check them.
// running_mate_issue_score_json carries "campaign_trail.candidate_issue_score"
// in its model field upstream, which is why this indirection exists.
const ARRAY_MODEL = {
  election_json: 'campaign_trail.election',
  candidate_json: 'campaign_trail.candidate',
  running_mate_json: 'campaign_trail.running_mate',
  global_parameter_json: 'campaign_trail.global_parameter',
  questions_json: 'campaign_trail.question',
  answers_json: 'campaign_trail.answer',
  states_json: 'campaign_trail.state',
  issues_json: 'campaign_trail.issue',
  state_issue_score_json: 'campaign_trail.state_issue_score',
  candidate_issue_score_json: 'campaign_trail.candidate_issue_score',
  running_mate_issue_score_json: 'campaign_trail.candidate_issue_score',
  candidate_state_multiplier_json: 'campaign_trail.candidate_state_multiplier',
  answer_feedback_json: 'campaign_trail.answer_feedback',
  answer_score_global_json: 'campaign_trail.answer_score_global',
  answer_score_issue_json: 'campaign_trail.answer_score_issue',
  answer_score_state_json: 'campaign_trail.answer_score_state',
};

// Arrays that must exist and hold at least one record for the game to start.
const REQUIRED_ARRAYS = [
  'election_json', 'candidate_json', 'global_parameter_json',
  'questions_json', 'answers_json', 'states_json', 'issues_json',
];

// Non-array scalars the harness knows about, so they don't show up as noise.
const KNOWN_SCALARS = new Set([
  'credits', 'cyoa', 'primary', 'primary_code', 'multiple_endings', 'collect_results',
  'running_mate_id', 'running_mate_state_id', 'candidate_id', 'election_id',
  'candidate_last_name', 'running_mate_last_name', 'candidate_image_url',
  'running_mate_image_url', 'answer_feedback_flg', 'player_answers', 'player_visits',
  'game_start_logging_id', 'opponents_default_json', 'opponents_weighted_json',
  'temp_election_list', 'jet_data', 'difficulty_level_json', 'candidate_dropout_json',
  'achievements', 'modBoxTheme', 'custom_code_2', 'hotload', 'matchup', 'shining',
  'question_number', 'CTS', 'show_premium', 'premier_ab_test_version', 'musicOn',
  'musicSrc', 'margin_format', 'difficulty_level_id', 'difficulty_level_multiplier',
  'game_type_id', 'opponents_list', 'dagakotowaru', 'final_state_results',
  'current_results', 'corQuestion', 'shining_info', 'shining_data', 'data_overall',
  'candidate_ids', 'election_json_backup', 'county_data', 'counties_json',
]);

/* ------------------------------------------------------------------ helpers */

function typeOk(kind, value) {
  switch (kind) {
    case 'num':
      if (typeof value === 'number') return Number.isFinite(value);
      // The engine tolerates numeric strings in several places, so we do too.
      return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
    case 'str':
      return typeof value === 'string';
    case 'bool':
      return typeof value === 'boolean' || value === 0 || value === 1;
    case 'any':
      return value !== undefined;
    default:
      return true;
  }
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  const t = typeof value;
  if (t === 'string') return value.length > 60 ? `"${value.slice(0, 57)}..."` : `"${value}"`;
  if (t === 'object') return `object{${Object.keys(value).slice(0, 4).join(',')}}`;
  return String(value);
}

/* ------------------------------------------------------------------ core */

export function validateMod(temp) {
  const errors = [];
  const warnings = [];
  const notes = [];
  const newFields = []; // {array, model, pk, field, sample}
  const newArrays = []; // {name, count}

  const err = (where, msg) => errors.push({ where, msg });
  const warn = (where, msg) => warnings.push({ where, msg });

  if (!temp || typeof temp !== 'object') {
    err('campaignTrail_temp', 'Mod produced no campaignTrail_temp object at all. Code 1 probably threw before its first assignment — check the browser console.');
    return { errors, warnings, notes, newFields, newArrays, ok: false };
  }

  /* -- discover which arrays are present, and flag ones we do not know ----- */

  const present = {};
  for (const [key, value] of Object.entries(temp)) {
    const looksLikeRecordArray = Array.isArray(value)
      && value.length > 0
      && value.every((r) => r && typeof r === 'object' && 'fields' in r);

    if (ARRAY_MODEL[key]) {
      present[key] = Array.isArray(value) ? value : null;
      if (!Array.isArray(value)) {
        err(key, `Expected an array, found ${describe(value)}.`);
      }
    } else if (looksLikeRecordArray) {
      // A brand new fixture array. Warning only — this is the "I add new
      // mechanics often" case and it must not block.
      newArrays.push({ name: key, count: value.length });
    } else if (!KNOWN_SCALARS.has(key) && !key.startsWith('_')) {
      notes.push({ where: key, msg: `Unrecognised property (${describe(value)}). Harmless; listed so you can see it was picked up.` });
    }
  }

  for (const name of REQUIRED_ARRAYS) {
    if (!(name in present)) {
      err(name, 'Required array is missing entirely. The game cannot start without it.');
    } else if (Array.isArray(present[name]) && present[name].length === 0) {
      err(name, 'Required array is present but empty.');
    }
  }

  /* -- per-record field checks -------------------------------------------- */

  const pkIndex = {}; // arrayName -> Set of pks

  for (const [arrayName, records] of Object.entries(present)) {
    if (!Array.isArray(records)) continue;

    const modelKey = ARRAY_MODEL[arrayName];
    const spec = SCHEMA[modelKey] || { required: {}, optional: {} };
    const known = new Set([...Object.keys(spec.required), ...Object.keys(spec.optional)]);

    const seen = new Set();
    pkIndex[arrayName] = seen;

    records.forEach((rec, i) => {
      const at = `${arrayName}[${i}]`;

      if (!rec || typeof rec !== 'object') {
        err(at, `Record is ${describe(rec)}, expected an object.`);
        return;
      }

      // pk
      if (rec.pk === undefined || rec.pk === null) {
        err(at, 'Record has no pk. Every record needs a unique pk.');
      } else if (seen.has(rec.pk)) {
        err(`${arrayName} pk ${rec.pk}`, `Duplicate pk. Two records in ${arrayName} share pk ${rec.pk}; the engine will silently use whichever it finds first.`);
      } else {
        seen.add(rec.pk);
      }

      const label = `${arrayName} pk ${rec.pk}`;

      // model string is informational; a mismatch is a warning, not an error,
      // because the engine keys off the array not the model name.
      if (rec.model && rec.model !== modelKey) {
        warn(label, `model is "${rec.model}" but ${arrayName} is read as ${modelKey}. The engine ignores the model string, so this is cosmetic.`);
      }

      const fields = rec.fields;
      if (!fields || typeof fields !== 'object') {
        err(label, `fields is ${describe(fields)}, expected an object.`);
        return;
      }

      // required
      for (const [f, kind] of Object.entries(spec.required)) {
        if (!(f in fields)) {
          err(label, `Missing required field "${f}" (expected ${kind}).`);
        } else if (!typeOk(kind, fields[f])) {
          err(label, `Field "${f}" should be ${kind} but is ${describe(fields[f])}.`);
        }
      }

      // optional, type-checked only if present
      for (const [f, kind] of Object.entries(spec.optional)) {
        if (f in fields && fields[f] !== null && !typeOk(kind, fields[f])) {
          warn(label, `Field "${f}" is usually ${kind} but is ${describe(fields[f])}. Not fatal.`);
        }
      }

      // unknown -> NEW FIELD warning
      for (const f of Object.keys(fields)) {
        if (!known.has(f)) {
          newFields.push({ array: arrayName, model: modelKey, pk: rec.pk, field: f, sample: describe(fields[f]) });
        }
      }
    });
  }

  /* -- foreign keys ------------------------------------------------------- */

  const pkSet = (name) => pkIndex[name] || new Set();

  // Each entry: [array, field, target array, human name, severity]
  //
  // Severity is not a style choice — it reflects what the engine actually does
  // with a dangling reference:
  //
  //   'error' the engine iterates these rows unconditionally, so a bad target
  //           means a crash, a silently dropped question, or a wrong total.
  //   'warn'  the engine indexes the table by this key and only ever looks up
  //           keys in the matchup, so unreferenced rows are inert. Reported
  //           because they are almost certainly leftovers you want to know
  //           about, but they will not affect a run.
  //
  // The 'warn' classifications are verified against upstream:
  //   candidate_issue_score      A() builds issueByCandidate then reads only
  //                              matchup ids (campaign_trail.js ~3742)
  //   candidate_state_multiplier A() filters by candidate before use (~3842)
  //   answer_feedback.candidate  looked up by (answer, candidate) pair; a row
  //                              for an absent candidate is never matched
  const LINKS = [
    ['candidate_json', 'election', 'election_json', 'election', 'error'],
    ['states_json', 'election', 'election_json', 'election', 'error'],
    ['issues_json', 'election', 'election_json', 'election', 'error'],
    ['running_mate_json', 'candidate', 'candidate_json', 'candidate', 'error'],
    ['running_mate_json', 'running_mate', 'candidate_json', 'candidate', 'error'],
    ['answers_json', 'question', 'questions_json', 'question', 'error'],
    ['answer_feedback_json', 'answer', 'answers_json', 'answer', 'error'],
    ['answer_feedback_json', 'candidate', 'candidate_json', 'candidate', 'warn'],
    ['state_issue_score_json', 'state', 'states_json', 'state', 'error'],
    ['state_issue_score_json', 'issue', 'issues_json', 'issue', 'error'],
    ['candidate_issue_score_json', 'candidate', 'candidate_json', 'candidate', 'warn'],
    ['candidate_issue_score_json', 'issue', 'issues_json', 'issue', 'error'],
    ['running_mate_issue_score_json', 'candidate', 'candidate_json', 'candidate', 'warn'],
    ['running_mate_issue_score_json', 'issue', 'issues_json', 'issue', 'error'],
    ['candidate_state_multiplier_json', 'candidate', 'candidate_json', 'candidate', 'warn'],
    ['candidate_state_multiplier_json', 'state', 'states_json', 'state', 'error'],
    ['answer_score_global_json', 'answer', 'answers_json', 'answer', 'error'],
    ['answer_score_issue_json', 'answer', 'answers_json', 'answer', 'error'],
    ['answer_score_issue_json', 'issue', 'issues_json', 'issue', 'error'],
    ['answer_score_state_json', 'answer', 'answers_json', 'answer', 'error'],
    ['answer_score_state_json', 'state', 'states_json', 'state', 'error'],
  ];

  for (const [arrayName, field, targetArray, human, severity] of LINKS) {
    const records = present[arrayName];
    if (!Array.isArray(records)) continue;
    const valid = pkSet(targetArray);
    if (valid.size === 0) continue; // target missing; already reported

    // Group by the missing target value so one leftover candidate produces one
    // finding with a count, not 112 identical lines.
    const broken = new Map(); // missingValue -> [pks]

    for (const rec of records) {
      if (!rec || !rec.fields || !(field in rec.fields)) continue;
      const v = rec.fields[field];
      if (v === null || v === undefined) continue;
      const n = typeof v === 'number' ? v : Number(v);
      if (!valid.has(n) && !valid.has(v)) {
        if (!broken.has(v)) broken.set(v, []);
        broken.get(v).push(rec.pk);
      }
    }

    for (const [missing, pks] of broken) {
      const shown = pks.slice(0, 8).join(', ');
      const more = pks.length > 8 ? ` ... and ${pks.length - 8} more` : '';
      const where = pks.length === 1
        ? `${arrayName} pk ${pks[0]}`
        : `${arrayName} — ${pks.length} records`;

      const base = `Field "${field}" points at ${human} ${missing}, which does not exist in ${targetArray}. `
        + `Affected pk(s): ${shown}${more}.`;

      if (severity === 'error') {
        err(where, `${base} The engine reads these rows unconditionally, so this will affect the run.`);
      } else {
        warn(where, `${base} The engine only ever looks up ${human}s that are in the matchup, so these rows are inert `
          + `and will not change a result — but they will come alive the moment ${human} ${missing} becomes playable.`);
      }
    }
  }

  /* -- cross-cutting sanity, all warnings --------------------------------- */

  const params = present.global_parameter_json?.[0]?.fields;
  const questions = present.questions_json || [];

  if (params && typeof params.question_count === 'number' && questions.length) {
    if (questions.length !== params.question_count) {
      warn(
        'global_parameter_json',
        `question_count is ${params.question_count} but questions_json holds ${questions.length} question(s). `
        + `The engine ends the game when question_number reaches question_count exactly, so a mismatch means `
        + `either unreachable questions or an early finish.`,
      );
    }
  }

  // Answers with no feedback, and feedback pointing nowhere.
  const answers = present.answers_json || [];
  const feedback = present.answer_feedback_json || [];
  if (answers.length && feedback.length) {
    const fbAnswers = new Set(feedback.map((f) => f.fields?.answer));
    const missing = answers.filter((a) => !fbAnswers.has(a.pk)).map((a) => a.pk);
    if (missing.length) {
      warn('answer_feedback_json', `${missing.length} answer(s) have no feedback record: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ' ...' : ''}. Those picks will advance with no advisor screen.`);
    }
  }

  // Questions with no answers at all — that is a dead end.
  if (questions.length && answers.length) {
    const byQuestion = new Map();
    for (const a of answers) {
      const q = a.fields?.question;
      byQuestion.set(q, (byQuestion.get(q) || 0) + 1);
    }
    for (const q of questions) {
      if (!byQuestion.has(q.pk)) {
        err(`questions_json pk ${q.pk}`, 'Question has no answers in answers_json. Reaching it would leave the game with nothing to click.');
      }
    }
  }

  // The empty-scoring-array situation. Standing note, never an error.
  const scoringArrays = ['answer_score_global_json', 'answer_score_issue_json', 'answer_score_state_json'];
  const emptyScoring = scoringArrays.filter((n) => Array.isArray(present[n]) && present[n].length === 0);
  if (emptyScoring.length === scoringArrays.length) {
    notes.push({
      where: 'answer scoring',
      msg: 'All three answer_score_* arrays are empty, so no answer changes any vote total. '
        + 'Margins are fixed by the static candidate/state data and the only run-to-run movement is RNG. '
        + 'Expected for this mod as it stands — flagged so it never surprises you when a results diff comes back empty.',
    });
  } else if (emptyScoring.length) {
    notes.push({ where: 'answer scoring', msg: `Empty: ${emptyScoring.join(', ')}. The others have records.` });
  }

  // Orphan-ish: scores for candidates that exist only in score tables.
  const candPks = pkSet('candidate_json');
  if (candPks.size) {
    const ghosts = new Set();
    for (const arrayName of ['candidate_issue_score_json', 'candidate_state_multiplier_json']) {
      for (const rec of (present[arrayName] || [])) {
        const c = rec.fields?.candidate;
        if (c != null && !candPks.has(Number(c)) && !candPks.has(c)) ghosts.add(c);
      }
    }
    // Already reported as FK errors above; this adds the why.
    if (ghosts.size) {
      notes.push({
        where: 'candidate scores',
        msg: `Score rows exist for candidate id(s) ${[...ghosts].join(', ')} that are not in candidate_json. `
          + `Harmless while nothing puts them in the matchup, but they would join the race the moment something did.`,
      });
    }
  }

  // Running mates declared but not scored.
  const rmPairs = present.running_mate_json || [];
  const rmScores = present.running_mate_issue_score_json || [];
  if (rmPairs.length && rmScores.length) {
    const scored = new Set(rmScores.map((r) => r.fields?.candidate));
    const declared = new Set(rmPairs.map((r) => r.fields?.running_mate));
    const unscored = [...declared].filter((c) => !scored.has(c));
    if (unscored.length) {
      warn('running_mate_issue_score_json', `Running mate(s) ${unscored.join(', ')} have no issue scores. Only matters if that ticket becomes playable.`);
    }
  }

  // Placeholder text — cheap to catch, easy to ship by accident.
  const placeholders = [];
  for (const [arrayName, records] of Object.entries(present)) {
    if (!Array.isArray(records)) continue;
    for (const rec of records) {
      for (const [f, v] of Object.entries(rec.fields || {})) {
        if (typeof v === 'string') {
          const t = v.trim();
          if (t === "'" || t === '"' || t === 'TODO' || t === 'TBD' || t === '...') {
            placeholders.push(`${arrayName} pk ${rec.pk} field "${f}"`);
          }
        }
      }
    }
  }
  if (placeholders.length) {
    warn('placeholder text', `${placeholders.length} field(s) still hold a bare placeholder: ${placeholders.slice(0, 12).join('; ')}${placeholders.length > 12 ? ` ... and ${placeholders.length - 12} more` : ''}.`);
  }

  // Electoral vote arithmetic.
  const states = present.states_json || [];
  const election = present.election_json?.[0]?.fields;
  if (states.length && election) {
    const totalEV = states.reduce((n, s) => n + (Number(s.fields?.electoral_votes) || 0), 0);
    const needed = Number(election.winning_electoral_vote_number);
    if (Number.isFinite(needed) && totalEV > 0) {
      const half = totalEV / 2;
      if (needed <= half) {
        warn('election_json', `winning_electoral_vote_number is ${needed} but total electoral votes are ${totalEV}; a majority would be ${Math.floor(half) + 1}. Two candidates could both clear the bar.`);
      }
      notes.push({ where: 'electoral votes', msg: `${states.length} states, ${totalEV} electoral votes total, ${needed} to win.` });
    }
  }

  return {
    errors,
    warnings,
    notes,
    newFields,
    newArrays,
    ok: errors.length === 0,
  };
}

/* ------------------------------------------------------------------ render */

export function renderReport(report) {
  const lines = [];
  const { errors, warnings, notes, newFields, newArrays } = report;

  if (newArrays.length) {
    lines.push('NEW ARRAYS — not recognised by the validator, passed through untouched:');
    for (const a of newArrays) lines.push(`  ${a.name}  (${a.count} record${a.count === 1 ? '' : 's'})`);
    lines.push('');
  }

  if (newFields.length) {
    // Group by array+field so 280 records with one new field read as one line.
    const grouped = new Map();
    for (const f of newFields) {
      const key = `${f.array}.${f.field}`;
      if (!grouped.has(key)) grouped.set(key, { ...f, count: 0, pks: [] });
      const g = grouped.get(key);
      g.count += 1;
      if (g.pks.length < 5) g.pks.push(f.pk);
    }
    lines.push('NEW FIELDS — not recognised by the validator, passed through untouched:');
    for (const g of grouped.values()) {
      lines.push(`  ${g.array} field "${g.field}"  in ${g.count} record(s), e.g. pk ${g.pks.join(', ')}  sample: ${g.sample}`);
    }
    lines.push('');
  }

  if (errors.length) {
    lines.push(`ERRORS (${errors.length}) — these will probably break the run:`);
    for (const e of errors) lines.push(`  ${e.where}\n      ${e.msg}`);
    lines.push('');
  }

  if (warnings.length) {
    lines.push(`WARNINGS (${warnings.length}):`);
    for (const w of warnings) lines.push(`  ${w.where}\n      ${w.msg}`);
    lines.push('');
  }

  if (notes.length) {
    lines.push('NOTES:');
    for (const n of notes) lines.push(`  ${n.where}\n      ${n.msg}`);
    lines.push('');
  }

  if (!errors.length && !warnings.length) lines.push('No errors, no warnings.');

  return lines.join('\n');
}
