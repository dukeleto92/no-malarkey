/* =============================================================================
 * Runner — drives the REAL engine. Reimplements nothing.
 *
 * The engine runs unmodified inside an iframe pointed at the pinned copy of
 * campaign-trail/index.html. This module does exactly what a human does, only
 * faster and without the copy-paste:
 *
 *   1. put Code 1 / Code 2 text into #codeset1 / #codeset2
 *   2. set #modSelect to "other" and click #submitMod   (engine runs Code 1)
 *   3. click #game_start, then click through the four selection screens
 *      (engine loads the base questionset, then runs Code 2 over it)
 *   4. per turn: tick the radio whose value is the answer pk, click
 *      #answer_select_button, then dismiss the advisor overlay with #ok_button
 *
 * Every simulation call — A(), randomNormal(), cyoAdventure(), nextQuestion(),
 * shuffleAnswers(), mapCache() — is upstream code. This file calls none of the
 * maths itself; it only clicks and reads.
 *
 * Two things worth knowing:
 *
 *   - Answers are selected BY PK, never by position, because questionHTML()
 *     runs shuffleAnswers() (a Fisher-Yates shuffle off Math.random). Position
 *     is not stable; pk is.
 *
 *   - The map is rendered, just parked offscreen. mapCache() calls A(2) and so
 *     consumes randomness; skipping it would desynchronise the seeded stream
 *     and break parity with the real Showcase. See rng.js for the long version.
 *
 * No mod-specific values anywhere in this file.
 * ============================================================================= */

'use strict';

import { installSeededRandom, settle } from './rng.js';

const ENGINE_PAGE = '/engine/vendor/campaign-trail/index.html';

// Parks the map offscreen instead of hiding it. display:none would give Raphael
// a zero-size container and the us-map plugin computes its scale from the
// container box, so it has to keep real dimensions.
const PARK_MAP_CSS = `
  #main_content_area {
    position: absolute !important;
    left: -20000px !important;
    top: 0 !important;
    width: 900px !important;
    height: 540px !important;
    overflow: hidden !important;
    pointer-events: none !important;
  }
  #map_container { width: 640px !important; height: 480px !important; }
  #map_footer { position: static !important; }
`;

function raf(win) {
  // rAF only ticks while the frame is actually being rendered. In a
  // backgrounded tab (or a headless/offscreen embedding) it can be throttled
  // or never fire at all, which would hang a replay forever — so fall back to
  // a short timeout. The timing is not load-bearing: every RNG-ordering
  // guarantee comes from settle(), not from which tick this resolves on.
  return new Promise((resolve) => {
    const timer = win.setTimeout(resolve, 50);
    win.requestAnimationFrame(() => {
      win.clearTimeout(timer);
      resolve();
    });
  });
}

async function waitFor(win, predicate, { timeout = 20000, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    let value;
    try {
      value = predicate();
    } catch {
      value = null;
    }
    if (value) return value;
    if (Date.now() - started > timeout) {
      throw new Error(`Timed out after ${timeout}ms waiting for ${label}.`);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => win.setTimeout(r, 25));
  }
}

/* ---------------------------------------------------------------- session */

export class GameSession {
  constructor({ mount, onEvent = () => {} }) {
    this.mount = mount;
    this.onEvent = onEvent;
    this.iframe = null;
    this.win = null;
    this.doc = null;
    this.rng = null;
    this.transcript = []; // {question, questionPk, answerPk, answerText, feedback}
  }

  log(kind, message, extra) {
    this.onEvent({ kind, message, ...extra });
  }

  /* -- boot the real page ------------------------------------------------- */

