# Vandal — Graffiti Style Taxonomy (reusable, code-driving)

A comprehensive, implementation-oriented catalogue of the most popular graffiti
styles for the **Vandal** co-op mural game. Every style is described so it can be
**generated from strokes** on Vandal's fixed wire — not as art-history trivia, but
as *how a real writer builds it, layer by layer, and how to fake that with our 6
tools + warm palette*.

Grounded in real graffiti glossaries and style guides (see **Sources** at the end).
Style images for study live in `reference/graffiti-set/` — noted per style as
`[ref: <file>]`.

> **Colour law (non-negotiable):** Vandal emits **warm tones only**. Absolutely
> **no violet / purple / magenta / indigo**. Some reference photos contain violet
> (e.g. a throw-up outline) — those are *shape/layer/process* references only; the
> colour we output is always remapped into the warm palette below.

---

## 0. The Vandal wire contract (read this first)

Everything below must be expressible on this fixed wire. Nothing here changes bytes.

### Tools (fixed enum — index travels on the wire)

| id | wire name | Vandal theme label | what it does | realism role |
|----|-----------|--------------------|--------------|--------------|
| 0 | `BRUSH`  | **MARKER (handstyle)** | tapered stamped stroke, tapers at both ends | tags, handstyle, calligraphy, ignorant, sketch guides |
| 1 | `LINE`   | **STRAIGHTEDGE** | one straight segment (drag endpoints) | 3D extrusion rails, block-letter stems, keyline straights, drip guides |
| 2 | `RECT`   | **ROLLER (fill block)** | axis-aligned filled box (drag bbox) | blockbuster fills, background panels, block-letter bodies |
| 3 | `CIRCLE` | **STENCIL** | filled ellipse (drag bbox) | bubble bowls, dots/eyes, stencil masses, cloud puffs, shine dots |
| 4 | `ERASER` | **BUFF (paint-over)** | reveals the wall ground `#F0E4CF` | cut negative space, "carve" chrome shine, buff mistakes, stencil counter-shapes |
| 5 | `SPRAY`  | **SPRAY CAN (hero)** | the can; size = **cap width** | fills, fades, clouds, outlines, drips — the workhorse |

### Size = cap / nib width

`SIZES = [6, 15, 32]` world px.

- **0 = skinny cap / fine nib** (6px): outlines, tags, details, cutbacks, shine flicks, thin handstyle.
- **1 = medium cap** (15px): throw-up fills, medium fades, 3D blocks, mid handstyle.
- **2 = fat cap / broad** (32px): blockbuster + backdrop fills, fast throwie fills, fat drips, roller-scale spray.

### Flags (bitfield)

- `SOFT = 1` → soft-edged / haloed spray. Use for **fades, clouds, backdrops, glows, mist**. Motion = slow misting.
- `FLAT = 2` → clean hard edge. Use for **crisp fills, outlines, keylines, blockbuster edges, stencil**. Motion = deliberate.
- (Marker/BRUSH tags typically read best FLAT for a crisp ink line; soft for a spray-tag halo.)

### Palette (index 0..13 — warm, no violet). This is the whole crayon box.

| idx | name | hex | role bucket |
|----|------|-----|-------------|
| 0 | cream / vanilla | `#F6ECD3` | brightest light → **highlights, shines, chrome top** |
| 1 | apricot | `#FBD1A0` | light warm, sand-ramp |
| 2 | mango | `#F9AE63` | mid orange, fill / fade |
| 3 | coral | `#FF8A6B` | soft red-orange, fill / bright keyline |
| 4 | vitamin C orange | `#F26B34` | hot orange, fill / ember |
| 5 | malcolm red | `#CE3B2E` | deep red, fill / shadow-warm |
| 6 | beach yellow | `#FFD873` | light yellow, fill / soft shine |
| 7 | divine yellow | `#FBC02D` | saturated yellow, fill / bright keyline |
| 8 | ocher brown | `#C6892C` | brown, shadow / chrome mid / earth |
| 9 | guacamole | `#AFC552` | yellow-green accent (only greens/cools below) |
| 10 | mojito green | `#6FBE8E` | green accent, foliage / character |
| 11 | caribbean teal | `#34AEA3` | teal accent (sparingly) |
| 12 | andes blue | `#4F9FD6` | blue accent (sky/backdrop only, sparingly) |
| 13 | bone black | `#2B2620` | **charcoal keyline / outline / shadow / tag ink** |

**Standing warm ramps** (referenced by name throughout — a "fade" = spray each in
order along the letter with `SOFT`):

- **Ember ramp** (heat): `6 → 7 → 2 → 4 → 5` (light yellow up to deep red). The default hero fade.
- **Sand ramp** (mellow): `0 → 1 → 2 → 8` (cream to brown).
- **Sun ramp**: `6 → 2 → 4` (three-stop quick fade for throwies).
- **Faux-chrome** (there is NO grey/silver in the palette): vertical fade `0 (top light) → 1 → 8 → 13 (bottom)` with a hard `0` cream shine band across the middle. This reads "metallic" because chrome is just a top-light / dark-bottom split. Do it FLAT-then-SOFT.
- **Cool accent** (use for backdrops, water, character skin, foliage — never the hero letters unless the style calls for it): `9 → 10 → 11 → 12`.
- **Keyline defaults**: `13` bone black (classic). Bright alternates: `7` divine yellow, `3` coral, `11` teal.
- **Shine / highlight**: almost always `0` cream; occasionally `6` beach yellow.

### The realism rule (drives motion, not just colour)

The renderer keeps **path geometry + stroke overlap** and **discards point density**.
So realism reads only through:

1. **Cursor motion** — is the stroke *fast/ballistic* (whipped in one gesture) or
   *slow/patient* (crawled)? Arrows, tags, drips, shines = fast. Fills, fades,
   outlines = slow.
2. **Path shape** — the polyline itself. A tag is *one* confident continuous path;
   a fade is many overlapping slow passes.
3. **Overlap order** — later strokes sit on top (z = paint order). Recut the outline
   *on top of* the fill; shines go last.

Each style below states its **motion signature** so the generator/bot picks the
right cursor tempo.

### The canonical layer stack (z-order = paint order)

