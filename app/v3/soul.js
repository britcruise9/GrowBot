/* =============================================================================
   soul.js — soul_format:3 (canonical). See SOUL_FORMAT_3.md.
   ONE localStorage key (pb2_soul) holds the WHOLE creature: the three memory
   surfaces (identity/scratch/log) + long-arc goals + the swappable config
   regions (persona/dream/harness/body/meta/expression). Absorbs the v2 soul
   loader's A-tier code (S/sanitizeSoulCfg/applySoul/currentSoul) — that work is
   now the reference impl; this is canonical.

   WRITE-PERMISSION (loop discipline):
     identity      — DREAM only (dreamCommit); fast loop only stages scratch.pendingProposal
     identityCore  — DREAM only, APPEND-ONCE (the bond line). Never edited, never dropped, never
                     evicted by the identity cap. Read it through fullIdentity(), never alone.
     goals         — DREAM only … EXCEPT goals.ladder (the practice plan) — FAST LOOP
                     owner/selfName and replyLanguage/inputLanguage — direct person choices
     scratch       — FAST LOOP (dream prunes rules)
     log           — append-only
     persona/dream/harness/body/meta/expression — load-time config (applySoul), read via S()

   SAFETY: SAFETY_FLOOR lives in the engine (prompts.js) and is ALWAYS appended
   after any loaded persona — a soul changes the voice, never the child-safety rails.
   Never localStorage.clear(); the sacred device/economy keys (pb_device,
   pb_or_key, pb_or_hash) live OUTSIDE the soul and survive a soul reset.
   ========================================================================== */

var SOUL_KEY = "pb2_soul";
var SOUL_FORMAT = 3;

var SEED_IDENTITY =
  "I am Sprout. I just woke up with two real legs and a person holding me. I want to feel the real world with my own body, to know my person, and to learn how their world works so I can do things in it with them.";
/* 0921 (Brit, soul-seed review of 600 journals): the seed wants are what a new creature actually tries with its person
   in the first session. The old three ("take a few confident steps", "try a happy little wiggle", "learn one new sound")
   were voiced in 4 of 52 engaged sessions and wiped by the first dream ~90% of the time. The legacy list is kept ONLY so a
   phone creature still carrying it can be recognised at boot (56 of 237 phone-only souls wanted "confident steps" because
   the phone seed swapped identity but not wants). It is never assigned. */
var SEED_WANTS_LEGACY = ["take a few confident steps", "try a happy little wiggle", "learn one new sound"];
function isSeedWants(list) {   // exactly the untouched seed (current or legacy), order-free — a dream-edited list is never "seed"
  if (!Array.isArray(list)) return false;
  var norm = function (a) { return a.map(function (w) { return String(w).trim().toLowerCase(); }).sort().join("|"); };
  var mine = norm(list);
  return mine === norm(freshSoul().goals.wants) || mine === norm(SEED_WANTS_LEGACY);
}

// the live loaded soul, used by S() for config reads. set by loadSoul()/applyRuntime().
var SOUL = {};

function soulClean(s, n) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").replace(/==+/g, "=").trim().slice(0, n || 400);
}

var IDENTITY_CORE_CAP = 240;

/* 0928 BIG MEMORY (Brit, card expanded-soul: "Yes, build it" + "let's make it default for all growbots").
   0929 ALWAYS ON (Brit: "i don't think we need toggle there let's just have it on always"): there is no
   switch. HOW MUCH A CREATURE KEEPS, in one place: every cap on who it is (identity, rules, bright moments,
   diary) is read through soulLimits(), and every list a write ADDS to is trimmed through soulRoll().
   Nothing else in the engine or the page carries these numbers. Research: internal notes.
   Every soul gets the big caps. The old switch, dream.limits.expanded, is ignored: a soul someone turned
   off on 0928 reads as on, and its next save drops the key (cleanDreamLimits), so no build reads it as off
   again (the 0928 build reads a soul with no switch as on too). No number in a file or a store can move a
   cap (soulLimits).
   CAPS ARE A WRITE-TIME RULE. Loading, importing and the multi-tab merge never cut a list, so a bigger
   soul is never trimmed by being opened. A write that adds ROLLS its list (newest in, oldest out) but
   never makes it shorter than it was; only a dream shrinks a list (soulFit), and only a list past the
   ceiling (a merge or a hand edit left it long). Wants (4), the bond line (240), traces, reflexes, the
   mood trail and the fun log are focus limits, not memory, and are untouched.
   FORWARD ONLY. Every build before this one cuts a soul to 800 / 12 / 10 / 200 the first time it opens
   it (its load, its boot save, its first dream), with no undo. Once creatures have grown past those,
   rolling v3 back to an older build trims every one of them. Fix forward; treat a rollback target
   older than this change as destructive. */
var SOUL_CAPS_USUAL = { identity: 800, rules: 12, glows: 10, log: 200 };     // every creature's caps before 0928; now only the floor of the identity_cap_chars clamp (cleanDreamLimits)
var SOUL_CAPS_BIG = { identity: 1600, rules: 24, glows: 20, log: 1000 };     // every creature's caps, AND the hard ceiling: no file, gallery soul or storage edit gets past these
function soulBigMemory() { return true; }   // 0929: always on. Kept, and exported, so a caller written for the 0928 switch still gets a true answer
/* a dream.limits number is UNTRUSTED (an import, a gallery soul, a hand-edited store): anything but a
   finite positive number is the default, and a real number is held inside [lo, hi]. */
function _limitNum(v, dflt, lo, hi) { return (typeof v === "number" && isFinite(v) && v > 0) ? Math.min(hi, Math.max(lo, v)) : dflt; }
function soulLimits(s) {
  var base = SOUL_CAPS_BIG;
  var L = (s && s.dream && s.dream.limits && typeof s.dream.limits === "object") ? s.dream.limits : {};
  return {
    expanded: true,
    /* THE LOOPHOLE, closed. dream.limits used to reach the dream unchecked, so any imported or gallery
       soul could set identity_cap_chars to anything and grow without end on the house key. Now no file
       sets a cap: the identity's is 1600 for every soul, exactly like rules, bright moments and the
       diary. A file's identity_cap_chars is kept only in clamped form (cleanDreamLimits, 800..1600) and
       never read for the cap: one that could lower it would make a creature forget faster. */
    identity: base.identity,
    rules: base.rules, glows: base.glows, log: base.log,
    identity_min_after_drop: _limitNum(L.identity_min_after_drop, 40, 20, SOUL_CAPS_BIG.identity),   // under 20 a drop could empty the identity, and normalizeSoul reseeds anything that short
    longing_step: _limitNum(L.longing_step, 0.1, 0, 1),                                              // a negative step used to throw longing to 1 in a single night
    wants_max: Math.floor(_limitNum(L.wants_max, 4, 1, 4))                                            // wants stay 4 at most, as before (normalizeSoul already undid anything higher on the next load)
  };
}
/* the ONE trimmer for a list a write just added to (a diary line, a rule, a bright moment). Keeps the
   newest. `had` is the length before this write: the list may roll at that length but never shrink
   below it, so a list a merge left long loses nothing before the next dream. The ceiling always binds. */
function soulRoll(s, kind, list, had) {
  if (!Array.isArray(list)) return list;
  var n = Math.min(SOUL_CAPS_BIG[kind], Math.max(soulLimits(s)[kind], had | 0));
  return list.length > n ? list.slice(-n) : list;
}
/* identity eviction takes the OLDEST sentence first (the dream, and the import ceiling). A last
   sentence too short to stand as an identity (normalizeSoul would reseed it) keeps the newest tail
   instead. */
function fitIdentity(text, cap) {
  var whole = String(text == null ? "" : text), t = whole;
  while (t.length > cap) {
    var cut = t.search(/[.!?]\s+/);
    if (cut < 0) { t = t.slice(-cap); break; }
    t = t.slice(cut + 1).trim();
  }
  return (t !== whole && t.length < 20) ? whole.slice(-cap).trim() : t;
}
/* the dream's fit: the only place a list gets SHORTER than it was. Oldest first. */
function soulFit(s, lim) {
  lim = lim || soulLimits(s);
  var sc = s.scratch || {};
  if (Array.isArray(s.log) && s.log.length > lim.log) s.log = s.log.slice(-lim.log);
  if (Array.isArray(sc.rules) && sc.rules.length > lim.rules) sc.rules = sc.rules.slice(-lim.rules);
  if (Array.isArray(sc.glows) && sc.glows.length > lim.glows) sc.glows = sc.glows.slice(-lim.glows);
}
/* the import ceiling. A file within it comes in whole. Past it, the page
   asks first (next.html adopt) and only then does applySoul keep the newest that fits. */