  async boot() {
    if (this.iframe) this.iframe.remove();

    const iframe = this.doc0 = document.createElement('iframe');
    iframe.className = 'engine-frame';
    // Cache-bust the page itself so a re-pin of the engine is picked up.
    iframe.src = `${ENGINE_PAGE}?t=${Date.now()}`;
    this.mount.innerHTML = '';
    this.mount.appendChild(iframe);
    this.iframe = iframe;

    await new Promise((resolve, reject) => {
      iframe.addEventListener('load', resolve, { once: true });
      iframe.addEventListener('error', () => reject(new Error('Engine page failed to load.')), { once: true });
    });

    this.win = iframe.contentWindow;
    this.doc = iframe.contentDocument;

    // The engine is ready once its own globals exist and the base JSON fetches
    // kicked off by indexCode.js have resolved.
    await waitFor(this.win, () => this.win.campaignTrail_temp && this.win.$ && this.doc.getElementById('submitMod'),
      { label: 'engine globals (campaignTrail_temp, jQuery, #submitMod)' });

    if (this.win.baseJSONPromises) {
      try {
        await Promise.all(this.win.baseJSONPromises);
      } catch {
        this.log('warn', 'Some base JSON files failed to load. The engine may misbehave; check the Network tab.');
      }
    }

    await waitFor(this.win, () => {
      const t = this.win.campaignTrail_temp;
      return t.election_json && t.election_json.length && t.temp_election_list && t.temp_election_list.length;
    }, { label: 'base election data' });

    const style = this.doc.createElement('style');
    style.id = 'harness-park-map';
    style.textContent = PARK_MAP_CSS;
    this.doc.head.appendChild(style);

    this.log('info', 'Engine booted.');
    return this;
  }

  /* -- hand the mod over the same way the loader UI does ------------------ */

  async submitMod(mod) {
    const d = this.doc;
    const set = (id, value) => {
      const el = d.getElementById(id);
      if (el) el.value = value || '';
      return Boolean(el);
    };

    if (!set('codeset1', mod.code1 && mod.code1.text)) throw new Error('#codeset1 missing from the engine page.');
    set('codeset2', mod.code2 && mod.code2.text);
    set('codeset3', mod.code3 && mod.code3.text);

    // #submitMod only takes the custom-mod path when #modSelect reads "other" —
    // and the engine reads it again, much later, in the questionset load
    // callback that decides whether to execute #codeset2. In between, the mod
    // loader's async directory refresh calls replaceChildren() on the select,
    // wiping any option we add and resetting value to "". So don't trust the
    // options list: pin the value property itself so every later read sees
    // "other" no matter how many times the loader rebuilds the options.
    const modSelect = d.getElementById('modSelect');
    if (modSelect) {
      Object.defineProperty(modSelect, 'value', {
        configurable: true,
        get: () => 'other',
        set: () => {},
      });
    }

    // The engine's own handler reads #importfile[0].value, so it must exist and
    // be empty. It is part of the real page, but guard in case that changes.
    if (!d.getElementById('importfile')) {
      const inp = d.createElement('input');
      inp.type = 'file';
      inp.id = 'importfile';
      inp.style.display = 'none';
      d.body.appendChild(inp);
    }

    const errors = [];
    const onError = (ev) => errors.push(ev.message || String(ev.error));
    this.win.addEventListener('error', onError);

    d.getElementById('submitMod').click();
    await settle(this.win);

    this.win.removeEventListener('error', onError);

    if (errors.length) {
      this.log('warn', `Code 1 raised ${errors.length} error(s) while executing: ${errors.join(' | ')}`);
    }

    const t = this.win.campaignTrail_temp;
    if (!t.candidate_json || !t.candidate_json.length) {
      throw new Error('After clicking Play Custom Mod the engine had no candidate_json. Code 1 probably threw before defining it — see the console inside the game frame.');
    }

    this.log('info', `Code 1 executed. ${t.candidate_json.length} candidates, credits "${t.credits}".`);
    return this;
  }

  /* -- click through the selection screens -------------------------------- */