Defined once here; each style says which layers it **keeps** and which it **skips**.

| # | layer | Vandal tool(s) | motion | notes |
|---|-------|----------------|--------|-------|
| 1 | **sketch / guide** | BRUSH0 or SPRAY5 skinny, faint colour | fast, loose | letter skeleton; often buffed or covered later |
| 2 | **base fill** | SPRAY5 med/fat, or RECT2 roller | fast back-and-forth | flat interior colour |
| 3 | **fades / blends** | SPRAY5 `SOFT` | slow mist | ramp inside the fill |
| 4 | **background / backdrop** | RECT2 / SPRAY5 `SOFT` / CIRCLE3 | slow | halo, clouds, panel behind letters |
| 5 | **3D / extrusion** | LINE1 rails + RECT2/SPRAY5 fill | medium straight pulls | drop-shadow block or vanishing-point solid |
| 6 | **outline recut** | SPRAY5 skinny `FLAT` (or BRUSH0) | slow, careful | re-cut the letter edge *on top of* fill + 3D |
| 7 | **keyline / forcefield (outer) + inline (inner)** | SPRAY5 skinny / LINE1 | slow | thin second line tracing the whole piece; inline traces inside the letter |
| 8 | **highlights / shines / sparkles** | SPRAY5 skinny `0`, CIRCLE3 dots | fast flicks | brightest warm; placed last, allowed to cover fill |
| 9 | **drips** | SPRAY5 / LINE1 downward | fast pull + gravity dot | run from heavy edges |
| 10 | **signature / tag / crew / halo** | BRUSH0 skinny | fast gesture | the writer's mark; sometimes a `SOFT` glow ring around the piece |

**Glossary of the layer terms** (definitions from real glossaries — Sources):

- **Fill / fill-in** — the painted interior of the letters, usually one solid colour.
- **Fade / blend** — smooth aerosol transition between shades inside a fill or backdrop.
- **Outline** — the line defining the letter edge; the *recut* outline is re-sprayed on top of the finished fill.
- **Keyline / forcefield** — a thin outer line tracing the whole piece to pop it off the wall (often a bright colour).
- **Inline** — a thin line *inside* the letter, echoing the outline.
- **3D / extrusion** — perspective sides that give the letters volume (drop toward one vanishing point).
- **Drop shadow** — a flat offset shadow behind letters (a cheaper "3D").
- **Highlight / shine** — bright reflective accents/dots added last; "what makes a piece shine."
- **Drip** — paint running downward; sometimes intentional for style.
- **Cutback / recut** — cleaning the letter edge by re-cutting it with fill-ground or a fresh outline pass.
- **Cap** — the nozzle: **skinny/thin** = precise line, **fat** = wide cloud/fill.

---

# PART A — Handstyles & tags (one gesture, the writer's DNA)

## A1. Tag / handstyle (signature)
`[ref: graffiti-set/tag_anarchist.jpg, classic-styles/tag_panel_train_NL_*.jpg]`

1. **One-liner + origin.** The stylised signature of the writer — the atomic unit
   of graffiti. NYC late-1960s/70s (TAKI 183, Julio 204). One colour, done in seconds.
2. **Anatomy.** A single continuous gestural path spelling a short name; personal
   flourishes — extended tails, loops, a bar/underline, a couple of connected
   letters, sometimes 3 dots or a crown/arrow. Legibility optional; *flow* is everything.
3. **Layer build.** Skip everything but **(10) signature**. One pass. Optional: a
   second faster underline/arrow, and 2–3 tiny highlight ticks.
4. **Colour.** One colour. Default `13` bone black. Street-marker alternates: `4`
   vitamin C, `5` malcolm red, `8` ocher. On a dark spot, `0` cream. No fill.
5. **Tools / caps / speed.** `BRUSH0` (marker) size 0 `FLAT` for ink; or `SPRAY5`
   skinny cap for a spray-tag. **Motion: fast + ballistic** — the whole name in one
   confident whip, no hesitation. Speed matters more than accuracy.
6. **Words/subjects.** Short handles: `REKS`, `SANE`, `ORE`, `VOID`, `ZERO`, `ACHE`,
   `FUME`, `NOVA`; add-ons: `est.`, `one`, `+ crew`, a crown, three dots, an arrow tail.

## A2. Handstyle / calligraphy tag (chisel-nib, "one-liner")

1. **One-liner + origin.** A tag elevated by calligraphic contrast — thick/thin
   strokes from a broad nib. Rooted in the "Broadway Elegant" thin-line school and
   sign-painting; the ancestor of modern calligraffiti.
2. **Anatomy.** Same signature gesture, but stroke **weight modulates**: fat on the
   pull-down, hair-thin on the up. Ligatures connect letters; long entry and exit
   swashes bracket the word.
3. **Layer build.** Just **(10) signature**, optionally + a thin `inline` echo.
4. **Colour.** One colour, `13` bone black or `8` ocher; on dark, `0` cream. A single
   `4`/`5` accent underline is common.
5. **Tools / caps / speed.** `BRUSH0` (tapered marker sells thick/thin) size 1 for
   body, size 0 for hairlines. **Motion: fast but controlled** — pressure-timed pulls,
   not scribble. The taper in the BRUSH engine does the weight modulation for free.
6. **Words/subjects.** `flow`, `ink`, `est. 88`, `one love`, `handstyle`, plus the
   writer's name in a swashy script.

## A3. Pichação / pixação (São Paulo cryptic tall letters)

1. **One-liner + origin.** Brazil's own script — tall, thin, cryptic, angular
   letters stacked vertically. São Paulo, early 1980s; from *pichar*, "to tar."
2. **Anatomy.** **Extremely vertical, equal-height** glyphs built from straight
   verticals with sharp/hooked ends — runic, borrowed from heavy-metal band logos
   (AC/DC, Iron Maiden, Slayer). Angular, spiky, no curves; letters **do not cross**,
   they stack. Deliberately hard to read (inner-circle code).
3. **Layer build.** **(10) only.** No fill, no 3D. Pure straight-line skeleton +
   sharp terminals. On the wire it is essentially a run of `LINE1` segments.