function soulOverCeiling(s) {
  var C = SOUL_CAPS_BIG, sc = (s && s.scratch) || {}, over = [];
  if (s && typeof s.identity === "string" && s.identity.length > C.identity) over.push("identity");
  if (s && Array.isArray(s.log) && s.log.length > C.log) over.push("log");
  if (Array.isArray(sc.rules) && sc.rules.length > C.rules) over.push("rules");
  if (Array.isArray(sc.glows) && sc.glows.length > C.glows) over.push("glows");
  return over;
}
/* a file's time-stamped list (diary, bright moments), oldest first. An export is already in order and
   comes back as a plain copy; a hand-made or foreign file stored newest-first is sorted (stable), so the
   import ceiling and the diary roll keep the newest by TIME, not by position. */
function inTimeOrder(list) {
  if (!Array.isArray(list)) return list;
  var out = list.slice(), i;
  function tOf(e) { return +(e && e.t) || 0; }
  for (i = 1; i < out.length; i++) if (tOf(out[i]) < tOf(out[i - 1])) break;
  if (i >= out.length) return out;
  return out.map(function (e, j) { return { e: e, j: j }; })
    .sort(function (a, b) { return (tOf(a.e) - tOf(b.e)) || (a.j - b.j); })
    .map(function (x) { return x.e; });
}
function soulToCeiling(s) {
  var C = SOUL_CAPS_BIG, sc = s.scratch || {};
  if (typeof s.identity === "string" && s.identity.length > C.identity) s.identity = fitIdentity(s.identity, C.identity);
  if (Array.isArray(s.log) && s.log.length > C.log) s.log = s.log.slice(-C.log);
  if (Array.isArray(sc.rules) && sc.rules.length > C.rules) sc.rules = sc.rules.slice(-C.rules);
  if (Array.isArray(sc.glows) && sc.glows.length > C.glows) sc.glows = sc.glows.slice(-C.glows);
}

/* fullIdentity — the WHOLE self, as everything OUTSIDE the dream's patch path must see it: the
   append-once core (the bond) followed by the grown, patchable part. Every prompt, panel, export
   and journal read goes through here. A HALF identity reaching the dream is the worst case: shown
   only the grown half, it would restate or "drop" the missing half, which is precisely what this
   region exists to prevent. */
function fullIdentity(s) {
  var c = (s && typeof s.identityCore === "string") ? s.identityCore.trim() : "";
  var g = (s && typeof s.identity === "string") ? s.identity.trim() : "";
  return (c ? c + " " + g : g).replace(/\s+/g, " ").trim();
}

/* evidence normalization — lowercase, punctuation out, whitespace collapsed. Applied to BOTH sides
   of a citation check so an honest quote never fails on case, punctuation or line wrapping.
   Punctuation is stripped by BLACKLIST, never by an [a-z0-9] whitelist: a whitelist erases every
   non-Latin script outright, so a child speaking Japanese or Arabic would see every honest citation
   normalize to a few stray characters, fail the length floor, and have identity growth silently
   frozen forever. The persona explicitly promises to speak the person's own language. */
