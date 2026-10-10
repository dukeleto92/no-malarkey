/* Deterministic replica of the engine's vote maths, run against the real
   mod files.

   Loads `Code 1` and `Code 2` into a Node VM exactly as the browser would
   (Code 1 first, then Code 2's data), so nmElectorate / nmSyncElectorate
   are the mod's own functions, not copies. Then `project()` reproduces
   A() from playtest/engine/vendor/static/js/campaign_trail.js for a
   two-candidate race with every random draw at its mean (the engine's
   noise is three multiplicative N(1, 0.01) factors, so the expectation is
   what we want for fitting).

   What it deliberately leaves out: campaign visits (+0.005 x multiplier per
   visit, player agency, not baseline) and the 0.95-1.05 turnout jitter. */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..", "..");
const NORMAL_DIFFICULTY = 0.97; // engine default selection ("Normal")
const CARRIER_ANSWER = 8011;    // any Q1 answer: nmSyncElectorate hangs rows off player_answers[0]

function arrayBounds(src, name) {
    const marker = "campaignTrail_temp." + name + " = ";
    const at = src.indexOf(marker);
    if (at < 0) throw new Error("no " + name + " in source");
    const start = at + marker.length;
    const end = src.indexOf("\n]", start) + 2; // first column-0 bracket closes the array
    return { start, end };
}

function load() {
    const c1 = fs.readFileSync(path.join(ROOT, "Code 1"), "utf8");
    const c2 = fs.readFileSync(path.join(ROOT, "Code 2"), "utf8");
    const any = new Proxy(function () {}, {
        get: (t, k) => (k === Symbol.toPrimitive ? () => "" : any),
        apply: () => any,
        construct: () => any,
    });
    const ctx = {
        campaignTrail_temp: {},
        console: { log() {}, warn() {}, error() {}, info() {} },
        setInterval() {}, setTimeout() {}, clearInterval() {},
        MutationObserver: function () { return { observe() {}, disconnect() {} }; },
    };
    ctx.window = ctx; ctx.document = any; ctx.$ = any; ctx.jQuery = any;
    vm.createContext(ctx);
    vm.runInContext(c1, ctx, { filename: "Code 1" });
    vm.runInContext(c2.slice(0, c2.indexOf("campaignTrail_temp.jet_data")), ctx, { filename: "Code 2" });
    const t = ctx.campaignTrail_temp;
    t.candidate_id = 300;
    t.opponents_list = [301];
    t.player_answers = [CARRIER_ANSWER];
    t.difficulty_level_multiplier = NORMAL_DIFFICULTY;
    ctx.nmInitial = JSON.parse(JSON.stringify(ctx.nm));
    return ctx;
}

// Put `nm` back to the start-of-term record, then apply overrides.
function setRecord(ctx, overrides) {
    const fresh = JSON.parse(JSON.stringify(ctx.nmInitial));
    for (const k of Object.keys(ctx.nm)) delete ctx.nm[k];
    Object.assign(ctx.nm, fresh, overrides || {});
    ctx.nmSyncElectorate();
}

/* A(), two candidates, noise at its mean. Returns per-state Dem share of the
   two-candidate vote plus national totals. */
function project(ctx) {
    const e = ctx.campaignTrail_temp;
    const gp = e.global_parameter_json[0].fields;
    const vv = gp.vote_variable, cw = gp.candidate_issue_weight, rw = gp.running_mate_issue_weight;
    const player = e.candidate_id, matchup = [player].concat(e.opponents_list);
    const answers = new Set(e.player_answers);

    // global multipliers
    const gm = matchup.map((c) => {
        let cum = 0;
        for (const r of e.answer_score_global_json) {
            const f = r.fields;
            if (answers.has(f.answer) && f.candidate === player && f.affected_candidate === c) cum += f.global_multiplier;
        }
        const base = (c === player && cum < -0.4) ? 0.6 : 1 + cum;
        return c === player ? base * e.difficulty_level_multiplier : base;
    });

    // issue stances (candidate blend + running mate + answer rows), in candidate's own order
    const agg = new Map();
    for (const r of e.answer_score_issue_json) {
        const f = r.fields;
        if (!answers.has(f.answer) || f.state != null) continue;
        const key = (f.candidate || player) + "|" + f.issue;
        const a = agg.get(key) || { g: 0, b: 0 };
        a.g += f.issue_score * f.issue_importance; a.b += f.issue_importance;
        agg.set(key, a);
    }
    const rmByIssue = new Map(e.running_mate_issue_score_json.map((x) => [x.fields.issue, x.fields.issue_score]));
    const stances = matchup.map((c) => {
        const seen = new Set();
        return e.candidate_issue_score_json
            .filter((r) => r.fields.candidate === c && !seen.has(r.fields.issue) && seen.add(r.fields.issue))
            .map((r) => {
                const issue = r.fields.issue, a = agg.get(c + "|" + issue) || { g: 0, b: 0 };
                const hasAgg = [...agg.keys()].some((k) => k.startsWith(c + "|"));
                if (c !== player && !hasAgg) return { issue, score: r.fields.issue_score };
                const rm = c === player ? rmByIssue.get(issue) : 0, w = c === player ? rw : 0;
                return { issue, score: (r.fields.issue_score * cw + rm * w + a.g) / (cw + w + a.b) };
            });
    });

    const mult = new Map(); // cand|state -> multiplier
    for (const r of e.candidate_state_multiplier_json) mult.set(r.fields.candidate + "|" + r.fields.state, r.fields.state_multiplier);
    const stateAdd = new Map();
    for (const r of e.answer_score_state_json) {
        const f = r.fields;
        if (f.candidate !== player || !answers.has(f.answer)) continue;
        const k = f.affected_candidate + "|" + f.state;
        stateAdd.set(k, (stateAdd.get(k) || 0) + f.state_multiplier);
    }
    const sis = new Map();
    for (const r of e.state_issue_score_json) {
        if (!sis.has(r.fields.state)) sis.set(r.fields.state, new Map());
        const m = sis.get(r.fields.state);
        if (!m.has(r.fields.issue)) m.set(r.fields.issue, r.fields);
    }

    const out = { states: {}, demVotes: 0, gopVotes: 0, demEV: 0, gopEV: 0 };
    for (const st of e.states_json) {
        const s = st.pk;
        const scores = matchup.map((c, idx) => {
            let sm = mult.get(c + "|" + s);
            if (sm == null) return 0;
            sm = sm * gm[idx] + (stateAdd.get(c + "|" + s) || 0);
            if (idx === 0 && e.running_mate_state_id === s) sm += 0.004 * sm;
            let score = 0;
            const mine = stances[idx], ref = stances[0];
            for (let i = 0; i < mine.length; i++) {
                const f = sis.get(s) && sis.get(s).get(ref[i] && ref[i].issue);
                const E0 = f ? f.state_issue_score : 0, w = f ? f.weight : 1;
                const S = mine[i].score * Math.abs(mine[i].score), E = E0 * Math.abs(E0);
                score += vv - Math.abs((S - E) * w);
            }
            return Math.max(score * sm, 0);
        });
        const share = scores[0] / (scores[0] + scores[1]);
        const ev = st.fields.electoral_votes, pv = st.fields.popular_votes;
        out.states[st.fields.abbr] = { pk: s, share, ev, pv };
        out.demVotes += share * pv; out.gopVotes += (1 - share) * pv;
        if (share > 0.5) out.demEV += ev; else out.gopEV += ev;
    }
    out.national = out.demVotes / (out.demVotes + out.gopVotes);
    return out;
}

module.exports = { load, setRecord, project, arrayBounds, ROOT };