4. **Colour.** Monochrome — `13` bone black (tar). Single colour, nothing else.
5. **Tools / caps / speed.** `LINE1` for the rigid verticals + `BRUSH0` skinny for
   hooks; or `SPRAY5` skinny drippy. **Motion: fast, straight, jabby** — down-strokes
   pulled hard, terminals flicked. Rollers/extension poles reach absurd heights.
6. **Words/subjects.** Crew ciphers, angular initials, stacked syllables — treat as
   abstract runic glyph rows rather than readable words.

## A4. Cholo / Placas (LA blackletter gang lettering)

1. **One-liner + origin.** Latino gang *placas* (plaques) marking turf — Los Angeles,
   the oldest US graffiti lineage (1930s–40s), predating NYC tags. A strict, evolving
   Old-English/blackletter urban calligraphy.
2. **Anatomy.** Tall **blackletter / Old English** capitals with pointed serifs and
   dense vertical strokes; also "saloon"/western and square-block variants. Formal,
   monumental, upright, evenly spaced — placed at neighbourhood edges as boundary marks.
3. **Layer build.** **(2) base fill** (single flat) + **(6) sharp outline**; usually
   **no fade, no 3D**. Sometimes a thin `inline`. Restraint is the aesthetic.
4. **Colour.** Monochrome or two-tone: `13` bone black letters; occasional `5`
   malcolm red or `8` ocher. Cream `0` on dark walls.
5. **Tools / caps / speed.** `SPRAY5` skinny `FLAT` or `BRUSH0` for the crisp
   blackletter edges; `LINE1` for the ruler-straight stems. **Motion: slow +
   deliberate** — this is formal calligraphy, precision over speed.
6. **Words/subjects.** Neighbourhood/crew names, roman-numeral set numbers, `R.I.P.`,
   `C/S` (con safos), `13`, `x3`, family/street names in blackletter caps.

## A5. Japanese handstyle (rakugaki — kanji / katakana)

1. **One-liner + origin.** Tokyo handstyles that fuse Western tag mechanics with
   **kanji, katakana, hiragana**, plus manga/ukiyo-e motifs. "Rakugaki" (scribble);
   modern scene led by crews like 246, writers like Imaone.
2. **Anatomy.** Western letterform logic (flow, connections, arrows) applied to
   Japanese strokes — bold brushed radicals, katakana angles, calligraphic
   thick/thin. Frequently paired with a small manga/anime character or wave motif.
3. **Layer build.** For a tag: **(10)** brush gesture. For a piece: **(2) fill →
   (3) fade → (6) outline → (8) shine**, letters replaced by kanji/katakana shapes.
4. **Colour.** Ink `13` bone black for the brush stroke; piece work uses **Ember
   ramp** fills with `5`/`4` (rising-sun reds/oranges) and `0` shines.
5. **Tools / caps / speed.** `BRUSH0` (the tapered engine mimics a sumi brush) for
   the calligraphic stroke; `SPRAY5` for piece fills. **Motion: fast, committed brush
   pulls** — one breath per character; a wobble kills it.
6. **Words/subjects.** Katakana of the writer's name, kanji like 風 (wind), 龍
   (dragon), 火 (fire), 波 (wave); small koi, carp, wave, or oni-mask companion.

---

# PART B — Fast fills & bombs (speed over polish)

## B1. Throw-up / throwie
`[ref: graffiti-set/classic-styles/throwup_spleen_notcharizard_*.jpg, piece_aresone.jpg]`

1. **One-liner + origin.** The middle ground between tag and piece — a quick 2-ish
   letter name, outline + one-colour fill, painted in under a minute. NYC subway era;
   the bomber's bread and butter.
2. **Anatomy.** Fat rounded **bubble** letters, minimal negative space, often just
   2 letters that touch/overlap. **Hollow** = outline only, no fill; **fill-in** =
   outlined + filled. Confidence reads through clean, fast curves.
3. **Layer build.** **(2) fill** (or fill first, outline over) → **(6) one outline**.
   That's it. Optional: **(8)** two or three quick cream shines; **(9)** a couple of
   drips. Skip fades/3D/keyline.
4. **Colour.** Two colours: fill `0` cream (or `6`/`7`) + outline `13` bone black, or
   fill `7` divine yellow + outline `5` malcolm red. Classic warm throwie = yellow
   fill, red or black outline.
5. **Tools / caps / speed.** Fill: `SPRAY5` **fat cap (size 2)** `FLAT`, or `RECT2`/
   `CIRCLE3` masses. Outline: `SPRAY5` **skinny (size 0)** `FLAT`. **Motion: fast +
   ballistic** on both — the outline is one continuous confident loop, fill is rapid
   back-and-forth. Whole thing in seconds.
6. **Words/subjects.** 2-letter combos: `OK`, `SE`, `TA`, `RE`, `VU`, `ZO`; hearts,
   stars, a fat exclamation mark.

## B2. Bubble letters (softies)
`[ref: graffiti-set/piece_aresone.jpg]`

1. **One-liner + origin.** Enormous puffy, well-formed rounded letters. Invented by
   **PHASE 2** in NYC, 1972 (a.k.a. "softies" / Bronx style) as a reply to the thin
   "Broadway Elegant" line. The parent of the throw-up.
2. **Anatomy.** Each letter = **inflated balloon** forms; rounded bowls, no sharp
   corners, generous even thickness, letters kiss or overlap. Micro-variants add
   stars ("Phasemagorical"), clouds ("Bubble Cloud"), or oversized tops ("Big Top").
3. **Layer build.** **(2) fill → (3) inside fade → (6) outline → (7) keyline →
   (8) shines.** More finished than a throwie — closer to a piece but still round.
4. **Colour.** Fill = **Sun ramp** `6 → 2 → 4`; outline `13`; keyline `3` coral or
   `7` yellow; shines `0`.
5. **Tools / caps / speed.** Bowls with `CIRCLE3` (STENCIL) masses or `SPRAY5` fat
   cap; outline `SPRAY5` skinny `FLAT`. **Motion: medium** — rounder and more careful
   than a throwie, but still flowing curves, not fussy.
6. **Words/subjects.** Same short names as throwies; add stars, little clouds,
   bubbles as decoration.

## B3. Blockbuster (big block letters, roller fills)
`[ref: graffiti-set/wholehouse_berlin.jpg (whole-wall context)]`

