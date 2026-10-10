/* Fit No Malarkey's baseline map to a counterfactual 2020.

   Usage:  node tools/baseline/fit-baseline.js            (report only)
           node tools/baseline/fit-baseline.js --write    (rewrite Code 2)

   TARGET. Each state's lean (two-party margin minus the national two-party
   margin) is its 2016 lean plus half of any rightward swing it made from
   2012 to 2016. Swings toward the Democrats are kept whole. In words:
   Biden wins back half of the Obama-Trump defectors and keeps Clinton's
   suburban gains, which is the 2016 his campaign summary describes. The
   national margin is then set so a start-of-term record against a generic
   Republican lands on TARGET_NATIONAL of the two-party vote.

   HOW. A state's lean lives in its issue scores, not in Biden's multiplier.
   For every state, one scalar L is solved by bisection so the model hits
   the target share, and the five "lean" columns are written as L plus that
   column's regional offset:

     Overall, Progressive, Health Care, Foreign Policy, Social = L + offset
     Labor, Infrastructure, Trade                              = unchanged

   Offsets are the hand-authored deviations already in the file (e.g.
   Michigan's Progressive column sat 0.30 above its lean) plus the rules in
   REGIONAL_OFFSETS below. Labor, Infrastructure and Trade were authored as
   absolute regional opinions, so they are kept as they are.

   Both candidates' state multipliers become 1.0: with the lean in the issue
   scores there is nothing left for them to correct, and a multiplier is a
   candidate's personal pull, which belongs in a nominee profile (Code 1,
   NM_GOP_ROSTER), not in the map. A state whose target cannot be reached
   inside the -0.95..0.95 lean range keeps L at the bound and takes the
   residual as a Biden multiplier; the report lists any that do.

   Also drops the score rows for candidates 302/303, 2020 third parties that
   are not in this mod. */

const fs = require("fs");
const path = require("path");
const model = require("./model");

const TARGET_NATIONAL = 0.515; // Dem two-party share, start-of-term record, Normal difficulty. 51.0 loses the EC (258 EV): this map tilts ~2 pts GOP
const LEAN_COLUMNS = [110, 111, 112, 113, 114];
const LEAN_BOUND = 0.95;

/* Regional texture added on top of the file's existing offsets. Only applied
   to a column whose existing offset is zero, so hand-tuned values win.
   Issue axes are liberal-positive; Foreign Policy is dove-positive. */
const REGIONAL_OFFSETS = [
    // Bases, shipyards and defence payrolls: hawkish relative to their lean.
    { issue: 113, offset: -0.10, states: ["VA", "NC", "GA", "TX", "FL", "AK", "HI", "SC", "CO", "WA"] },
    // Union Midwest: economically left of its lean, socially right of it.
    { issue: 111, offset: 0.10, states: ["MN", "IA", "IN", "MO", "M2"] },
    { issue: 114, offset: -0.10, states: ["MI", "OH", "PA", "WI", "IA", "MN", "M2"] },
    // ACA expansion fights 2017-2018: health care polls left of the lean
    // in the expansion-ballot states.
    { issue: 112, offset: 0.08, states: ["ME", "M1", "M2", "NV", "MT", "ID", "UT", "NE", "N1", "N2", "N3"] },
];

function twoPartyMargin([d, r]) { return (d - r) / (d + r); }

function targetLeans() {
    const res = JSON.parse(fs.readFileSync(path.join(__dirname, "results-2012-2016.json"), "utf8"));
    const n12 = twoPartyMargin(res["2012"].US), n16 = twoPartyMargin(res["2016"].US);
    const leans = {};
    for (const abbr of Object.keys(res["2016"])) {
        if (abbr === "US") continue;
        const l12 = twoPartyMargin(res["2012"][abbr]) - n12;
        const l16 = twoPartyMargin(res["2016"][abbr]) - n16;
        leans[abbr] = { l12, l16, target: l16 + 0.5 * Math.max(0, l12 - l16) };
    }
    return leans;
}

function clamp(x) { return Math.max(-LEAN_BOUND, Math.min(LEAN_BOUND, x)); }