  /**
   * Walks the engine's four selection screens. Any of election / candidate /
   * runningMate may be given explicitly; anything omitted takes the first
   * option the engine itself offers. Nothing is assumed about which ids those
   * are — they are read off the live <select> elements.
   */
  async startGame({ election, candidate, runningMate, difficulty, gameType } = {}) {
    const d = this.doc;
    const w = this.win;

    const clickById = async (id, label) => {
      const el = await waitFor(w, () => d.getElementById(id), { label: label || `#${id}` });
      el.click();
      await settle(w);
      return el;
    };

    const chooseFrom = async (selectId, wanted, label) => {
      const sel = await waitFor(w, () => d.getElementById(selectId), { label: label || `#${selectId}` });
      const values = [...sel.options].filter((o) => !o.disabled).map((o) => o.value);
      if (!values.length) throw new Error(`${selectId} had no selectable options.`);
      const pick = (wanted != null && values.includes(String(wanted))) ? String(wanted) : values[0];
      sel.value = pick;
      sel.dispatchEvent(new w.Event('change', { bubbles: true }));
      await settle(w);
      return { picked: pick, available: values };
    };

    await clickById('game_start', '#game_start (Click here to begin)');

    const el = await chooseFrom('election_id', election, '#election_id (year select)');
    this.log('info', `Election ${el.picked} (offered: ${el.available.join(', ')}).`);
    await clickById('election_id_button');

    const cd = await chooseFrom('candidate_id', candidate, '#candidate_id');
    this.log('info', `Candidate ${cd.picked} (offered: ${cd.available.join(', ')}).`);
    await clickById('candidate_id_button');

    const rm = await chooseFrom('running_mate_id', runningMate, '#running_mate_id');
    this.log('info', `Running mate ${rm.picked} (offered: ${rm.available.join(', ')}).`);
    await clickById('running_mate_id_button');

    if (difficulty != null) {
      const sel = d.getElementById('difficulty_level_id');
      if (sel) sel.value = String(difficulty);
    }
    if (gameType != null) {
      const sel = d.getElementById('game_type_id');
      if (sel) sel.value = String(gameType);
    }

    this.selection = {
      election: el.picked,
      candidate: cd.picked,
      runningMate: rm.picked,
      difficulty: (d.getElementById('difficulty_level_id') || {}).value ?? null,
      gameType: (d.getElementById('game_type_id') || {}).value ?? null,
    };

    return this;
  }

  /**
   * Seed and then fire the button that actually begins the run.
   *
   * Order matters. The seed goes in AFTER page load and IMMEDIATELY BEFORE the
   * begin click, because that is the only boundary you can also reproduce on
   * the real Showcase (where you paste the seed snippet into the console of an
   * already-loaded page). Seeding earlier would make local runs deterministic
   * but no longer comparable.
   */
  async begin({ seed } = {}) {
    if (seed != null) {
      this.rng = installSeededRandom(this.win, seed);
      this.log('info', `Seeded Math.random with ${this.rng.seed} (from "${this.rng.seedInput}").`);
    }

    const btn = await waitFor(this.win, () => this.doc.getElementById('opponent_selection_id_button'),
      { label: '#opponent_selection_id_button' });
    btn.click();

    // The engine loads the base questionset into #game_window and only runs
    // Code 2 in that load callback, so wait for the first question form.
    await waitFor(this.win, () => this.doc.querySelector('input[name=game_answers]'),
      { label: 'the first question (base questionset load + Code 2 execution)', timeout: 40000 });
    await settle(this.win);

    const t = this.win.campaignTrail_temp;
    this.log('info', `Game started. ${t.questions_json.length} questions, question_count ${t.global_parameter_json[0].fields.question_count}.`);
    return this;
  }

  /* -- reading current state ---------------------------------------------- */

  get temp() { return this.win.campaignTrail_temp; }

  currentQuestion() {
    const t = this.temp;
    const q = t.questions_json[t.question_number];
    return q ? { index: t.question_number, pk: q.pk, description: q.fields.description } : null;
  }

  availableAnswers() {
    const inputs = [...this.doc.querySelectorAll('input[name=game_answers]')];
    return inputs.map((inp) => {
      const label = this.doc.querySelector(`label[for="${CSS.escape(inp.id)}"]`);
      return {
        pk: Number(inp.value),
        text: label ? label.textContent.trim() : '',
        inputId: inp.id,
      };
    });
  }