1. **One-liner + origin.** Huge, blunt, **straight block letters** built to own a
   whole wall fast with only 2–3 colours. Painted with **rollers + bucket paint**,
   often up high and far from viewers.
2. **Anatomy.** Massive rectangular slab letters, thick even strokes, wide spacing,
   ruler-straight — designed for maximum coverage and long-distance legibility.
3. **Layer build.** **(2) block fill** (roller) → **(6) hard outline** in the second
   colour → optional **(5) flat drop shadow**. No fades, no shines. Bold and flat.
4. **Colour.** Two-tone, high contrast: `13` bone black letters on `0` cream, or `5`
   malcolm red on `6` beach yellow. Third colour only for a drop shadow (`8` ocher).
5. **Tools / caps / speed.** `RECT2` (ROLLER) for the slab bodies — this is *the*
   roller tool. `LINE1` for straight edges, `SPRAY5` fat for touch-ups. **Motion:
   fast, big, straight** — long roller pulls; coverage speed is the whole point.
6. **Words/subjects.** Short bold words: `RUN`, `MOB`, `FLY`, crew initials, a year.

## B4. Roller / fire-extinguisher (big drippy pieces)

1. **One-liner + origin.** Extreme coverage: extension-pole rollers and paint-loaded
   **fire extinguishers** that throw fat, gushing, dripping lines across huge or high
   surfaces. Raw, gestural, unrefined by design.
2. **Anatomy.** Thick gestural strokes and loops rather than fine letterforms; heavy
   uncontrolled **drips** are the signature. Legibility is loose; scale and reach dominate.
3. **Layer build.** **(2) gestural fill/strokes → (9) drips** (which happen on their
   own). Optionally a **(6)** loose outline. Skip fine layers entirely.
4. **Colour.** One or two bold colours: `13` bone black, `5` malcolm red, or `0`
   cream. High contrast to the wall.
5. **Tools / caps / speed.** `RECT2` roller strokes + `SPRAY5` **fat cap** for the
   extinguisher gush; `LINE1` downward for exaggerated drips ending in a `CIRCLE3`
   pool. **Motion: fast, sweeping, loose** — heavy vertical pulls that intentionally
   over-load and run.
6. **Words/subjects.** Big single words/initials, political slogans, a crew name at
   mural scale.

## B5. Ignorant style / anti-style (deliberately crude)
`[ref: graffiti-set/phrases-slogans/*.jpg (raw hand-lettered text)]`

1. **One-liner + origin.** Intentionally naive, "childlike," rule-breaking lettering.
   "Ignorant style" pioneered by French writer **FUZI** (early 2000s) — "as if made
   by a child just learning." **Anti-style** rejects all traditional style rules on purpose.
2. **Anatomy.** Wobbly, uneven, unbalanced letters; no fade, no 3D, no flow — the
   crudeness *is* the point. Simple line letters, occasional crude character or
   smiley, blunt humour.
3. **Layer build.** **(6) outline only**, or **(2) flat fill + (6) outline**. Skip
   fades, keylines, shines. Imperfection is preserved, not cleaned.
4. **Colour.** One or two flat colours, often clashing on purpose within the warm
   set: `5` malcolm red + `7` divine yellow, or just `13` bone black.
5. **Tools / caps / speed.** `BRUSH0` marker or `SPRAY5` skinny, `FLAT`. **Motion:
   fast and casual** — do *not* correct wobble; the shaky path is the aesthetic. Great
   fit for bots that produce imperfect strokes.
6. **Words/subjects.** Blunt one-liners, jokes, crude smiley/skull, `NO`, `HI`,
   `oops`, a lopsided heart.

---

# PART C — Letter-structure styles (the craft ladder)

## C1. Block / straight letters
`[ref: graffiti-set/classic-styles/tag_panel_train_NL_*.jpg (panel context)]`

1. **One-liner + origin.** Big, bold, **readable** letters with personal flair — the
   step up from throw-ups toward pieces. The daily-driver "clean and legible" style.
2. **Anatomy.** Squared, upright, even-weight letters; slight custom serifs or bar
   tweaks but always legible. Solid structure, no interlock.
3. **Layer build.** **(2) fill → (3) light fade → (5) drop shadow or 3D → (6)
   outline → (8) shines.** A restrained, readable piece.
4. **Colour.** Fill = **Sand** or **Ember** ramp; outline `13`; 3D block `8` ocher
   (a darker warm reads as shadow); shines `0`.
5. **Tools / caps / speed.** `RECT2`/`LINE1` for the straight bodies, `SPRAY5` skinny
   outline, medium fill. **Motion: medium/patient** on structure and outline; fast
   on shines. Straight edges want the `LINE1` tool, not a freehand wobble.
6. **Words/subjects.** The writer's name spelled clearly; crew tag beneath.

## C2. Semi-wildstyle (semi-wild)
`[ref: graffiti-set/wildstyle_california_defame_*.jpg (compare to full wild)]`

1. **One-liner + origin.** The borderline between straight letters and wildstyle —
   more elaborate arrangement and a few style elements, but **still legible**.
2. **Anatomy.** Letters lean, bend, and add some arrows/connections and serif spikes,
   but you can still read the word. A few overlaps, not a full interlock.
3. **Layer build.** Full-ish piece: **(1) sketch → (2) fill → (3) fade → (5) 3D →
   (6) outline → (7) keyline → (8) shines → (9) drips.** Fewer arrows than wildstyle.
5→ colours/tools as C3 but calmer.
4. **Colour.** **Ember ramp** fill, `13` outline, `7` divine-yellow keyline, `0` shines,
   `8` 3D. One cool accent (`11` teal) allowed in the backdrop.
5. **Tools / caps / speed.** `SPRAY5` across; `LINE1` for arrow shafts + 3D rails.
   **Motion: mixed** — slow on fills/outline, **fast flicks** on the few arrows.
6. **Words/subjects.** The writer's name with 1–2 arrow extensions and a couple of
   connected letters.

## C3. Wildstyle
`[ref: graffiti-set/wildstyle_halloffame.jpg, wildstyle_germany_kochstudio_*.jpg, wildstyle_california_defame_*.jpg]`

