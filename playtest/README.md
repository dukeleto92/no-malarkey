# No Malarkey — local playtest harness

Edit a mod file, refresh the browser, see the change. No upload, no build step.

The game you play here is the **real Campaign Trail Showcase engine**, unmodified,
running from a pinned copy in `engine/vendor/`. Nothing about the simulation is
reimplemented. The harness fills in the Custom Mod Loader boxes for you, clicks
through the selection screens, and adds validation, seeding, jumping, and result
dumps around the outside.

---

## Start it

```sh
cd playtest
./start.sh
```

That is the whole thing. It starts a local server on `http://127.0.0.1:8730/`
and opens your browser. `Ctrl-C` stops it.

Different port:

```sh
PORT=8731 ./start.sh
```

Requires Node (`brew install node`). The first launch needs an internet
connection, because the engine's own page pulls jQuery and jQuery UI from a CDN
and Montserrat from Google Fonts. After that the browser caches them and you can
work offline.

---

## Where mod files go

The harness looks for a folder containing **both** a file named `Code 1` and a
file named `Code 2`. It checks the project folder and every immediate subfolder
of it.

Your existing files are already found — they sit in the project root and show up
as the mod `No Malarkey`. Nothing was moved or renamed.

To add a second mod, make a subfolder next to them:

```
No Malarkey/
├── Code 1              <- current mod, found automatically
├── Code 2
├── playtest/           <- this harness
└── 1976 Reagan/        <- a second mod
    ├── Code 1
    └── Code 2
```