  isFinished() {
    const t = this.temp;
    const count = Number(t.global_parameter_json?.[0]?.fields?.question_count);
    return Boolean(t.final_state_results) || t.question_number >= count;
  }

  /* -- one turn ----------------------------------------------------------- */

  /**
   * Answer the current question with a specific answer pk. Returns what
   * happened, including the advisor feedback text that was shown — which for a
   * CYOA mod is usually the thing you actually changed.
   */
  async answer(pk) {
    const d = this.doc;
    const w = this.win;

    const before = this.currentQuestion();
    const options = this.availableAnswers();

    const target = options.find((o) => o.pk === Number(pk));
    if (!target) {
      throw new Error(
        `Answer ${pk} is not on screen for question ${before ? before.pk : '?'}. `
        + `Available: ${options.map((o) => o.pk).join(', ') || '(none)'}.`,
      );
    }

    const input = d.getElementById(target.inputId);
    input.checked = true;
    input.dispatchEvent(new w.Event('change', { bubbles: true }));

    d.getElementById('answer_select_button').click();
    await raf(w);

    // The advisor overlay appears when answer_feedback_flg is 1. Capture the
    // text, then dismiss with the engine's own OK button so nextQuestion()
    // runs through its normal path.
    let feedback = null;
    const overlay = d.getElementById('visit_window');
    if (overlay) {
      const p = overlay.querySelector('#visit_content p');
      feedback = p ? p.textContent.trim() : null;
      const ok = d.getElementById('ok_button');
      if (ok) ok.click();
    }

    // Let the setTimeout(mapCache, 0) that nextQuestion scheduled actually run,
    // so its A(2) draws happen now rather than racing the next turn.
    await settle(w, 4);
    await raf(w);

    const entry = {
      questionIndex: before ? before.index : null,
      questionPk: before ? before.pk : null,
      answerPk: Number(pk),
      answerText: target.text,
      feedback,
    };
    this.transcript.push(entry);
    return entry;
  }

  /**
   * The engine interleaves a campaign-visit screen between questions when the
   * election has visits: a map, no answer inputs, and it only advances after a
   * state is clicked and the visit confirmed. Drive the map's own click
   * handler for one state and press the engine's YES button — the exact code
   * path a human click takes, so RNG consumption stays identical. The choice
   * of state is deterministic (first entry in states_json unless given an
   * abbr), which is all the harness needs.
   */
  async visit(abbr) {
    const d = this.doc;
    const w = this.win;
    if (!d.getElementById('map_container')) return false;
    const states = this.temp.states_json || [];
    const state = abbr ? states.find((s) => s.fields.abbr === abbr) : states[0];
    if (!state) return false;

    // The map is built by Raphael and the usmap plugin attaches its hit areas
    // over several ticks, so the container existing does not mean the map is
    // clickable yet. Triggering early is a silent no-op — wait for the plugin
    // instance and its hit areas before clicking, then wait for the engine's
    // own confirm overlay rather than assuming a fixed number of ticks.
    let inst;
    try {
      inst = await waitFor(
        w,
        () => {
          const i = w.$('#map_container').data('plugin-usmap');
          return i && i.stateHitAreas && Object.keys(i.stateHitAreas).length ? i : null;
        },
        { label: 'the visit map to finish rendering', timeout: 10000 },
      );
    } catch {
      return false;
    }
    if (!inst) return false;

    w.$('#map_container').usmap('trigger', state.fields.abbr, 'click', new w.$.Event('click'));
    let yes = null;
    try {
      yes = await waitFor(w, () => d.getElementById('confirm_visit_button'),
        { label: 'the visit confirm button', timeout: 3000 });
    } catch {
      return false; // a poll-view map, not a visit screen
    }
    yes.click();
    await settle(w, 4);
    await raf(w);
    this.log('info', `Visited ${state.fields.name} (${state.fields.abbr}).`);
    return true;
  }