1. **One-liner + origin.** The most complex piece style — letters interlock, bend,
   spike and merge with **arrows, connections and force-fields** until nearly
   illegible to outsiders. NYC 1970s (associated with Tracy 168); the genre's summit.
2. **Anatomy.** Heavily exaggerated, **interlocking/intertwined** letters woven with
   arrows, spikes, bars and connections; negative space becomes part of the design.
   Reading it is a puzzle — flow and geometry over legibility.
3. **Layer build (all layers):** **(1) sketch → (2) base fill → (3) fades →
   (4) backdrop → (5) 3D/extrusion → (6) outline recut ON TOP → (7) keyline/forcefield
   + inline → (8) highlights/shines → (9) drips → (10) signature.** The full stack.
4. **Colour.** Hero fill = **Ember ramp** `6→7→2→4→5`; 3D = `8` ocher or `13`; outline
   `13`; forcefield keyline `7` or `3` (bright); inline `0`; shines `0`; backdrop a
   soft **cool accent** cloud (`11`/`12`, `SOFT`). Arrows often `13` with a `0` inline.
5. **Tools / caps / speed.** `SPRAY5` for fill/fade/outline (skinny for cut, med for
   fill), `LINE1` for arrow shafts and 3D rails, `CIRCLE3` for shine dots, `RECT2` for
   backdrop panels. **Motion: slow + patient** on fills, fades, outline, keyline;
   **fast + ballistic** on arrows, spikes, and shines. This contrast is what sells it.
6. **Words/subjects.** The writer's name (illegibility expected); arrows, lightning
   bolts, stars, bars, a crown, connection bridges between letters.

## C4. Dubstyle / FX

> **Sourcing note:** "Dubstyle" is a scene term with lighter formal documentation
> than the others. Below reflects common usage: a bold, readable, **FX-loaded**
> semi-wild lineage associated with 90s Swiss/European writers (Dare, Toast/Bozaci,
> Daim) — treat as the "chunky letters + maximal effects" family.

1. **One-liner + origin.** Chunky, bold, still-readable letters overloaded with
   **effects** — bubbles, cracks, chrome, sparkles, gloss. European (Swiss) 1990s.
2. **Anatomy.** Rounded fat letter bodies (dub = doubled/thick) with heavy surface
   FX: cracks, bevels, bubble highlights, cast reflections, and busy inlines. Reads
   as a candy/comic-glossy version of a piece.
3. **Layer build.** **(2) fill → (3) fade → (5) bevel/3D → (6) outline → (7) inline +
   keyline → (8) many shines/sparkles (heaviest of any style) → (9) drips.** The FX
   layer (8) is the star.
4. **Colour.** Glossy **Ember** or **Sun** fill; faux-chrome bevel (`0→1→8→13`);
   outline `13`; multiple `0` cream sparkles + `6` secondary shines; `3` coral keyline.
5. **Tools / caps / speed.** `SPRAY5` skinny for FX detail, `CIRCLE3` for bubble
   highlights and sparkle dots, `LINE1` for crack lines and star-spark rays.
   **Motion: slow** on bevels/inline, **fast flick** on the many sparkles/cracks.
6. **Words/subjects.** The writer's name; sparkles, star-glints, cracks, bubbles,
   drip-gloss, a comic "shine" burst.

## C5. 3D style / anamorphic
`[ref: study wildstyle_halloffame.jpg for the chrome-3D letters]`

1. **One-liner + origin.** Letters rendered as **solid volumetric objects** with real
   perspective — no flat outline; they appear to float or extrude off the wall.
   Pioneered by **DAIM** (early 90s, outline-less floating letters) and **Odeith**
   (2005, "sombre 3D" / anamorphic illusions read correctly from one viewpoint).
2. **Anatomy.** Every letter is a 3D solid built to one or more **vanishing points**;
   form is defined by **light and shadow gradients**, not a keyline. Anamorphic
   variants distort geometry so the illusion snaps together from a chosen angle.
3. **Layer build.** **(1) perspective sketch (vanishing point) → (2) base fill per
   face → (3) fades that model light (bright face, dark face) → (5) extrusion sides →
   (8) sharp highlights on lit edges + (via ERASER4/`0`) hard shine lines → cast
   shadow on the "ground."** **Skip (6) outline and (7) keyline** — that is the point.
4. **Colour.** Faux-chrome or single-hue value study: lit faces `0`/`1`, mid `2`/`8`,
   shadow `13`; cast shadow `13` `SOFT`. Warm monochrome value ramps read most "3D."
5. **Tools / caps / speed.** `LINE1` for every perspective rail (essential),
   `RECT2`/`SPRAY5` for face fills, `SPRAY5` `SOFT` for the modelling fades,
   `ERASER4` to carve crisp light edges. **Motion: slow + geometric** — this is the
   most patient, ruler-driven style; the straight `LINE1` rails to a shared vanishing
   point do the heavy lifting.
6. **Words/subjects.** Short names as blocky solids; floating cubes, extruded arrows,
   a shadow puddle, a metallic sphere.

## C6. Old-school NYC subway style
`[ref: graffiti-set/classic-styles/tag_panel_train_NL_*.jpg, piece_aresone.jpg]`

1. **One-liner + origin.** The 1970s NYC subway-car look: "Broadway Elegant" thin
   letters with bold serifs (brought up from Philadelphia by Julio 204/TAKI 183/
   Topcat 126), and PHASE 2's bubble/softie evolution. Where "style" was born.
2. **Anatomy.** Two poles: (a) **thin, tall, serifed** letters ("Broadway Elegant")
   and (b) **puffy bubble** letters. Simple stars, clouds, a crown; letters sit in a
   long horizontal panel matching a train car.
3. **Layer build.** **(2) fill → (6) outline → (8) simple stars/shines.** Early, so
   fewer layers — no heavy 3D or force-fields yet; charm is in the clean simplicity.
4. **Colour.** Limited retro warm sets: `7` yellow + `5` red + `13` outline; or `0`
   cream + `4` orange. Two to three colours max.
5. **Tools / caps / speed.** `SPRAY5` skinny outline + medium fill; `LINE1` for
   serifs and the panel baseline; `CIRCLE3` for star/cloud bits. **Motion: medium,
   even** — clean and unhurried, period-appropriate restraint.