Restart is not needed — the folder list is re-read on every page load. A `Code 3`
(the loader's ENDINGS CODE box) is picked up if present and ignored if not.

**Your mod files are never written to.** The server has no route that writes to
them; the only thing it writes is `runs/`.

---

## Using it

The left panel is the harness. The right side is the real game.

**Reload & validate** re-reads the files off disk and re-runs validation.
Plain browser refresh does the same thing.

**Start run** boots the engine, hands it your mod, and clicks through to the
first question. Then play in the Game tab as normal.

**Seed** is on by default and fixed at `1`. Every run with the same seed and the
same answers produces the same numbers, so a changed result means you changed
something. Untick *Deterministic* for live RNG.

**Answer path** replays a specific sequence of answer pks through the real
engine — tallies, RNG, and feedback all real, nothing faked. This is the precise
way to reach one outcome.

```
8012, 8022, 8052, 8071, 8081, 8091, 8102
```

**Jump to question #** plays forward taking the lowest-pk answer each turn until
it reaches that question. Convenient but blunt; a path is better when the
outcome depends on the tallies you accumulated getting there.

**Play to end** finishes the run. **Dump results** writes
`runs/<name>.json`.

URL parameters do the same things, which is handy for bookmarking a case:

```
http://127.0.0.1:8730/?mod=No%20Malarkey&seed=1&path=8012,8022,8052
http://127.0.0.1:8730/?seed=random
http://127.0.0.1:8730/?q=7
```

### Diffing runs

```sh
diff runs/before.json runs/after.json
```

Dumps are built for this: keys sorted at every level, floats rounded to 6 places,
and **no timestamps anywhere in the body**, so the only lines that move are lines
that actually changed. Each dump records the seed, the engine commit, and the
byte sizes of the Code files that produced it — a diff between runs with
different seeds or different engine commits is not telling you about your edit.

The dump leads with the narrative (answer path, per-turn answer text, the advisor
feedback that was shown, and any mod state object found on the game window),
because with all three `answer_score_*` arrays empty that is the part your edits
move. Vote totals follow underneath.

---

## Validation

Runs automatically on load. The rule is:

- **Unknown things are warnings.** A field the validator has never seen produces
  a `NEW FIELD` warning naming the array, the field, the record count and a
  sample value. A whole new fixture array produces a `NEW ARRAY` warning. Neither
  ever blocks you. Add mechanics freely.
- **Known-required things missing or malformed are errors**, named by
  array, pk, field, what was found and what was expected.
- **Dangling foreign keys** are errors *only where the engine actually reads the
  row.* Where the engine indexes a table and only looks up ids in the matchup —
  `candidate_issue_score`, `candidate_state_multiplier`, `answer_feedback.candidate` —
  a dangling reference is inert and is reported as a warning instead. Those
  classifications were checked against upstream, and the line references are in
  the comments in `harness/validate.js`.
- **Errors never block.** You get the full report and can still start the run.

Repeated findings are grouped. One leftover candidate id across 112 score rows is
one warning with a count, not 112 lines.

### What it says about your mod today

Zero errors, six warnings:

- Score rows for candidates `302` and `303`, which are not in `candidate_json`
  (5 + 5 issue scores, 56 + 56 state multipliers). Almost certainly leftovers
  from the base 2020 scenario. Inert — the engine filters them out — but they
  would join the race the moment something added those candidates.
- Running mate `309` has no issue scores while `308` has all five.
- Ten fields still hold a bare `'` placeholder, across candidates 301, 308, 309.
- A standing note that all three `answer_score_*` arrays are empty, so no answer
  moves a vote and a results diff will legitimately come back empty.

---

## Parity check

Confirms your local results still match the real Showcase.

```
http://127.0.0.1:8730/harness/parity.html
```

Pick the mod, leave the seed at `1`, press **Run parity check**. It plays one
fixed scenario end to end and prints the engine commit, the seed, the file sizes,
the answer path, the number of random draws, and the full national and per-state
results as fixed-width text.

To get the matching run out of the real Showcase, expand *How to produce the
matching run on the real Showcase* on that page. Showcase does not seed its RNG,
so you have to seed it yourself: open the Showcase site, open the browser
console, paste the snippet the page gives you, **then** paste your Code 1 and
Code 2 into the Custom Mod Loader and play the same answer path.

The snippet seeds *after* page load, and so does the harness — deliberately, at
exactly the same point in the lifecycle. That shared boundary is what makes the
two runs comparable. The snippet's generator is byte-for-byte the same algorithm
as `harness/rng.js`; that equivalence is verified for several seeds.

---

## When things break

### Results stopped matching Showcase

Work down this list. It is ordered by how often each one is the cause.

**1. You looked at the electoral map in one run but not the other.**
This is the big one and it is not obvious. `mapCache()` calls `A(2)`, and `A(2)`
draws randomness — `randomNormal()` per candidate per state, plus one
`Math.random()` per state. So does the "Latest Polls/Electoral Map" button, and
so does "resume questions". Any extra look at the map consumes part of the
random stream and shifts every number after it. Compare runs where you clicked
exactly the same things.

**2. The seed was not actually applied on the Showcase side.**
Paste the snippet *before* loading the mod, and check the console printed
`Seeded with ...`. If you loaded the mod first, the draws during loading came
from the browser's RNG and the streams are already apart. Reload and start over.

**3. The answer path differed.**
Compare the `PATH` line from the parity output against what you actually clicked
on Showcase. One different answer changes the branch and every draw after it.
Note that `questionHTML()` shuffles answers with `shuffleAnswers()`, so the
on-screen order differs between runs — the harness selects by pk for exactly
this reason, but a human clicking on Showcase can easily pick a different pk than
intended.

**4. Difficulty differed.**
The player's global multiplier is scaled by `difficulty_level_multiplier`. Normal
is `0.97`. The parity output prints the difficulty it used; make Showcase match.

**5. The engine commit differs.**
`engine/VERSION` records what is pinned here. Showcase deploys continuously, so
if upstream changed the maths your local numbers are correct for the pinned
commit and Showcase's are correct for theirs. See below.

**6. Draw counts diverge.**
The parity output prints `random draws`. If two runs that should match have
different draw counts, the streams desynchronised — that is almost always cause
1 or 3. Note `randomNormal()` is Box-Muller with rejection sampling, so it
consumes a *variable* number of values per call; equal draw counts are a good
sign but not proof.

**7. You edited a file mid-run.**
The mod is read once at Start run. Editing after that changes nothing until you
reload. The file sizes and mtimes in the left panel and in every dump tell you
which bytes the run actually used.

### The upstream engine changed

Nothing here auto-updates, which is deliberate — the pin is what makes results
reproducible. To move to a newer engine:

```sh
# 1. what is pinned now
cat engine/VERSION

# 2. confirm your copy is unmodified before you replace it
cd engine/vendor && shasum -a 256 -c ../MANIFEST.sha256 ; cd ../..

# 3. baseline: run the parity check and save it
#    open /harness/parity.html, press Run, then Save to runs/
#    then:  mv runs/parity.json runs/parity-OLD-ENGINE.json

# 4. fetch upstream
git clone --depth 1 https://github.com/campaign-trail-showcase/campaign-trail-showcase.github.io /tmp/cts-new
cd /tmp/cts-new && git rev-parse HEAD    # note this SHA

# 5. replace the vendored files, keeping the same layout
cd /path/to/No\ Malarkey/playtest
rm -rf engine/vendor
mkdir -p engine/vendor
cd /tmp/cts-new
tar cf - --exclude=.git \
  campaign-trail/index.html static/js static/css \
  static/amusa_main_2016032801.css static/json/election.json \
  static/json/candidate.json static/json/running_mate.json \
  static/json/opponents.json static/json/election_list.json \
  static/questionset/2020_Biden_Bass.html ajax.googleapis.com \
  | (cd /path/to/No\ Malarkey/playtest/engine/vendor && tar xf -)

# 6. regenerate the checksum manifest
cd /path/to/No\ Malarkey/playtest/engine/vendor
find . -type f | LC_ALL=C sort | xargs shasum -a 256 > ../MANIFEST.sha256

# 7. update engine/VERSION by hand with the new SHA and date

# 8. run the parity check again and diff against the baseline
diff runs/parity-OLD-ENGINE.json runs/parity.json
```

If step 8 shows differences, upstream changed the simulation. That is
information, not a bug — decide whether you want it. If you don't, `git checkout`
the old `engine/` back.

Things most likely to break on a re-pin, and where to look:

- **The questionset filename.** The engine resolves it through
  `baseScenarioDict` in `static/js/campaign_trail.js`. If the 2020 entry changes
  from `2020_Biden_Bass.html`, vendor whatever it now points at instead — you
  will see a 404 for the questionset and the game will hang before the first
  question.
- **Selection-screen element ids.** `harness/runner.js` clicks `#game_start`,
  `#election_id_button`, `#candidate_id_button`, `#running_mate_id_button`,
  `#opponent_selection_id_button`, `#answer_select_button`, `#ok_button`, and
  reads `input[name=game_answers]`. A rename shows up as a clear timeout naming
  the element it waited for.
- **The custom-mod code path.** Today `#submitMod` takes the custom path only
  when `#modSelect` reads `"other"`, and Code 2 is read from `#codeset2` inside
  the `$("#game_window").load()` callback. If that restructures, `runner.js`
  `submitMod()` is the place to adjust.
- **`answer_feedback_flg`.** Comes from the base questionset, not from your
  Code 2. If advisor feedback stops appearing, check the questionset still sets
  it to `1`.

### Other symptoms

**"No mods found"** — the server is looking for a folder holding both `Code 1`
and `Code 2` exactly (with the space, no extension). It prints where it looked on
startup.

**Game frame is blank** — open the browser console. Errors from inside the frame
show up there. A throw in Code 1's styling block (roughly lines 201–260) will
stop the rest of Code 1, including `cyoAdventure`.

**Validation reports a pre-flight throw but the game runs fine** — that is
expected and harmless. Pre-flight runs your code against a stub browser to
validate the data before the game starts; the styling block often throws there
because it wants real DOM. It is only a lead if the game *also* fails.

**"Ran out of clickable answers without reaching the end"** — a CYOA jump
overshot. Election night fires only when `question_number` equals
`question_count` exactly, so a jump past it hangs. Check the last
`campaignTrail_temp.question_number = ...` you set; remember the engine
increments *after* `cyoAdventure` runs, so a jump to index X is written `X - 1`.

**Port already in use** — `PORT=8731 ./start.sh`.

**Dump failed to write** — the harness falls back to a browser download so the
dump is never lost. Check the server terminal for the reason.

---

## Layout

```
playtest/
├── start.sh                one command
├── server.js               static server + mod discovery + dump writing
├── README.md
├── engine/
│   ├── VERSION             pinned commit, and why the base questionset matters
│   ├── MANIFEST.sha256     checksums, to prove the copy is unmodified
│   └── vendor/             VERBATIM upstream. Never edit.
├── harness/
│   ├── index.html          the harness page
│   ├── app.js              UI wiring
│   ├── runner.js           drives the real engine (clicks; no simulation)
│   ├── validate.js         forward-compatible validator
│   ├── loader.js           reads mod files; sandbox for pre-flight validation
│   ├── rng.js              seeded Math.random, and why ordering matters
│   ├── dump.js             diff-stable result dumps
│   ├── parity.html         the parity check
│   └── harness.css
└── runs/                   result dumps land here
```

Three things kept apart on purpose: **`engine/`** is upstream and untouched,
**your mod files** stay where they were in the project root, and **`harness/`**
is the only code written for this. The harness contains no mod-specific values —
no election id, no candidate pks, no question count, no year. Everything on
screen is read from whatever mod was just loaded, which is why a second mod needs
no code changes.

## Caching

You should never need to hard-reload.

- Mod files are served `no-store, no-cache, must-revalidate, max-age=0` with an
  ETag derived from mtime and size, and fetched with `cache: 'no-store'`.
- The harness's own files are served the same way, so editing the harness also
  takes effect on plain refresh.
- The game page is loaded with a cache-busting query parameter each time.
- Only `engine/vendor/` is allowed to cache, because it is pinned and does not
  change without a deliberate re-pin.

The left panel shows the byte size and modification time of the exact files that
were loaded. If those do not match what you just saved, something is wrong —
that display is there so you never have to wonder.

## First real-browser run

The harness was originally only verified statically, and the first run in an
actual browser turned up four things that static checking could not have caught.
All four are fixed; they are recorded here because each one failed *silently*
rather than with a useful error.

- **`/` served the harness page but not its assets.** The root path returned
  `harness/index.html` directly, so the page's relative `app.js` and
  `harness.css` resolved against `/` and 404'd. The page rendered unstyled and
  dead. `/` now redirects to `/harness/`.
- **`#modSelect` was reset after we set it.** The engine re-reads that select
  much later, in the questionset load callback that decides whether to run Code
  2 — and in between, the mod loader's async directory refresh calls
  `replaceChildren()` on it, wiping the option we added. Code 2 was silently
  skipped, so the game ran the *base* 2020 scenario while the panel happily
  reported the mod loaded. The value is now pinned via a property getter.
- **`requestAnimationFrame` never fires in a background frame.** The replay hung
  forever waiting on it. `raf()` now races rAF against a short timeout.
- **Campaign-visit screens were never dismissed.** With `has_visits` on, the
  engine puts a map between questions that only advances once a state is clicked
  and the visit confirmed; the replay just stopped. `visit()` now drives the
  map's own click handler, waiting for the usmap plugin to finish attaching its
  hit areas first — the container existing does not mean the map is clickable.

One quirk that is **not** a bug: while a run is in progress the browser may
throttle the game iframe's timers if the tab is not painting, which makes turns
crawl. Keep the tab visible.