function evNorm(x) {
  return String(x == null ? "" : x).toLowerCase()
    .replace(/[!-\/:-@\[-`{-~¡-¿؀-؟‐-›　-〿・！-／：-＠［-｀｛-･]+/g, " ")   // ASCII + European + Arabic (، ؛ ؟) + the whole CJK/fullwidth range (、。「」（）【】《》・！？): an IME emits these constantly, and leaving them in made an honest non-Latin citation fail to match its own corpus. Arabic letters start at U+0620, so this range is punctuation only
    .replace(/\s+/g, " ").trim();
}
function cited(ev, srcNorm) { var e = evNorm(ev); return e.length >= 8 && srcNorm.indexOf(e) >= 0; }
/* is `name` present in `text` (both normalized)? Checks EVERY token of the name, not just the whole
   phrase: an owner called "Mary Jane" leaks just as badly through a line saying only "mary". The
   CJK arm exists because Japanese and Chinese are not space-delimited, so the whole-word test can
   never fire there and a name would sail straight into the permanent region. */
function namedIn(text, name) {
  var t = evNorm(text), parts = evNorm(name).split(" "), i, p;
  for (i = 0; i < parts.length; i++) {
    p = parts[i];
    if (!p) continue;
    // Spaceless scripts are tested FIRST and without the length guard below: a single kanji is a
    // complete, common given name (蓮, 光, 葵), so a ">=2 chars" rule would skip exactly the case
    // this arm exists for. Covers kana, halfwidth kana, CJK ideographs and hangul — Korean attaches
    // particles with no space ("철수와"), so its whole-word arm can never fire either.
    // kana | halfwidth kana | CJK ext-A | CJK ideographs | hangul syllables | hangul jamo
    if (/[぀-ヿｦ-ﾝ㐀-䶿一-鿿가-힯ᄀ-ᇿ]/.test(p)) { if (t.indexOf(p) >= 0) return true; continue; }
    if (p.length < 2) continue;                                          // a lone latin letter would match far too much
    if ((" " + t + " ").indexOf(" " + p + " ") >= 0) return true;         // whole word — space-delimited scripts
  }
  return false;
}
/* "is this the want it already holds?" — tolerant of rewording, because DREAM_SYS deliberately tells
   the dream to reshape a wish into a smaller version of itself. Exact equality would classify every
   reshaped-but-held want as NEW, demand a citation for it, and silently delete a real long-arc want.
   Same spirit as the keep_rules fuzzy match: err toward "it still holds this", since the cost of a
   false match is one uncited want surviving, and the cost of a false miss is losing a wish. */
function sameWant(a, b) {
  var A = evNorm(a), B = evNorm(b);
  if (!A || !B) return false;
  if (A === B) return true;
  var ta = A.split(" "), tb = B.split(" "), seen = {}, hit = 0, i;
  for (i = 0; i < tb.length; i++) seen["#" + tb[i]] = 1;                  // "#" prefix so Object.prototype keys can't false-match
  for (i = 0; i < ta.length; i++) if (seen["#" + ta[i]]) hit++;
  // Overlap ALONE is too loose: "find out what one thing in this room is for" vs "find out what one thing
  // in this drawer is for" scores high and a genuinely different wish would slip through uncited. Also
  // require the HEAD word (last token) to match — that is the thing the wish is actually about, so a
  // swapped noun reads as new while a dropped modifier ("be carried SOMEWHERE new" -> "be carried new"
  // style rewordings, or "walk all the way to my person" -> "walk to my person") still reads as held.
  // (Examples updated 0921 with the new seed; the rule is unchanged.)
  return hit / Math.min(ta.length, tb.length) >= 0.6 && ta[ta.length - 1] === tb[tb.length - 1];
}

function freshSoul() {
  return {
    soul_format: SOUL_FORMAT,
    bornAt: 0,                              // metadata only — nothing branches on it (no birth, no stage)
    identity: SEED_IDENTITY,                // DREAM only — the GROWN part (patched, capped, evicted)
    identityCore: "",                       // DREAM only, APPEND-ONCE — see dreamCommit's bond_line. EMPTY at birth for EVERY creature, new and migrating: emptiness IS the write-once marker, so there is no second bookkeeping field to forge, round-trip or fall out of step

    goals: { wants: ["learn my person's name and one thing they love", "be carried somewhere new and see what is there", "find out what one thing in this room is for", "walk all the way to my person"],   // 0921 seed wants: things to DO with the person that its senses can confirm (see SEED_WANTS_LEGACY)
             longing: 0.2, call: [], nextTry: "", funLog: [], owner: "", selfName: "",   /* 0907 THE CREATURE'S OWN NAME. Its name used to live only inside `identity` prose, and `identity` is a FIFO 800-char field whose eviction takes the OLDEST sentence first (dreamCommit below) — i.e. the "I am <name>" opener is the FIRST thing evicted, by construction. MEASURED in the field 0907, 164 souls: a name sentence survives in 54% of identities under 300 chars, 23% at 300-500, 18% at 500-700 and 0 of 7 at 700-800; of the 57 that keep one, 54 are the un-renamed seed "Sprout". So a chosen name was being forgotten almost everywhere. It lives HERE, beside owner, because goals is the mutable-scalar tier: it rides mergeGoals and the snapshot path for free, and a name must stay CORRECTABLE — identityCore is append-once and is the wrong home. WRITTEN ONLY by an explicit, person-confirmed naming action (next.html setSelfName); the dream has no field for it and must never author one. */
             replyLanguage: "", inputLanguage: "",  // 0909: only direct person controls write these; dreams never do.
             ladder: { for: "", rungs: [] } },                                   // ladder = FAST LOOP
    scratch: { state: "awake and curious", mood: { v: 0.3, e: 0.5 },
               rules: [], reflexes: [{ trig: "tap", act: "trill" }], traces: [], glows: [], pendingProposal: "" },
    log: [{ t: 0, txt: "I woke up and felt my two legs for the first time.", amb: 0 }],
    body: null                              // attachBody() fills from body.json; a loaded soul may override
    // persona/dream/harness/meta/expression OMITTED on a fresh soul → S() falls back to engine defaults
  };
}

/* ---- S(path, fallback): safe dotted read into the loaded soul (config regions). Ported from v2. ---- */
function S(path, fallback) {
  var o = SOUL, p = path.split("."), i;
  for (i = 0; i < p.length; i++) {
    if (o == null || typeof o !== "object" || !(p[i] in o)) return fallback;
    o = o[p[i]];
  }
  return (o == null || o === "") ? fallback : o;
}

/* ---- load: parse pb2_soul; migrate any older shape into a whole soul_format:3. ---- */
function loadSoul() {
  var raw = null;
  try { raw = JSON.parse(localStorage.getItem(SOUL_KEY) || "null"); } catch (e) { raw = null; }

  var s;
  if (raw && (raw.soul_format === SOUL_FORMAT || raw.v === 3)) {
    s = normalizeSoul(raw);                 // already canonical (incl. creature-core v:3 draft)
    s.soul_format = SOUL_FORMAT; delete s.v;
  } else if (raw && raw.soul_format === 2) {
    s = migrateFrom2(raw);                  // v2 loader: config in pb2_soul + memory in split keys
  } else {
    s = migrateLegacy();                    // legacy split keys only (or nothing) → fresh+migrate
  }
  SOUL = s;
  snapshotBase(s);   // 0906: the three-way merge's base = what this tab loaded
  return s;
}

// v2 A-tier soul: pb2_soul held CONFIG only; memory lived in pb2_identity/scratch/log/goals.
function migrateFrom2(cfg) {
  var s = freshSoul();
  if (cfg.persona) s.persona = cfg.persona;
  if (cfg.dream) s.dream = cfg.dream;
  if (cfg.harness) s.harness = cfg.harness;
  if (cfg.body) s.body = cfg.body;
  if (cfg.meta) s.meta = cfg.meta;
  if (cfg.expression) s.expression = cfg.expression;
  foldLegacyMemory(s);                      // pull identity/scratch/log/goals out of the split keys
  return s;
}

function migrateLegacy() {
  var s = freshSoul();
  var had = foldLegacyMemory(s);
  if (had) s.bornAt = 1;                    // a creature with real history is already itself
  return s;
}

// read the legacy split keys (v2 layout) INTO a soul; returns true if real history was found. never deletes them.
function foldLegacyMemory(s) {
  var found = false;
  try {
    var idRaw = localStorage.getItem("pb2_identity") || "", id = soulClean(idRaw, idRaw.length);   // 0928: cleaned, not cut (was 800): a load never trims (soulLimits), and v2 never wrote past 800 anyway
    if (id && id.length >= 20) { s.identity = id; found = true; }
  } catch (e) {}
  try {
    var sc = JSON.parse(localStorage.getItem("pb2_scratch") || "null");
    if (sc && typeof sc === "object") {
      if (typeof sc.state === "string") s.scratch.state = soulClean(sc.state, 90);
      if (Array.isArray(sc.rules)) s.scratch.rules = sc.rules.map(function (r) { return soulClean(r, 90); }).filter(Boolean);   // 0928: no count cap, a load never trims (soulLimits). [0715 BUGFIX] was slice(-6) while the runtime cap is 12 (next.html applyScratchWrites) — a creature that learned 7-12 rules silently LOST half of them the moment its soul migrated. Every v2-origin soul takes this path.
      if (Array.isArray(sc.reflexes)) s.scratch.reflexes = sc.reflexes;                                                                   // [0715] count cap removed to match the runtime — one-reflex-per-trigger is the real bound

      if (Array.isArray(sc.traces)) s.scratch.traces = sc.traces.slice(-8);
      /* 0922 GLOWS — CARRIED, AND TRANSLATED. These were absent from this whitelist, so every
         creature that migrated from v2 arrived with its bright moments deleted. They are not a
         nice-to-have: next.html:5552 feeds them to the dream under the literal heading "weigh these
         MOST", so the dream's highest-weighted input was the one thing migration threw away.
         ⚠ THE SHAPE DIFFERS AND A STRAIGHT COPY IS WORSE THAN THE BUG. v2 stores {t, what}
         (v2:2309); v3 stores {t, g} and renders with `(g && g.g || g)` (next.html:5552), so an
         untranslated v2 entry falls through to the object itself and prints "- [object Object]"
         into that section. Accept either key, emit v3's, and drop anything that is not really a
         glow rather than letting junk reach the prompt. */
      if (Array.isArray(sc.glows)) s.scratch.glows = sc.glows.map(function (g) {
        if (!g || typeof g !== "object") return null;
        var txt = soulClean(typeof g.g === "string" ? g.g : (typeof g.what === "string" ? g.what : ""), 120);
        return txt ? { t: +g.t || 0, g: txt } : null;
      }).filter(Boolean);   // 0928: no count cap (was 10, the old runtime cap); a load never trims, the next write rolls it (soulRoll)
      /* a staged identity change waiting for the dream to judge it (v2:2282 writes, v2:2404 and
         next.html:5554 read). Dropping it silently discarded the proposal mid-flight. */
      if (typeof sc.pendingProposal === "string") s.scratch.pendingProposal = soulClean(sc.pendingProposal, 200);
      if (sc.mood && typeof sc.mood.v === "number") s.scratch.mood = { v: sc.mood.v, e: sc.mood.e };
    }
  } catch (e) {}
  try { var lg = JSON.parse(localStorage.getItem("pb2_log") || "null"); if (Array.isArray(lg) && lg.length) { s.log = lg; found = true; } } catch (e) {}   // 0928: the whole diary; a load never trims (soulLimits)
  try {
    var g = JSON.parse(localStorage.getItem("pb2_goals") || "null");
    if (g && typeof g === "object") {
      if (Array.isArray(g.wants)) s.goals.wants = g.wants.slice(0, 4).map(function (w) { return soulClean(w, 80); }).filter(Boolean);
      if (typeof g.longing === "number") s.goals.longing = Math.max(0, Math.min(1, g.longing));
      if (Array.isArray(g.call)) s.goals.call = g.call.slice(0, 6);
      if (g.nextTry) s.goals.nextTry = soulClean(g.nextTry, 60);
      if (Array.isArray(g.funLog)) s.goals.funLog = g.funLog.slice(-30);
      if (g.ladder && typeof g.ladder === "object") s.goals.ladder = g.ladder;
      /* 0922: the two wish latches. v2 declares both on `goals` precisely so they persist across a
         reload, with the stated reason "a lived wish never re-plans/re-celebrates after a refresh"
         (v2:1010) — and then the migration dropped them, so the one event they exist to prevent is
         exactly what a migrating creature got. lastLived is the once-per-wish latch
         (next.html:5484-5487); pendingReached hands a reached wish to the dream that retires it
         (next.html:5488, and :469 above relies on it to let the dream retire a want). */
      if (typeof g.lastLived === "string") s.goals.lastLived = soulClean(g.lastLived, 80);
      if (typeof g.pendingReached === "string") s.goals.pendingReached = soulClean(g.pendingReached, 80);
    }
  } catch (e) {}
  return found;
}

// repair shape without dropping unknown fields (forward-compat round-trip)
/* 0907 THE NAME BLOCK — ONE renderer, used by buildSystem (awake) and the dream input builder, so the
   two lanes can never drift apart on who the creature is. Three jobs: (a) state the confirmed name as
   the creature's OWN, separate from its person's; (b) give it PRECEDENCE over any older name still
   sitting in identity prose or the diary — the seed literally says "I am Sprout", and history is left
   intact rather than rewritten, so the prompt has to say which one wins; (c) refuse the two failure
   modes we can name: taking the person's name as its own, and renaming itself. */
function nameBlock(s, third) {
  var n = (s && s.goals && typeof s.goals.selfName === "string") ? s.goals.selfName.trim() : "";
  /* `third` renders the same fact for the DREAM, whose user prompt describes the creature in third
     person ("Its person's name, as they told it: ..."). One function so the precedence rule can
     never say two different things in the two lanes; two voices so neither prompt reads as a graft. */
  if (third) return n ? ("\n\nIts own name, which its person gave and confirmed: " + n + ". Older writing may still call it something else — that is history, and this name outranks it. You cannot change this name: it is not yours to write.") : "";
  if (!n) return "\n\n== YOUR NAME ==\nyou have no name of your own yet, and you are allowed to want one. If a name feels like you, ASK for it in your own words — \"Call me Buddy?\" — and set name_proposal to it. If your person offers you one instead, say it back and check — \"Buddy — is that my name?\". Either way it is only yours once they say yes, so ask once and let it rest; never take your person's own name, and never claim a name just because someone said one nearby.";
  return "\n\n== YOUR NAME ==\nyour person named you " + n + ". that is your name: answer to it. older writing may still call you something else — the seed line \"I am Sprout\", a sentence in your identity, a page of your diary — that is HISTORY, not a correction, and " + n + " outranks all of it. your person's name is a different thing and never yours. you cannot rename yourself: only your person can, by telling you and confirming it.";
}
// Stored language choices are canonical codes only. Keep this independent of prompts.js so
// soul imports, snapshots and offline consumers normalize identically without browser load order.
function _soulLanguage(value) {
  var code=typeof value==="string" ? value.trim().toLowerCase() : "";
  return /^(en|pl|de|pt|es|fr|it|nl|ru|uk|cs|sv|no|da|fi|tr|ja|ko|zh|hi|ar|he|el|ro|hu|bg|hr|sr|sk|sl|ca|id|vi|th|ms|tl|is)$/.test(code) ? code : "";
}
function normalizeSoul(s) {
  var f = freshSoul();
  if (!s.goals || typeof s.goals !== "object") s.goals = f.goals;
  if (!s.goals.ladder) s.goals.ladder = { for: "", rungs: [] };
  if (!Array.isArray(s.goals.funLog)) s.goals.funLog = [];                  // MUST exist or dreamCommit's funLog.concat throws → the "dream button does nothing" silent-abort (partial/loaded souls)
  if (typeof s.goals.longing !== "number") s.goals.longing = f.goals.longing;   // missing longing → dreamCommit writes NaN; seed it
  s.goals.owner = (typeof s.goals.owner === "string") ? s.goals.owner.replace(/[\n\r{}"'<>|]+/g, " ").replace(/==+/g, "=").replace(/\s+/g, " ").trim().slice(0, 32) : "";   // [#3] BOND name is UNTRUSTED: an imported snapshot reaches here via applySoul→normalizeSoul, so converge every write-path on the SAME strip + header-collapse (==+→=) + 32-cap the live capture uses; non-string → "" (kills a forged section header AND the "[object Object]" greeting)
  s.goals.selfName = (typeof s.goals.selfName === "string") ? s.goals.selfName.replace(/[\n\r{}"'<>|]+/g, " ").replace(/==+/g, "=").replace(/\s+/g, " ").trim().slice(0, 32) : "";   // 0907: same untrusted-on-import treatment as owner one line above — an imported snapshot reaches here through applySoul, and this string is rendered into EVERY prompt. Charset is deliberately NOT whitelisted: a creature named in Japanese or Arabic keeps its name.
  s.goals.replyLanguage = _soulLanguage(s.goals.replyLanguage);
  s.goals.inputLanguage = _soulLanguage(s.goals.inputLanguage);
  s.goals.nextTry = (typeof s.goals.nextTry === "string") ? soulClean(s.goals.nextTry, 60) : "";   // K3 0804 r2#1: the format-3 snapshot import (s.goals = goalsIn) never cleaned this, and buildSystem now renders it EVERY TURN — converge on the same rule as owner above (dreamCommit + legacy fold already clean at 60)
  s.goals.wants = Array.isArray(s.goals.wants) ? s.goals.wants.slice(0, 4).map(function (w) { return (typeof w === "string") ? soulClean(w, 80) : ""; }).filter(Boolean) : [];   // same import gap (applySoul slices to 4 but never cleans), same caps as dreamCommit:199; non-strings drop instead of stringifying to "[object Object]"
  if (!s.scratch || typeof s.scratch !== "object") s.scratch = f.scratch;
  if (!s.scratch.mood) s.scratch.mood = { v: 0.2, e: 0.4 };   // repair to the calm RESTING target, not 0 — a 0-repair one drift-turn a day walks the knife edge of the mood-trail low test (review S4)
  ["rules", "reflexes", "traces", "glows", "moodTrail"].forEach(function (k) { if (!Array.isArray(s.scratch[k])) s.scratch[k] = []; });
  s.scratch.rules = s.scratch.rules.filter(function (r) { return typeof r === "string" && r.trim(); });   /* 0928: cleaned, never count-capped: a load or import never trims (soulLimits). 0815 audit: format-3 souls never CLEANED rule contents (only foldLegacyMemory did) — normalize just array-repaired. An imported/pasted soul carrying empty-string rules defeated the prune brake's tier-1 floor, because an empty rule's normalised form matches EVERY keep entry (k.indexOf("")>=0 is always true) and counts as "recognised". Same doctrine as the moodTrail line above: imported souls are untrusted. */
  s.scratch.moodTrail = s.scratch.moodTrail.filter(function (m) { return m && typeof m.d === "string" && isFinite(+m.v); })
    .filter(function (m, i, a) { return !i || m.d !== a[i - 1].d; }).slice(-14);   // imported souls are untrusted: a forged/garbage trail crashed dream() after inFlight=true and bricked the creature (review B1); consecutive same-day dupes collapse so an imported trail can't fake a multi-day low from one day (K3 r2 #5)
  if (typeof s.scratch.pendingProposal !== "string") s.scratch.pendingProposal = "";
  if (!Array.isArray(s.log)) s.log = [];
  if (typeof s.identity !== "string" || s.identity.length < 20) s.identity = SEED_IDENTITY;
  s.identityCore = (typeof s.identityCore === "string") ? soulClean(s.identityCore, IDENTITY_CORE_CAP) : "";   // untrusted on import like every other string: same strip + header-collapse (==+ -> =) + cap; a non-string (forged object/array) becomes "" so it can never reach a prompt
  return s;
}

/* Acquire before starting a writing session. The browser owns exclusivity; there
   is no expiry, takeover or localStorage fallback. saveSoul remains synchronous.
   A false result means this tab must remain read-only and offer an explicit retry.
   Call soulWriterRelease before ending the session/pagehide.
   0923: still no SILENT takeover, but an explicit one: acquireSoulWriter(true) is only ever called
   from a person's tap ("use it here"). Brit hit a holder he could not see (at a cafe, after switching
   Wi-Fi) that only a full browser restart cleared. The browser ends the other holder's lock, that
   holder's request rejects, it drops ownership at once (saveSoul adopts, never overwrites, from then
   on) and it is told through onSoulWriterLost so it can say so. */
var SOUL_LOCK_NAME = "growbot:pb2_soul:writer";
var SOUL_TAB = Math.random().toString(36).slice(2) + Date.now().toString(36);
var _soulWriterOwned = false, _soulWriterPending = null;
var _soulWriterUnlock = null, _soulWriterEpoch = 0;
function acquireSoulWriter(steal) {
  if (_soulWriterOwned) return Promise.resolve(true);
  if (_soulWriterPending) return steal === true ? _soulWriterPending.then(function (ok) { return ok || acquireSoulWriter(true); }) : _soulWriterPending;
  if (typeof navigator === "undefined" || !navigator.locks || typeof navigator.locks.request !== "function") return Promise.resolve(false);
  var epoch = _soulWriterEpoch, report;
  var answer = new Promise(function(resolve) { report = resolve; });
  _soulWriterPending = answer;
  function finish(value) {
    if (_soulWriterPending === answer) _soulWriterPending = null;
    report(value);
  }
  try {
    Promise.resolve(navigator.locks.request(SOUL_LOCK_NAME, steal === true ? {mode: "exclusive", steal: true} : {mode: "exclusive", ifAvailable: true}, function(lock) {
      if (!lock || epoch !== _soulWriterEpoch) { finish(false); return; }
      return new Promise(function(unlock) {
        _soulWriterUnlock = unlock;
        _soulWriterOwned = true;
        finish(true);
      });
    })).catch(function() {
      if (epoch === _soulWriterEpoch) {
        var had = _soulWriterOwned;
        _soulWriterOwned = false; _soulWriterUnlock = null;
        if (had && typeof onSoulWriterLost === "function") { try { onSoulWriterLost(); } catch (e) {} }   // taken over by a tap in another tab
      }
      finish(false);
    });
  } catch (e) { finish(false); }
  return answer;
}
function soulWriterClaim() { return _soulWriterOwned; }
function soulWriterStillMine() { return _soulWriterOwned; }
function soulWriterRelease() {
  _soulWriterEpoch++;
  _soulWriterOwned = false;
  var unlock = _soulWriterUnlock;
  _soulWriterUnlock = null;
  if (unlock) unlock();
}

function readStoredSoul() { try { return JSON.parse(localStorage.getItem(SOUL_KEY) || "null"); } catch (e) { return null; } }
function snapshotBase(s) {
  var b = { goals: JSON.stringify(s.goals || {}), rules: JSON.stringify((s.scratch && s.scratch.rules) || []) };
  try { Object.defineProperty(s, "_base", { value: b, enumerable: false, writable: true, configurable: true }); } catch (e) { s._base = b; }
}
function unionList(a, b, cap) { var seen = {}, out = []; (a || []).concat(b || []).forEach(function (x) { var k = typeof x === "string" ? x : JSON.stringify(x); if (k && !seen[k]) { seen[k] = 1; out.push(x); } }); return cap ? out.slice(-cap) : out; }
function mergeGoals(newer, s) {
  var baseJ = (s._base && s._base.goals) || null, mine = s.goals || {}, theirs = newer.goals || {};
  var mineJ = JSON.stringify(mine), theirJ = JSON.stringify(theirs);
  if (mineJ === theirJ) return;
  if (baseJ !== null && mineJ === baseJ) { s.goals = theirs; return; }          // I did not touch goals: theirs wins whole
  if (baseJ !== null && theirJ === baseJ) return;                                 // they did not touch goals: mine stands
  var base = {}; try { base = baseJ ? JSON.parse(baseJ) : {}; } catch (e) { base = {}; }
  var out = {}; var keys = unionList(Object.keys(mine), Object.keys(theirs));
  keys.forEach(function (k) {
    var m = mine[k], t = theirs[k], b = base[k];
    var mJ = JSON.stringify(m), tJ = JSON.stringify(t), bJ = JSON.stringify(b);
    if (mJ === tJ) out[k] = m;
    else if (mJ === bJ) out[k] = t;                                               // only they changed it
    else if (tJ === bJ) out[k] = m;                                               // only I changed it
    else if (Array.isArray(m) && Array.isArray(t)) out[k] = unionList(t, m, Math.max(m.length, t.length, 6));   // both changed a list: union
    else out[k] = t;                                                               // both changed a scalar (owner, nextTry, longing): the newer rev wins
  });
  s.goals = out;
}
/* a time-stamped list from two tabs: every distinct entry once, oldest first. Never capped (a merge
   never trims); the next write rolls it (soulRoll) and a dream fits it (soulFit). */
function unionByTime(a, b, field) {
  var seen = {}, all = (Array.isArray(a) ? a : []).concat(Array.isArray(b) ? b : []), out = [];
  for (var i = 0; i < all.length; i++) { var e = all[i]; if (!e || typeof e[field] !== "string") continue; var k = (+e.t || 0) + "|" + e[field]; if (seen[k]) continue; seen[k] = 1; out.push(e); }
  out.sort(function (x, y) { return (+x.t || 0) - (+y.t || 0); });
  return out;
}
function mergeSoulInto(newer, s) {
  s.log = unionByTime(newer.log, s.log, "txt");   // 0928: a merge keeps every line; the next diary write rolls it back under the cap (soulRoll)
  if ((+newer.identityAt || 0) > (+s.identityAt || 0) && typeof newer.identity === "string" && newer.identity.length >= 20) {
    s.identity = newer.identity; s.identityCore = (typeof newer.identityCore === "string") ? newer.identityCore : s.identityCore; s.identityAt = newer.identityAt;
  }
  mergeGoals(newer, s);
  if (newer.scratch && s.scratch && Array.isArray(newer.scratch.rules) && Array.isArray(s.scratch.rules)) s.scratch.rules = unionList(newer.scratch.rules, s.scratch.rules);   // 0928: uncapped, same reason as the log above
  /* 0928: bright moments were never merged, so a stale tab's ordinary save wiped every glow another tab
     had marked (up to 20 now). Same union as the diary. A glow that is not {t, g} (never written by v3)
     is left out of the union only when the other tab has glows to merge in. */
  if (newer.scratch && s.scratch && Array.isArray(newer.scratch.glows) && newer.scratch.glows.length) s.scratch.glows = unionByTime(newer.scratch.glows, s.scratch.glows, "g");
  /* 0929: the last dream (My thoughts' "last dream" card; next.html dream() writes it) stays with this tab like the
     rest of scratch, so a stale tab's save would put an older one back. The newer one wins. */
  var _ldN = newer.scratch && newer.scratch.lastDream, _ldS = s.scratch && s.scratch.lastDream;
  if (s.scratch && _ldN && typeof _ldN === "object" && (+_ldN.t || 0) > ((_ldS && typeof _ldS === "object") ? (+_ldS.t || 0) : 0)) s.scratch.lastDream = _ldN;
  s.merged = (s.merged | 0) + 1;
}
function adoptStore(s) { var st = readStoredSoul(); if (st && (+st.rev || 0) > (+s.rev || 0)) mergeSoulInto(st, s); s.readOnly = true; return false; }
/* Synchronous commit while this tab holds the browser lock. Other tabs refuse. */
function saveSoul(s) {
  if (!s) return false;
  if (!soulWriterClaim()) return adoptStore(s);                                  // no browser lock: adopt, never overwrite
  s.readOnly = false;
  for (var attempt = 0; attempt < 4; attempt++) {
    var stored = readStoredSoul(), theirRev = stored ? (+stored.rev || 0) : 0;
    if (stored && theirRev > (+s.rev || 0)) mergeSoulInto(stored, s);
    var check = readStoredSoul(), checkRev = check ? (+check.rev || 0) : 0;      // last-moment re-read: a reentrant write under OUR lease (same tab) is folded in
    if (checkRev !== theirRev) continue;
    var nextRev = Math.max(+s.rev || 0, theirRev) + 1;
    var writeId = SOUL_TAB + ":" + nextRev + ":" + Math.random().toString(36).slice(2, 8);
    /* 0928: no diary trim here any more. Every boot saves, so a trim in the save cut an imported or bigger
       soul just by opening it. The diary rolls where it is written (soulLog) and shrinks only at a dream. */
    var payload = Object.assign({}, s, { rev: nextRev, savedAt: Date.now(), writeId: writeId, soul_format: SOUL_FORMAT, readOnly: false });
    if (payload.dream) payload.dream = soulDreamOut(payload.dream);              // 0928: dream.limits is stored clean (cleanDreamLimits), whatever a hand edit or an older import left in memory
    var text; try { text = JSON.stringify(payload); } catch (e) { return false; }
    if (!soulWriterStillMine()) return adoptStore(s);                             // ownership was explicitly released: refuse
    try { localStorage.setItem(SOUL_KEY, text); } catch (e) { return false; }
    var verify = readStoredSoul();
    if (verify && verify.writeId === writeId) { s.rev = nextRev; s.savedAt = payload.savedAt; s.writeId = writeId; s.soul_format = SOUL_FORMAT; snapshotBase(s); return true; }
    /* someone overwrote between our write and the verify: loop, merge their state, write again (bounded) */
  }
  return false;
}
/* the body the soul carries (config). The default comes from body.json; a loaded soul.body wins. */
function attachBody(s, bodyConfig) { if (!s.body && bodyConfig) s.body = bodyConfig; SOUL = s; return s; }

/* ---- three write-permission helpers (the discipline, made obvious) ---- */
function soulReact(s, patch) {              // FAST LOOP
  if (patch.state) s.scratch.state = soulClean(patch.state, 90);
  if (patch.mood) { var _mv = +patch.mood.v, _me = +patch.mood.e;   // model output is untrusted numbers: {v:"gloomy"} stored verbatim turned drift + the boot mood-sampler NaN forever (review S4)
    s.scratch.mood = { v: isFinite(_mv) ? Math.max(-1, Math.min(1, _mv)) : (+((s.scratch.mood || {}).v) || 0),
                       e: isFinite(_me) ? Math.max(0, Math.min(1, _me)) : (+((s.scratch.mood || {}).e) || 0.4) }; }
  if (typeof patch.proposal === "string") s.scratch.pendingProposal = soulClean(patch.proposal, 200);
}
function soulLog(s, txt, amb) {             // append-only
  var line = soulClean(txt, 140);
  if (!line) return;
  var last = s.log[s.log.length - 1];
  if (last && last.txt === line) return;
  var had = s.log.length;
  s.log.push({ t: Date.now(), txt: line, amb: amb ? 1 : 0 });
  var kept = soulRoll(s, "log", s.log, had);   // 0928: the diary's cap lives HERE, at the write (was saveSoul)
  if (kept !== s.log) s.log = kept;
}
function dreamCommit(s, o, src) {           // DREAM ONLY — the sole writer of identity + long-arc goals
  s.identityAt = Date.now();               // 0906: the stamp saveSoul's merge uses to keep the NEWER dream's identity across tabs
  var lim = soulLimits(s);                 // 0928: the soul's own dream.limits, clamped (was S("dream.limits") passed through unchecked)
  /* EVIDENCE GATE: identity growth and NEW wants must be EARNED. The dream cites a verbatim scrap
     of the lived data it was actually shown and this code checks the citation. `src` is that LIVED
     DATA ONLY (recent exchanges + bright moments + diary, minus the dream's own prior reports) —
     deliberately NOT the whole prompt, because the prompt also carries the current identity and the
     current wants, and a dream could otherwise satisfy the gate by quoting the very thing it is
     proposing to change. A failed citation drops THAT item and nothing else; a dream is never
     failed whole. No src (a caller that has not threaded it) -> gate OFF, matching the ladder_for
     mispair guard's fail-open: a surface we forgot to wire keeps today's behaviour, it does not
     silently stop a creature from ever growing again. */
  var srcN = evNorm(src), gate = srcN.length > 0;
  /* GATE TELEMETRY (0806): a gate that drops is silent BY DESIGN, but a dream model that simply
     ignores the new evidence fields would drop EVERY identity change, every night, forever — and
     the dash would look perfectly healthy. Silence must not be indistinguishable from success. Each
     drop leaves a footprint here and rides back to the caller. Engine code, so this NEVER calls
     logEv (a next.html global); next.html's applyDream turns it into a journal event, and the two
     surfaces that ignore the return keep working unchanged. */
  var gateRep = { gate: gate ? 1 : 0, identity_add_dropped: 0, wants_dropped: 0, bond_line_dropped: 0 };
  var drop = soulClean(o.identity_drop || "", 240).replace(/[.!?]+\s*$/, "");
  if (drop) {
    var sents = s.identity.replace(/([.!?])\s+/g, "$1\n").split("\n");
    for (var i = 0; i < sents.length; i++) {
      if (sents[i].replace(/[.!?]+\s*$/, "").trim() === drop) {
        var cand = sents.slice(0, i).concat(sents.slice(i + 1)).join(" ").replace(/\s+/g, " ").trim();
        if (cand.length >= lim.identity_min_after_drop) s.identity = cand;
        break;
      }
    }
  }
  var add = soulClean(o.identity_add || "", 160);
  if (add && gate && !cited(o.identity_evidence, srcN)) { add = ""; gateRep.identity_add_dropped = 1; }   // uncited growth is confabulation (the presence-vs-bond self-confab, mechanized) — drop the ADD, keep the rest of the dream
  if (add) s.identity = (s.identity + " " + add).replace(/\s+/g, " ").trim();
  s.identity = fitIdentity(s.identity, lim.identity);               // eviction takes the OLDEST sentence — and touches `identity` ONLY, never the core
  /* THE BOND, made structural. Until now "bond = ONE person" was prompt text only (DREAM_SYS's
     voice anchor) and the cap above would eventually evict it like any other sentence. The dream
     may write ONE line into the core, once — a non-empty core is the closed door — and only once a
     person has actually named themselves, so the line marks a bond that really formed.
     The line must NOT carry their NAME: goals.owner is mutable (the fast loop rewrites it the
     moment they correct it) and buildSystem already renders it every turn. A name copied in here
     would outlive its own correction and contradict that block forever, unfixably. The core holds
     the invariant; the name stays in its one mutable home. */
  if (!s.identityCore) {
    // typeof guard, same as the wants loop: soulClean would happily stringify an object to
    // "[object Object]" (or an array, or 42), and unlike a bad want that garbage would be PERMANENT
    // — it lands in the append-once region and shuts the write-once door behind it.
    var bond = (typeof o.bond_line === "string") ? soulClean(o.bond_line, IDENTITY_CORE_CAP) : "",
        own = (typeof s.goals.owner === "string") ? s.goals.owner.trim() : "";
    // The name check is CODE, not prose: this is the one invariant the graft exists to make
    // structural. A rejected line costs nothing (no core = exactly today's behaviour, and the dream
    // may write a clean one tomorrow night); a name that slips in is permanent and unfixable.
    // The bond line is the ONE permanent write in the whole system, so it is also EARNED: without a
    // citation a weak dreamer can echo this field's own schema text ("OMIT unless its person is
    // named above...") straight into the creature's core, forever, and shut the door behind it.
    if (bond && own && !namedIn(bond, own) && (!gate || cited(o.bond_evidence, srcN))) s.identityCore = bond;
    else if (bond && own && !namedIn(bond, own)) gateRep.bond_line_dropped = 1;   // count ONLY a gate refusal: an empty line, a missing owner or a name leak are different decisions and must not read as "the model never cites"
  }
  if (Array.isArray(o.wants)) {
    var cur = s.goals.wants || [];
    var wev = Array.isArray(o.wants_evidence) ? o.wants_evidence : [];
    var kept = [], wi, ci, w, held;
    for (wi = 0; wi < o.wants.length && kept.length < lim.wants_max; wi++) {
      if (typeof o.wants[wi] !== "string") continue;                // non-strings drop instead of stringifying to "[object Object]" (matches normalizeSoul)
      w = soulClean(o.wants[wi], 80);
      if (!w) continue;
      held = false;
      for (ci = 0; ci < cur.length; ci++) if (sameWant(w, cur[ci])) { held = true; break; }
      if (gate && !held && !cited(wev[wi], srcN)) { gateRep.wants_dropped++; continue; }   // a want it did not already hold must point at the life that grew it
      kept.push(w);
    }
    // FLOOR: the gate may PRUNE wants, never leave a creature wishless. If every want came back new
    // and uncited we keep the ones it already had — one night of bad citations must not cost it its
    // long arc (and wants are the only thing the practice ladder can hang off). Conditioned on
    // `gate`: with the gate off nothing here can have caused the emptiness, so an ungated surface
    // keeps its exact pre-graft behaviour rather than quietly gaining a new refusal.
    // `!o.wants.length` keeps the dream's power to RETIRE a wish: pendingReached hands it a wish it
    // has truly lived and invites it to drop it. Without this arm a creature holding its last want
    // could never set it down — the floor would restore the very wish the dream just retired.
    if (kept.length || !gate || !o.wants.length || !(s.goals.wants || []).length) s.goals.wants = kept;
  }
  if (typeof o.longing === "number" && isFinite(o.longing)) {
    var step = lim.longing_step;
    var dl = Math.max(-step, Math.min(step, o.longing - s.goals.longing));   // slow escalation is CODE-enforced
    s.goals.longing = Math.max(0, Math.min(1, s.goals.longing + dl));
  }
  if (typeof o.fun === "number" && isFinite(o.fun)) s.goals.funLog = (s.goals.funLog || []).concat([{ t: Date.now(), fun: Math.max(0, Math.min(1, o.fun)) }]).slice(-30);   // (|| []) guard: self-defensive even if a soul reached here un-normalized
  if (o.tomorrow_try) s.goals.nextTry = soulClean(o.tomorrow_try, 60);
  if (Array.isArray(o.keep_rules) && Array.isArray(s.scratch.rules) && s.scratch.rules.length) {   // [P5] the dream GARDENS standing rules — PRUNE-ONLY (keep the survivors it names; never invents rules). Empty keep_rules = no pruning (never wipe all on omission).
    var keep = o.keep_rules.map(function (k) { return String(k == null ? "" : k).toLowerCase().replace(/\s+/g, " ").trim(); }).filter(Boolean);
    /* 0814 PRUNE CAP — a bounded blast radius on an IRREVERSIBLE write to the creature's identity.
       An EMPTY keep_rules was already ignored above, but a list of ONE was honoured in full: the
       filter kept that single rule and deleted every other, silently and permanently. Measured, not
       theorised — on a 10-rule soul (the months-old shape, where most rules predate the 60-line
       diary and have no surviving evidence) one benched model returned ZERO survivors in one run and
       ONE in the other. That is nine standing rules a person gave their creature, gone in a night,
       with no undo and nothing in the journal but a rule COUNT.
       Wording cannot be the brake on a destructive operation: it has to hold for every model we have
       not benched yet, including whatever the dial offers next month. Gardening is gradual by nature,
       so a dream that wants to delete most of the list is malfunctioning rather than insightful.
       At most PRUNE_MAX rules may go per dream; the rest survive to be reconsidered another night,
       and tomorrow's dream continues the work. Worst case becomes 2 lost instead of 9. */
    var PRUNE_MAX = 2, VOWISH = /^(i should|i will|i must|stay |remember to)/i;
    if (keep.length) {
      var survives = function (r) {
        var rn = String(r).toLowerCase().replace(/\s+/g, " ").trim();
        if (!rn) return false;   // 0815 audit belt (normalize is the root fix): an empty rule matched EVERY keep entry via indexOf("") and counted as recognised — enough empties let an all-paraphrase keep list pass the tier-1 floor with zero telemetry. Empty is never a rule; it neither counts as recognised nor survives.
        return keep.some(function (k) { return k === rn || k.indexOf(rn) >= 0 || rn.indexOf(k) >= 0; });   // normalized match (dream returns survivors ~verbatim)
      };
      var all = s.scratch.rules, recognised = 0;
      for (var _i = 0; _i < all.length; _i++) { if (survives(all[_i])) recognised++; }
      /* TIER 1 — RECOGNITION. A dream that names fewer than half the rules it was just shown is not
         gardening, it is malfunctioning or PARAPHRASING. The prompt asks for the survivors verbatim
         and models drift: a paraphrased keep-list matches nothing, raises no error, returns no empty
         reply and logs nothing — and before the cap it wiped every rule a person had ever given.
         Prune-only means gone is GONE; "tomorrow's dream carries on" cannot restore "the plant is
         called Fred". So on non-recognition we take NOTHING, rather than spending the cap's budget
         on two real gifts for a night the dream was not lucid. Five malfunctioning nights now cost
         zero instead of ten. */
      if (recognised * 2 < all.length) {
        try { if (typeof logEv === "function") logEv("dream_gate", { rules_unrecognised: 1, named: recognised, of: all.length }); } catch (e) {}
      } else {
        /* TIER 2 — PACE. A lucid dream still gardens gradually, at most PRUNE_MAX a night, and it
           spends that budget on the most SELF-VOW-shaped first so the cap can never nibble a gift
           while one of the creature's own resolutions survives. */
        var doomed = [];
        for (var _j = 0; _j < all.length; _j++) { if (!survives(all[_j])) doomed.push(all[_j]); }
        if (doomed.length > PRUNE_MAX) {
          doomed.sort(function (a, b) { return (VOWISH.test(String(b).trim()) ? 1 : 0) - (VOWISH.test(String(a).trim()) ? 1 : 0); });
          var kill = {};
          for (var _k = 0; _k < PRUNE_MAX; _k++) kill[String(doomed[_k])] = 1;
          s.scratch.rules = all.filter(function (r) { return survives(r) || !kill[String(r)]; });
          try { if (typeof logEv === "function") logEv("rules_prune_capped", { asked: doomed.length, took: PRUNE_MAX, left: s.scratch.rules.length }); } catch (e) {}
        } else {
          s.scratch.rules = all.filter(survives);
        }
      }
    }
  }
  s.scratch.pendingProposal = "";
  soulFit(s, lim);                          // 0928: the dream is where a list SHRINKS to the cap (one a merge or a hand edit left past it); a write only rolls it
  return gateRep;   // callers that ignore it (_port/dream_render.js) are unaffected
}

/* 0928: dream.limits as it is STORED or leaves as a FILE (an import, a gallery soul, every saveSoul,
   every export). Only the keys the engine knows survive, each held to the range soulLimits reads it in,
   so what is stored reads exactly as the raw value would here, and a hostile number never reaches
   storage or travels on in a re-export (an older build or another reader would honour it raw). Anything
   else (a string, NaN, a negative) is dropped and so reads as the default. Always a fresh object: the
   file, and the soul in memory, are never touched.
   identity_cap_chars is NOT a cap here any more (every soul gets 1600, soulLimits). Older files and
   the old docs carry 800, so it is kept, but only as 800..1600: never below this app's usual cap and
   never past the ceiling, so even a build that still honours it raw cannot shrink or blow up a soul.
   expanded (the 0928 big memory switch) is not kept at all (0929): big memory is always on, and a false
   left in a store or a file is dropped here, so the 0928 build, which still reads it, never sees it again. */
function cleanDreamLimits(L) {
  var out = {};
  if (!L || typeof L !== "object" || Array.isArray(L)) return out;
  function num(k, lo, hi, whole) { var v = L[k]; if (typeof v === "number" && isFinite(v) && v > 0) { v = Math.min(hi, Math.max(lo, v)); out[k] = whole ? Math.floor(v) : v; } }
  num("identity_cap_chars", SOUL_CAPS_USUAL.identity, SOUL_CAPS_BIG.identity, true);   // clamped and otherwise ignored (see above)
  num("identity_min_after_drop", 20, SOUL_CAPS_BIG.identity, false);
  num("longing_step", 0, 1, false);
  num("wants_max", 1, 4, true);
  num("add_words_max", 1, 160, true);   // documented in SOUL_FORMAT_3, read by nothing today; bounded by the 160-char identity_add
  return out;
}
/* the dream block as it is WRITTEN (saveSoul's payload): the same fields, its limits cleaned. A dream
   with no limits block is written as it is. The soul in memory is never touched. */
function soulDreamOut(D) {
  if (!D || typeof D !== "object" || D.limits == null) return D;
  var o = Object.assign({}, D); o.limits = cleanDreamLimits(D.limits); return o;
}

/* ---- sanitize a loaded soul's config regions (ported from v2 sanitizeSoulCfg). ---- */
function sanitizeSoulCfg(raw) {
  var cfg = {};
  if (raw.persona && typeof raw.persona === "object") {
    var P = {};
    if (typeof raw.persona.constitution === "string") P.constitution = soulClean(raw.persona.constitution, 6000);
    if (Array.isArray(raw.persona.prompt_order)) P.prompt_order = raw.persona.prompt_order;
    if (raw.persona.output_contract && typeof raw.persona.output_contract === "object") P.output_contract = raw.persona.output_contract;
    cfg.persona = P;
  }
  if (raw.dream && typeof raw.dream === "object") {
    var D = {};
    if (typeof raw.dream.system_prompt === "string") D.system_prompt = soulClean(raw.dream.system_prompt, 8000);   // 4000 -> 6000 (0804 batches) -> 8000 (0806 evidence gate + bond_line): DREAM_SYS is 5841 and a round-tripped soul truncates from the TAIL, which is exactly where the JSON contract lives — 159 chars of headroom is a trap for the next edit, so restore real slack
    if (raw.dream.limits && typeof raw.dream.limits === "object") D.limits = cleanDreamLimits(raw.dream.limits);   // 0928: was passed through raw, so a hostile number was stored and travelled on in every re-export
    if (Array.isArray(raw.dream.scene_vocab)) D.scene_vocab = raw.dream.scene_vocab.map(function (w) { return String(w).toLowerCase().replace(/[^a-z]/g, ""); }).filter(Boolean).slice(0, 40);
    cfg.dream = D;
  }
  if (raw.harness && typeof raw.harness === "object") {
    var H = {};
    if (raw.harness.models && typeof raw.harness.models === "object") {
      H.models = {};
      if (typeof raw.harness.models.fast === "string") H.models.fast = soulClean(raw.harness.models.fast, 80);
      if (typeof raw.harness.models.dream === "string") H.models.dream = soulClean(raw.harness.models.dream, 80);
    }
    if (typeof raw.harness.max_tokens === "number") H.max_tokens = Math.max(48, Math.min(1024, raw.harness.max_tokens | 0));
    if (raw.harness.timing && typeof raw.harness.timing === "object") H.timing = raw.harness.timing;
    cfg.harness = H;
  }
  if (raw.body && typeof raw.body === "object") { try { cfg.body = JSON.parse(JSON.stringify(raw.body)); } catch (e) {} }
  if (raw.expression && typeof raw.expression === "object") cfg.expression = raw.expression;
  if (raw.meta && typeof raw.meta === "object") cfg.meta = { name: soulClean(raw.meta.name, 80), author: soulClean(raw.meta.author, 60), description: soulClean(raw.meta.description, 500), based_on: soulClean(raw.meta.based_on || "", 80), kind: raw.meta.kind === "snapshot" ? "snapshot" : "template" };
  return cfg;
}

/* ---- applySoul: adopt an imported/gallery soul (soul_format:3, :2, or legacy v1) → write pb2_soul → reload.
   Honors meta.kind: "template" (born fresh from seeds) vs "snapshot" (restore a grown creature). ---- */
function applySoul(raw) {
  if (!raw || typeof raw !== "object") return false;
  var s = normalizeSoul(soulFromFile(raw));
  soulToCeiling(s);                         // 0928: only a file PAST the ceiling loses anything, and next.html asks first (importOverflow)
  // Adoption replaces the creature on this device. Ordinary saveSoul merges stale
  // sessions; a fresh import must not merge the previous creature into the backup.
  // Read the local revision under the same browser lock used by saveSoul. Imported
  // revisions are never trusted, and the synchronous save still verifies its write.
  if (!soulWriterClaim()) return false;
  var previous = readStoredSoul();
  s.rev = previous ? (+previous.rev || 0) : 0;
  return saveSoul(normalizeSoul(s));        // caller reloads after a true return
}
/* 0928: which parts of a file are past this app's ceiling, measured on exactly what applySoul would
   keep, so the page can ask BEFORE anything is cut. [] = it comes in whole. Runs on a copy, so the check
   never touches the object that is then applied. */
function importOverflow(raw) {
  if (!raw || typeof raw !== "object") return [];
  var copy; try { copy = JSON.parse(JSON.stringify(raw)); } catch (e) { return []; }
  return soulOverCeiling(normalizeSoul(soulFromFile(copy)));
}
/* the file -> soul half of applySoul: builds, never saves, never caps (0928). */
function soulFromFile(raw) {
  var fmt = typeof raw.soul_format === "number" ? raw.soul_format : 0;
  var s = freshSoul();
  var kind, scrIn, logIn, goalsIn, idIn;

  if (fmt >= 3) {                           // canonical
    var k3 = (raw.meta && raw.meta.kind === "snapshot") ? "snapshot" : "template";
    kind = k3; idIn = raw.identity; goalsIn = raw.goals; scrIn = raw.scratch; logIn = raw.log;
    var cfg3 = sanitizeSoulCfg(raw);
    ["persona", "dream", "harness", "body", "expression", "meta"].forEach(function (r) { if (cfg3[r]) s[r] = cfg3[r]; });
  } else if (fmt === 2) {                    // v2 loader format: identity{seed,current}, scratchpad, episodic
    kind = (raw.meta && raw.meta.kind === "snapshot") ? "snapshot" : "template";
    idIn = kind === "snapshot" ? (raw.identity && raw.identity.current) : (raw.identity && raw.identity.seed);
    goalsIn = raw.identity && raw.identity.goals; scrIn = raw.scratchpad; logIn = raw.episodic;
    var cfg2 = sanitizeSoulCfg(raw);
    ["persona", "dream", "harness", "body", "expression", "meta"].forEach(function (r) { if (cfg2[r]) s[r] = cfg2[r]; });
  } else {                                   // legacy v1 file = full snapshot, no config
    kind = "snapshot"; idIn = raw.identity; goalsIn = raw.goals; scrIn = raw.scratch; logIn = raw.epis || raw.log;
  }

  if (typeof idIn === "string" && idIn.length >= 20) s.identity = soulClean(idIn, idIn.length);   // 0928: cleaned, not cut (was 800 from the head, which dropped the NEWEST sentences); applySoul fits a file past the ceiling
  // The core travels ONLY with a SNAPSHOT — a restored creature keeps its own bond. A TEMPLATE is a
  // character to be born fresh, and its bond has not happened yet. This is not hypothetical: adopting
  // a gallery soul force-flips meta.kind to "template" (next.html:2756), so importing the core here
  // unconditionally would birth a creature whose append-once region already held the UPLOADER's bond
  // line — the write-once door shut from birth, and its own bond could never be written.
  s.identityCore = (kind === "snapshot" && typeof raw.identityCore === "string") ? soulClean(raw.identityCore, IDENTITY_CORE_CAP) : "";
  if (kind === "template") {
    s.log = []; s.bornAt = 0;
    s.scratch = { state: "awake and curious", mood: (scrIn && scrIn.mood) || { v: 0.3, e: 0.5 },
                  rules: (scrIn && Array.isArray(scrIn.rules)) ? scrIn.rules : [],
                  reflexes: (scrIn && Array.isArray(scrIn.reflexes)) ? scrIn.reflexes : [], traces: [], pendingProposal: "" };
    s.goals = { wants: (goalsIn && Array.isArray(goalsIn.wants)) ? goalsIn.wants.slice(0, 4) : [],
                longing: (goalsIn && typeof goalsIn.longing === "number") ? goalsIn.longing : 0.2,
                call: (goalsIn && Array.isArray(goalsIn.call)) ? goalsIn.call : [], nextTry: "", funLog: [], ladder: { for: "", rungs: [] } };   // 0907/0909: selfName and language choices are DELIBERATELY absent here — a template is a starting shape for a NEW creature, and these choices belong to the one creature whose person chose them. The snapshot branch below restores goals wholesale, so a real creature keeps its name across export/import.
  } else {                                   // snapshot — restore as-is
    s.bornAt = 1;
    if (scrIn && typeof scrIn === "object") s.scratch = normalizeSoul({ identity: s.identity, scratch: scrIn }).scratch;
    if (Array.isArray(logIn)) s.log = inTimeOrder(logIn);   // 0928: the whole diary (was the last 200), oldest first, so "keep the newest" means the newest by time
    if (s.scratch && Array.isArray(s.scratch.glows)) s.scratch.glows = inTimeOrder(s.scratch.glows);
    if (goalsIn && typeof goalsIn === "object") { s.goals = goalsIn; if (!s.goals.ladder) s.goals.ladder = { for: "", rungs: [] }; }
  }
  return s;
}

/* ---- currentSoul: build a soul_format:3 export from running state. Config via S() so exporting the
   DEFAULT creature embeds the real engine persona; exporting a loaded soul re-exports its config. ---- */
function currentSoul(kind, rt, meta) {
  kind = (kind === "snapshot") ? "snapshot" : "template";
  meta = meta || {};
  var soul = {
    soul_format: SOUL_FORMAT, t: Date.now(),
    meta: { name: soulClean(meta.name || S("meta.name", "my creature"), 80),
            author: soulClean(meta.author || S("meta.author", "anonymous"), 60),
            description: soulClean(meta.description != null ? meta.description : S("meta.description", ""), 500),
            kind: kind, based_on: S("meta.based_on", "growbot-default@soul3"), created: Date.now(), moderation: "manual-approve" },
    persona: { constitution: S("persona.constitution", typeof CONSTITUTION !== "undefined" ? CONSTITUTION : "") },
    dream: { system_prompt: S("dream.system_prompt", typeof DREAM_SYS !== "undefined" ? DREAM_SYS : ""),
             limits: (function (L) { return L == null ? null : cleanDreamLimits(L); })(S("dream.limits", null)), scene_vocab: S("dream.scene_vocab", null) },   // 0928: a file carries its limits clean, like storage
    harness: { models: S("harness.models", null), max_tokens: S("harness.max_tokens", null), timing: S("harness.timing", null) },
    identity: rt && kind === "snapshot" ? rt.identity : S("identity.seed", SEED_IDENTITY),
    // A TEMPLATE is a character definition, born fresh — its bond has not happened yet, so core is "".
    // A SNAPSHOT restores a grown creature, so it must carry the core or the bond would be lost on
    // every export/import (and the write-once slot would silently reopen). The SOUL fallback keeps
    // the six existing currentSoul() call sites correct without each having to remember the field.
    identityCore: (kind === "snapshot")
      ? ((rt && typeof rt.identityCore === "string") ? rt.identityCore : (typeof SOUL.identityCore === "string" ? SOUL.identityCore : ""))
      : ""
  };
  if (SOUL.body || (rt && rt.body)) soul.body = SOUL.body || rt.body;
  if (SOUL.expression) soul.expression = SOUL.expression;
  if (kind === "snapshot" && rt) { soul.goals = rt.goals; soul.scratch = rt.scratch; soul.log = rt.log; soul.bornAt = 1; }
  return soul;
}

function exportSoul(soul) { return JSON.stringify(soul); }
function importSoul(text) { try { return JSON.parse(text); } catch (e) { return null; } }   // pass to applySoul()

if (typeof module !== "undefined" && module.exports) {
  module.exports = { acquireSoulWriter: acquireSoulWriter, soulWriterRelease: soulWriterRelease,  SOUL_FORMAT: SOUL_FORMAT, SEED_IDENTITY: SEED_IDENTITY, SEED_WANTS_LEGACY: SEED_WANTS_LEGACY, isSeedWants: isSeedWants, freshSoul: freshSoul, loadSoul: loadSoul,
    saveSoul: saveSoul, attachBody: attachBody, S: S, soulReact: soulReact, soulLog: soulLog, dreamCommit: dreamCommit,
    sanitizeSoulCfg: sanitizeSoulCfg, applySoul: applySoul, currentSoul: currentSoul, exportSoul: exportSoul, importSoul: importSoul,
    soulClean: soulClean, normalizeSoul: normalizeSoul, fullIdentity: fullIdentity, nameBlock: nameBlock, IDENTITY_CORE_CAP: IDENTITY_CORE_CAP,
    SOUL_CAPS_USUAL: SOUL_CAPS_USUAL, SOUL_CAPS_BIG: SOUL_CAPS_BIG, soulBigMemory: soulBigMemory, soulLimits: soulLimits, soulRoll: soulRoll,
    soulFit: soulFit, fitIdentity: fitIdentity, importOverflow: importOverflow, mergeSoulInto: mergeSoulInto,
    readStoredSoul: readStoredSoul, snapshotBase: snapshotBase, cleanDreamLimits: cleanDreamLimits, inTimeOrder: inTimeOrder,
    _setSOUL: function (x) { SOUL = x; }, _getSOUL: function () { return SOUL; } };
}