6. **Words/subjects.** Name + number handle (`183`, `204`), crown, stars, clouds,
   `TOP` / `CITY`, a subway-line letter in a circle.

---

# PART D — Full pieces, contexts & sub-genres

## D1. Piece / masterpiece / burner (full-colour)
`[ref: graffiti-set/piece_aresone.jpg, wildstyle_halloffame.jpg]`

1. **One-liner + origin.** "Piece" (from *masterpiece*) = a large, multi-colour,
   fully-rendered name with fills, fades, 3D, background and characters. A **burner**
   is an especially accomplished piece. The full expression of the craft.
2. **Anatomy.** Structured, spaced letters (can be straight or wild) given the entire
   layer treatment: fades, 3D, backdrop, force-field, shines, often a companion character.
3. **Layer build.** **The full canonical stack (1–10).** This style is the reference
   implementation of the layer table in §0.
4. **Colour.** Hero **Ember ramp** letters; **cool accent** backdrop; `8`/`13` 3D;
   `13` outline; bright `7`/`3` keyline; `0` shines; character in its own scheme.
5. **Tools / caps / speed.** Every tool: `SPRAY5` (fills/fades/outline), `LINE1`
   (3D/arrows), `RECT2` (backdrop/roller base), `CIRCLE3` (shines/bits), `BRUSH0`
   (signature), `ERASER4` (carve highlights). **Motion: the full slow/fast rhythm** —
   patient fills+outline, ballistic arrows+shines. Takes the longest.
6. **Words/subjects.** The writer's name as hero; crew name; a character; backdrop
   scenery (city skyline, clouds, sun).

## D2. Heaven / rooftop spots

1. **One-liner + origin.** Not a letter style but a **placement genre** — pieces in
   dangerous, hard-to-reach "heaven" spots (rooftops, bridges, billboards) for maximum
   visibility and respect. Any style, executed under constraint.
2. **Anatomy.** Whatever the writer's style is, adapted to the spot: often bold
   blockbuster or straight letters (must read from far / from the train), high contrast.
3. **Layer build.** Usually a fast subset — **(2) fill → (6) outline → (8) shine** —
   because time and safety are limited. Rarely the full stack.
4. **Colour.** Maximum contrast for distance: `0` cream or `7` yellow on the wall +
   `13`/`5` outline. Bold, simple, few colours.
5. **Tools / caps / speed.** `SPRAY5` fat + `RECT2` for speed. **Motion: fast** — the
   spot rewards efficiency. In-game: render high on the canvas, big and legible.
6. **Words/subjects.** Big name/crew, a year, a location shout, an arrow pointing down.

## D3. Freight / train (American benching) style