  /** Play a list of answer pks in order. Stops early if the game ends. */
  async playPath(pks, { onTurn = () => {} } = {}) {
    for (const pk of pks) {
      if (this.isFinished()) break;
      if (!this.doc.querySelector('input[name=game_answers]')) {
        // eslint-disable-next-line no-await-in-loop
        if (!(await this.visit())) break;
      }
      if (!this.doc.querySelector('input[name=game_answers]')) break;
      // eslint-disable-next-line no-await-in-loop
      const entry = await this.answer(pk);
      onTurn(entry, this);
    }
    return this;
  }

  /**
   * Play forward by always taking the Nth available answer (default: the
   * first). Used by "jump to question N" when you have not supplied a path.
   * Deterministic under a seed because it selects by sorted pk, not by the
   * shuffled on-screen order.
   */
  async playAuto(turns, { pick = 0, onTurn = () => {} } = {}) {
    for (let i = 0; i < turns; i += 1) {
      if (this.isFinished()) break;
      if (!this.doc.querySelector('input[name=game_answers]')) {
        // eslint-disable-next-line no-await-in-loop
        if (!(await this.visit())) break;
      }
      const opts = this.availableAnswers();
      if (!opts.length) break;
      const sorted = [...opts].sort((a, b) => a.pk - b.pk);
      const chosen = sorted[Math.min(pick, sorted.length - 1)];
      // eslint-disable-next-line no-await-in-loop
      const entry = await this.answer(chosen.pk);
      onTurn(entry, this);
    }
    return this;
  }

  /** Play to the end, taking the first answer each turn. */
  async playToEnd({ maxTurns = 200, pick = 0, onTurn = () => {} } = {}) {
    return this.playAuto(maxTurns, { pick, onTurn });
  }

  /* -- results ------------------------------------------------------------ */

  /**
   * The engine's own final numbers. e.final_state_results is set by
   * `e.final_state_results = A(1)` inside nextQuestion() the moment
   * question_number reaches question_count — before electionNight() does any
   * animation. So we read the variable rather than sitting through the map.
   */
  finalResults() {
    const t = this.temp;
    if (!t.final_state_results) return null;

    const stateName = new Map(t.states_json.map((s) => [s.pk, s.fields.name]));
    const stateAbbr = new Map(t.states_json.map((s) => [s.pk, s.fields.abbr]));
    const stateEV = new Map(t.states_json.map((s) => [s.pk, s.fields.electoral_votes]));
    const cand = new Map(t.candidate_json.map((c) => [c.pk, `${c.fields.first_name} ${c.fields.last_name}`]));

    const states = t.final_state_results.map((row) => ({
      statePk: row.state,
      state: stateName.get(row.state) ?? String(row.state),
      abbr: stateAbbr.get(row.state) ?? '',
      electoralVotes: stateEV.get(row.state) ?? 0,
      results: (row.result || []).map((r) => ({
        candidatePk: r.candidate,
        candidate: cand.get(r.candidate) ?? String(r.candidate),
        raw: r.result,
        votes: r.votes ?? null,
        percent: r.percent ?? null,
      })),
    })).sort((a, b) => a.statePk - b.statePk);

    // National totals, computed from the engine's own per-state output.
    const totals = new Map();
    for (const st of states) {
      let best = null;
      for (const r of st.results) {
        const agg = totals.get(r.candidatePk) || { candidatePk: r.candidatePk, candidate: r.candidate, votes: 0, electoralVotes: 0 };
        agg.votes += r.votes || 0;
        totals.set(r.candidatePk, agg);
        if (!best || (r.votes || 0) > (best.votes || 0)) best = r;
      }
      if (best && st.electoralVotes > 0) {
        totals.get(best.candidatePk).electoralVotes += st.electoralVotes;
      }
    }

    const totalVotes = [...totals.values()].reduce((n, c) => n + c.votes, 0);
    const national = [...totals.values()]
      .map((c) => ({ ...c, votePercent: totalVotes ? (c.votes / totalVotes) * 100 : 0 }))
      .sort((a, b) => b.electoralVotes - a.electoralVotes || b.votes - a.votes);

    return { national, states, totalVotes };
  }
}