function main() {
    const write = process.argv.includes("--write");
    const ctx = model.load();
    const t = ctx.campaignTrail_temp;
    model.setRecord(ctx, {});

    const before = model.project(ctx);
    const abbrByPk = {}, pkByAbbr = {};
    for (const s of t.states_json) { abbrByPk[s.pk] = s.fields.abbr; pkByAbbr[s.fields.abbr] = s.pk; }

    // --- offsets: existing hand deviations + regional rules ---------------
    const rows = {}; // pk -> issue -> row.fields
    for (const r of t.state_issue_score_json) (rows[r.fields.state] = rows[r.fields.state] || {})[r.fields.issue] = r.fields;
    const offsets = {};
    for (const pk of Object.keys(rows)) {
        const lean = rows[pk][110].state_issue_score;
        offsets[pk] = {};
        for (const iss of LEAN_COLUMNS) offsets[pk][iss] = +(rows[pk][iss].state_issue_score - lean).toFixed(4);
    }
    for (const rule of REGIONAL_OFFSETS) {
        for (const abbr of rule.states) {
            const pk = pkByAbbr[abbr];
            if (offsets[pk][rule.issue] === 0) offsets[pk][rule.issue] = rule.offset;
        }
    }

    // --- multipliers: 1.0 for both candidates, drop the dead third parties -
    t.candidate_state_multiplier_json = t.candidate_state_multiplier_json.filter((r) => r.fields.candidate === 300 || r.fields.candidate === 301);
    for (const r of t.candidate_state_multiplier_json) r.fields.state_multiplier = 1;
    t.candidate_issue_score_json = t.candidate_issue_score_json.filter((r) => r.fields.candidate === 300 || r.fields.candidate === 301);
    const bidenMult = {};
    for (const r of t.candidate_state_multiplier_json) if (r.fields.candidate === 300) bidenMult[r.fields.state] = r;

    function setLean(pk, L) {
        for (const iss of LEAN_COLUMNS) rows[pk][iss].state_issue_score = +clamp(L + offsets[pk][iss]).toFixed(4);
    }
    function shareAt(pk, L) {
        setLean(pk, L);
        return model.project(ctx).states[abbrByPk[pk]].share;
    }

    // --- solve each state's L for a given national margin ------------------
    const leans = targetLeans();
    function solveAll(nationalMargin) {
        const residual = [];
        for (const pk of Object.keys(rows)) {
            const abbr = abbrByPk[pk];
            const want = 0.5 + (nationalMargin + leans[abbr].target) / 2;
            let lo = -LEAN_BOUND, hi = LEAN_BOUND;
            bidenMult[pk].fields.state_multiplier = 1;
            const sLo = shareAt(pk, lo), sHi = shareAt(pk, hi);
            if (want <= sLo || want >= sHi) {
                // Out of the issue model's reach: park L at the bound, solve the multiplier.
                const L = want <= sLo ? lo : hi;
                setLean(pk, L);
                const s = model.project(ctx).states[abbr].share;
                const m = (want / (1 - want)) / (s / (1 - s));
                bidenMult[pk].fields.state_multiplier = +m.toFixed(4);
                residual.push(abbr + " x" + m.toFixed(3));
                continue;
            }
            for (let i = 0; i < 40; i++) {
                const mid = (lo + hi) / 2;
                if (shareAt(pk, mid) < want) lo = mid; else hi = mid;
            }
            setLean(pk, (lo + hi) / 2);
        }
        return residual;
    }

    // Outer loop: find the national margin that lands TARGET_NATIONAL.
    let nm = 2 * TARGET_NATIONAL - 1, residual = [];
    for (let k = 0; k < 6; k++) {
        residual = solveAll(nm);
        const got = model.project(ctx).national;
        nm += 2 * (TARGET_NATIONAL - got);
        if (Math.abs(TARGET_NATIONAL - got) < 0.0002) break;
    }
    const after = model.project(ctx);

    // --- report ------------------------------------------------------------
    const pct = (s) => (100 * (2 * s - 1)).toFixed(1).padStart(6);
    console.log("Start-of-term record vs generic Republican, Normal difficulty\n");
    console.log("        before   after   (D margin, two-party)");
    console.log("Nation " + pct(before.national) + "  " + pct(after.national));
    console.log("EV     " + String(before.demEV).padStart(6) + "  " + String(after.demEV).padStart(6) + "\n");
    const order = Object.values(after.states).sort((a, b) => b.share - a.share);
    let cum = 0, tipping = null;
    for (const s of order) { cum += s.ev; if (!tipping && cum >= 270) tipping = abbrByPk[s.pk]; }
    console.log("abbr  EV  before   after   L     note");
    for (const s of order) {
        const abbr = abbrByPk[s.pk];
        if (Math.abs(s.share - 0.5) > 0.12 && !["WV", "VT", "DC", "WY"].includes(abbr)) continue;
        const L = rows[s.pk][110].state_issue_score;
        console.log(abbr.padEnd(4) + String(s.ev).padStart(4) + pct(before.states[abbr].share) + "  " + pct(s.share) + "  " + L.toFixed(3).padStart(6) + (abbr === tipping ? "  <- tipping point" : ""));
    }
    console.log("\n(states more than 24 pts from even omitted, apart from the extremes)");
    console.log("Multiplier residuals (target outside the issue model's reach): " + (residual.join(", ") || "none"));

    if (!write) { console.log("\nReport only. Re-run with --write to update Code 2."); return; }

    const file = path.join(model.ROOT, "Code 2");
    let src = fs.readFileSync(file, "utf8");
    for (const name of ["state_issue_score_json", "candidate_issue_score_json", "candidate_state_multiplier_json"]) {
        const b = model.arrayBounds(src, name);
        src = src.slice(0, b.start) + JSON.stringify(t[name], null, 4) + src.slice(b.end);
    }
    fs.writeFileSync(file, src);
    console.log("\nWrote Code 2.");
}

main();