1. **One-liner + origin.** Graffiti painted on freight cars to **travel the country**;
   "benching" = watching/photographing passing trains (from NYC's 149th St "Writers
   Bench"). A whole culture of rolling galleries.
2. **Anatomy.** Fitted to the car panel: often bold **straight letters, chrome-and-
   outline** pieces, and characters, sized to the corrugated steel; monikers/streaks
   (oil-bar hobo marks) sit alongside.
3. **Layer build.** Classic freight combo: **(2) chrome fill → (6) black outline →
   (5) 3D → (8) shines** — the "chrome and outline" workhorse. Fast enough for a yard.
4. **Colour.** **Faux-chrome** fill (`0→1→8→13`) + `13` outline + `5`/`4` accents; or
   two bold flats. The chrome-silver-and-black look is the freight signature (faked warm).
5. **Tools / caps / speed.** `SPRAY5` fat fill + skinny outline; `LINE1` for panel
   baseline and 3D. **Motion: fast, panel-fitted** — efficient in a yard under time pressure.
6. **Words/subjects.** Name across a panel, crew, a moniker/streak, `benching`, a
   small hobo-style character, route numbers.

## D4. Stencil (Banksy-style, negative space)
`[ref: graffiti-set/stencils/*.jpg — gorilla, Bruce Lee, koi, anarchy-A]`

1. **One-liner + origin.** Image cut from card and sprayed through — crisp, repeatable,
   **negative-space** imagery. Fast to deploy, precise, political (Blek le Rat →
   Banksy lineage). *(Do not reproduce Banksy artwork; study only — see attribution.)*
2. **Anatomy.** High-contrast shapes defined by cut edges; forms read through solid
   masses and the gaps ("bridges") between them. Often 1-colour; multi-layer stencils
   add tones. Clean, mechanical edges — no freehand wobble.
3. **Layer build.** **(4/2) mask the shape → spray solid.** In Vandal: lay the mass
   with `CIRCLE3`/`RECT2`, then use `ERASER4` to **carve the negative-space counter-
   shapes** (eyes, gaps), giving the crisp stencil look. Multi-tone = repeat with a
   darker colour offset. Skip outline/fade/shine.
5. **Colour.** One flat colour (`13` bone black is classic) on the wall; or a 2-tone
   `13` + `5`. A colour "splash" backdrop panel (`4`/`7`, `SOFT`) behind is a common
   Banksy device.
6. **Tools / caps / speed.** `CIRCLE3`/`RECT2` for masses, `ERASER4` for cut-outs,
   `SPRAY5` `SOFT` for the backdrop wash. **Motion: quick, stamped** — the shape tool
   places instantly; short spray bursts. Precision comes from the tool, not the hand.
6→ **Words/subjects.** Silhouettes: rat, gorilla, koi, dove, stencil portrait, circle-A,
   a slogan in stencil font, a child, a balloon.

## D5. Character / mascot (cartoon, cel-shade)
`[ref: graffiti-set/character_bordalo.jpg, characters-japanese/koi_*.jpg, simple_blueheart.jpg]`

1. **One-liner + origin.** Painted characters/mascots that accompany or replace
   letters — cartoon figures, animals, B-boys, monsters. From subway-era companions to
   full mural characters (e.g. Bordalo II animals).
2. **Anatomy.** Bold clean **cel-shaded** forms: flat base colour + one shadow tone +
   one highlight tone, wrapped in a confident black outline. Exaggerated cartoon
   proportions; expressive face.
3. **Layer build.** **(1) sketch → (2) flat base fills → (3) one cel shadow +
   one highlight (hard-edged, not smooth) → (6) bold outline → (8) eye/tooth shine.**
   Cel-shade = few flat tones, not gradients.
4. **Colour.** Per-part flats from the warm set + **cool accents** allowed here (skin
   `1`/`3`, foliage `10`, water `11`/`12`); shadow = the darker warm neighbour or `8`;
   outline `13`; eye shine `0`.
5. **Tools / caps / speed.** `SPRAY5` med/skinny for fills + outline, `CIRCLE3` for
   eyes/cheeks/round masses, `BRUSH0` for the outline if a hand-drawn line is wanted,
   `ERASER4` for clean highlights. **Motion: slow + careful** on outline and shapes;
   fast dots for eye shines. Legible silhouette matters most.
6. **Words/subjects.** B-boy/B-girl, spray-can mascot, cartoon dog/cat, monster,
   koi/carp, dove, robot, a winking sun; simple icons (heart, star) for beginners.

## D6. Calligraffiti / brush calligraphy

1. **One-liner + origin.** Fusion of **calligraphy + typography + graffiti** — flowing
   brushed letters as expressive marks. Term coined by Dutch artist **Niels "Shoe"
   Meulman** (2007); ancestors in Arabic calligraphy and sign-writing.
2. **Anatomy.** Long, rhythmic strokes with strong **thick/thin contrast** and
   ligature flow; the word becomes gesture. Often monochrome, letting form and rhythm
   carry it; may spiral or wrap rather than sit on a baseline.
3. **Layer build.** **(10) the gesture** — one to a few confident modulated strokes;
   optional **(7) thin inline** echo and a **(4) soft wash** backdrop.
4. **Colour.** Ink `13` bone black (or `8` ocher) on a light wall; single accent
   `4`/`5`. Restraint is the aesthetic — one, maybe two colours.
5. **Tools / caps / speed.** `BRUSH0` (the tapered stamp *is* a broad nib — thick on
   pull, thin on lift) size 1–2 for body, size 0 for hairlines; `SPRAY5` `SOFT` for
   a backdrop wash. **Motion: fast but controlled** — pressure-timed, single-breath
   strokes; hesitation shows.
6. **Words/subjects.** Single powerful words: `flow`, `peace`, `amor`, `libre`,
   `vandal`, `one love`, a name in flowing script, an Arabic-style flourish.

---

# PART E — Regional / cultural notes (flavour switches, not new letterforms)

Use these as **presets** that bias palette, layer emphasis and motion for an existing
style, so the mural feels like a real city.

- **New York (birthplace).** Bubble/softie + Broadway-Elegant + wildstyle; subway-
  panel horizontal format; crowns, stars, clouds; retro 2–3 colour sets. Emphasis on
  outline + simple shines over heavy 3D.
  `[ref: classic-styles/*]`
- **European (esp. German/Swiss/Berlin).** Clean burners, dubstyle FX, whole-car and
  **whole-house** productions; polished fades, chrome-and-outline, strong backdrops.
  `[ref: wholehouse_berlin.jpg, wildstyle_germany_kochstudio_*.jpg]`
- **Japanese (Tokyo).** Kanji/katakana handstyles + manga characters + ukiyo-e motifs
  (wave, koi, oni, rising sun); calligraphic brush energy; **Ember/red** hero palette.
  `[ref: characters-japanese/koi_*.jpg]`
- **Latin American — Brazil (São Paulo).** Pichação: tall runic monochrome stacks,
  extreme-height heaven spots, `13` bone black only; anti-establishment tone.
- **Latin American — LA/Chicano.** Cholo placas: blackletter/Old-English, monochrome,
  formal, boundary-marking; C/S, roman numerals; restrained palette.
- **Slogans / phrases (global).** Text-forward walls: political/positive one-liners in
  ignorant or calligraffiti hand; high-contrast, few colours.
  `[ref: phrases-slogans/*.jpg]`

---

# Quick implementation cheat-sheet (per style → wire preset)

| Style | Hero tool(s) | Cap/size | Flag | Palette (fill / outline / accent) | Motion | Layers used |
|-------|--------------|----------|------|-----------------------------------|--------|-------------|
| Tag | BRUSH0 | 0 | FLAT | 13 / — / — | fast ballistic | 10 |
| Calligraphy tag | BRUSH0 | 0–1 | FLAT | 13 / — / 5 | fast controlled | 10 (+7) |
| Pichação | LINE1+BRUSH0 | 0 | FLAT | 13 / — / — | fast jabby | 10 |
| Cholo/Placas | SPRAY5/BRUSH0/LINE1 | 0 | FLAT | 13 / — / 5 | slow deliberate | 2,6 |
| JP handstyle | BRUSH0 | 0–1 | FLAT | 13 / — / 5,4 | fast brush | 10 (or 2,3,6,8) |
| Throw-up | SPRAY5 | 2 fill/0 out | FLAT | 0 or 7 / 13 or 5 / — | fast ballistic | 2,6 (+8,9) |
| Bubble letters | CIRCLE3+SPRAY5 | 2/0 | FLAT | Sun ramp / 13 / 3 | medium | 2,3,6,7,8 |
| Blockbuster | RECT2+LINE1 | 2 | FLAT | 13 / 0 / 8 | fast big straight | 2,6 (+5) |
| Roller/extinguisher | RECT2+SPRAY5+LINE1 | 2 | FLAT | 13/5/0 / — / — | fast sweeping | 2,9 |
| Ignorant/anti | BRUSH0/SPRAY5 | 0 | FLAT | 5+7 / 13 / — | fast casual (keep wobble) | 6 (+2) |
| Block/straight | RECT2+LINE1+SPRAY5 | 0–1 | FLAT | Sand/Ember / 13 / 8 | medium | 2,3,5,6,8 |
| Semi-wildstyle | SPRAY5+LINE1 | 0–1 | mix | Ember / 13 / 7,11 | mixed | 1,2,3,5,6,7,8,9 |
| Wildstyle | SPRAY5+LINE1+CIRCLE3+RECT2 | 0–1 | mix | Ember / 13 / 7,3,11 | slow fills + fast arrows | 1–10 (all) |
| Dubstyle/FX | SPRAY5+CIRCLE3+LINE1 | 0 | mix | Ember/Sun / 13 / 3,0 | slow bevel + fast sparkle | 2,3,5,6,7,8,9 |
| 3D/anamorphic | LINE1+RECT2+SPRAY5+ERASER4 | 0–1 | SOFT+FLAT | chrome/value / — / 13 | slow geometric | 1,2,3,5,8 (no 6/7) |
| Old-school NYC | SPRAY5+LINE1+CIRCLE3 | 0–1 | FLAT | 7+5 or 0+4 / 13 / — | medium even | 2,6,8 |
| Piece/masterpiece | ALL | 0–2 | mix | Ember / 13 / cool + 7/3/0 | full slow+fast | 1–10 (all) |
| Heaven/rooftop | SPRAY5+RECT2 | 2 | FLAT | 0 or 7 / 13 or 5 / — | fast | 2,6,8 |
| Freight/benching | SPRAY5+LINE1 | 0–2 | mix | chrome / 13 / 5,4 | fast panel-fit | 2,5,6,8 |
| Stencil | CIRCLE3+RECT2+ERASER4+SPRAY5 | — | SOFT bg | 13 / — / 4,7 | quick stamped | mask+fill (2/4) |
| Character/mascot | SPRAY5+CIRCLE3+BRUSH0+ERASER4 | 0–1 | FLAT | flats+cool / 13 / 0 | slow careful | 1,2,3(cel),6,8 |
| Calligraffiti | BRUSH0+SPRAY5 | 0–2 | FLAT+SOFT bg | 13 / — / 4,5 | fast controlled | 10 (+4,7) |

---

# Sources

Graffiti glossaries and style guides used to ground this taxonomy:

- Bombing Science — [100+ Graffiti Terms Every Writer Should Know](https://www.bombingscience.com/100-graffiti-terms-every-writer-should-know/)
- Open Walls Gallery — [Street Art and Graffiti Words: The Ultimate Glossary](https://openwallsgallery.com/graffiti-words/)
- GraffitiBible — [Graffiti Glossary](https://graffitibible.com/graffiti-glossary/) and [How to Do Graffiti Shadows — Drop-down and 3D](https://graffitibible.com/how-to-do-graffiti-shadows-drop-down-and-3d-shadows/)
- Graff Storm — [Graffiti Styles: 18 Types of Graffiti That Define the Art](https://graffstorm.com/graffiti-styles)
- Graffiti Empire — [Graffiti Styles: 14 Types Explained](https://www.graffiti-empire.com/graffiti-styles/)
- Artsper Magazine — [Graffiti Styles You Need to Know](https://blog.artsper.com/en/a-closer-look/art-movements-en/graffiti-styles/)
- Wikipedia — [Wildstyle](https://en.wikipedia.org/wiki/Wildstyle), [Calligraffiti](https://en.wikipedia.org/wiki/Calligraffiti), [Dare (graffiti artist)](https://en.wikipedia.org/wiki/Dare_(graffiti_artist)), [Ata Bozaci / Toast](https://en.wikipedia.org/wiki/Ata_Bozaci), [Phase 2 (artist)](https://en.wikipedia.org/wiki/Phase_2_(artist))
- Machine Studio — [Full Graffiti Piece Tutorial (paint order)](https://machinestudio.com/blogs/graffiti-school/full-graffiti-piece-tutorial)
- MTN-World — [4 Keys to Understand Ignorant/Ghetto Style](https://www.mtn-world.com/en/blog/2016/01/09/4-keys-to-understand-ghetto-style/)
- Street Fame — [Graffiti Styles 101: The Official Street Bible](https://street-fame.com/graffiti-styles-101-the-official-street-bible/)
- Cantastic — [Heaven Spots: Flirting with Death for Immortality](https://www.cantastic.nl/en/blog/heaven-spots-in-graffiti/)
- Pichação: [Revista Pesquisa FAPESP — Between Transgression and Art](https://revistapesquisa.fapesp.br/en/between-transgression-and-art/), [Latinolife — Pixação: São Paulo's Urban Calligraphy](https://www.latinolife.co.uk/articles/brazil-pixacao-sao-paulos-urban-calligraphy), [AAIHS — A Tale of Two Graffitis](https://www.aaihs.org/a-tale-of-two-graffitis-the-american-tag-and-the-brazilian-pixacao/)
- Cholo/Placas — [Chastanet, *Cholo Writing: Latino Gang Graffiti in Los Angeles* (Museum of Graffiti)](https://museumofgraffiti.com/products/cholo-writing-latino-gang-graffiti-in-los-angeles), [Art in the Streets — Cholo Graffiti](https://artinthestreets.org/text/cholo-graffiti)
- Old-school NYC / bubble letters — [Source Type — A Brief History of Bubble Letters](https://www.sourcetype.com/editorial/14561/a-brief-history-of-bubble-letters), [TypeRoom — Phase 2: From Softies to Hip-Hop Flyers](https://www.typeroom.eu/phase-2-from-softies-to-hip-hop-flyers-a-tribute-to-the-late-urban-artist-you-should-know)
- Japanese graffiti — [sabukaru — Graffiti Culture in Tokyo](https://sabukaru.online/articles/graffiti-in-tokyo-exists-you-just-have-to-know-where-to-find-it), [Creative Bloq — Design Japanese-style Graffiti](https://www.creativebloq.com/computer-arts/design-japanese-style-graffiti-1099173)
- 3D / anamorphic — [Voomed — Sergio Odeith Anamorphic 3D Graffiti](https://www.voomed.com/sergio-odeith-anamorphic-3d-graffiti-letters/), [Digital Synopsis — 3D Graffiti / Odeith](https://digitalsynopsis.com/design/3d-graffiti-street-art-anamorphic-odeith/)
- Freight / benching — [Beyond the Streets — Freight Train Graffiti](https://beyondthestreets.com/blogs/articles/freight-train-graffiti)

On-disk study images and their attribution: see `reference/graffiti-set/README.md`
and `reference/graffiti-set/stencils/ATTRIBUTION.txt` (mostly Wikimedia Commons,
CC-BY / CC-BY-SA). **Banksy note:** Banksy artwork is study-only, never redistributed
(no UK freedom of panorama for 2D works).
