# VANDAL — Graffiti Content Library

One reusable, de-duplicated content pack compiled from five research catalogs
(**classic-styles · football-ultras · phrases-slogans · stencils ·
characters-japanese**). This markdown is the human-readable half; the
machine-readable half is **[`../../server/content.js`](../../server/content.js)**
(CommonJS, `require`-able by `server/bots.js` and the image-reproduce mode).

```js
const CONTENT = require("./content.js");
const { WRITER_WORDS, FOOTBALL_WORDS, ULTRAS_SLOGANS, PHRASES,
        SUBJECTS, COLOUR_SCHEMES, MOOD_SCHEMES, LAYER_ORDER,
        glyphSafeList, REFERENCE_IMAGES } = CONTENT;
```

## Two hard contracts

**COLOUR — warm only, no violet/magenta/indigo.** Every colour in the library
is a **palette index 0..13** into the fixed 14-slot warm spray palette that
already travels on the wire (`client/js/constants.js` `PALETTE`). Nothing is a
free hex; source-catalog hexes were snapped to these slots, so nothing the game
*emits* can leave the warm band. Slots 11 (teal) / 12 (blue) are the only
cool-leaning slots and are **accent-only**.

| # | slot | role | # | slot | role |
|---|------|------|---|------|------|
| 0 | cream `#F6ECD3` | neutral / keyline-light / highlight | 7 | divine yellow `#FBC02D` | gold face |
| 1 | apricot `#FBD1A0` | warm skin / soft fill | 8 | ocher brown `#C6892C` | 3D / shadow / wood |
| 2 | mango `#F9AE63` | fill | 9 | guacamole `#AFC552` | warm green, accent only |
| 3 | coral `#FF8A6B` | fill | 10 | mojito `#6FBE8E` | green, accent only |
| 4 | vitamin-C orange `#F26B34` | fill | 11 | caribbean teal `#34AEA3` | **accent only** |
| 5 | malcolm red `#CE3B2E` | red face / oxblood | 12 | andes blue `#4F9FD6` | **accent only** |
| 6 | beach yellow `#FFD873` | fill | 13 | bone black `#2B2620` | outline / keyline dark |

*Cool-source recolours:* Hokusai indigo wave → warm teal/sea-green + amber crest
(slot 11/10/4); pink hearts → coral (3); navy team kits → bone-black (13) or
oxblood (5) with the warm partner (gold 7 / yellow 6) kept dominant.

**GLYPH — the stroke font draws only** `A B C D E F G H I K L M N O P R S T U V W Y`
(no `J Q X Z`, no digits, no accents, no kana/kanji). `WRITER_WORDS` is
pre-filtered glyph-safe. `FOOTBALL_WORDS`, `ULTRAS_SLOGANS`, `PHRASES` keep full
text (accents/multi-word/codes) for captions + reproduce mode — filter them with
`glyphSafeList(list)` before feeding the letter renderer.

---

## 1 · Words & phrases (arrays)

| export | shape | count | use |
|--------|-------|-------|-----|
| `WRITER_WORDS` | `string[]` (glyph-safe) | 110 | tags / throw-ups / wildstyle handles + one-word bombs |
| `FOOTBALL_WORDS` | `string[]` (full) | 59 | ultras group-name components + terrace vocab |
| `ULTRAS_SLOGANS` | `string[]` w/ `{TEAM}{CITY}{GROUP}{YEAR}{NAME}{COLOUR}` slots | 38 | terrace chants + memorial templates |
| `PHRASES` | `{ text, mood, hand }[]` | 67 | protest/poetic/love/hope/antiauth/street slogans |

- `WRITER_WORDS` are grouped 3-letter (fast to bomb) → 4-letter → 5–6-letter
  (more interlock for wildstyle). Bias wildstyle picks toward `WILDSTYLE_LETTERS`.
- `PHRASES[].mood` keys into `MOOD_SCHEMES`; `PHRASES[].hand` is a render style
  (`stencil` · `roller` · `hand` · `bubble` · `slap`).
- **Content guardrail:** hateful/extremist numeric codes (88/18/28 …) are
  excluded by construction. `ACAB` / `1312` are kept as genuine terrace culture
  but sit last in `ULTRAS_SLOGANS` so a family filter can drop them.

---

## 2 · Colour schemes (per tier)

`COLOUR_SCHEMES` is keyed by render tier; each entry is a named scheme of
**palette indices** shaped the way `bots.js` consumes one:
`fills:[face…dark] · shade(3D) · outline · keyline · forcefield · hi · accent · ground/wall`
(any field omitted for a tier that skips that layer).

| tier | # colours | schemes |
|------|-----------|---------|
| `tag` | 1–2 | marker-black · chrome-black · red-streak |
| `throwup` | 2 | silver-black · cream-cherry · amber-umber · hollow |
| `blockbuster` | 2–3 | red-on-black · rust-cream · gold-straight |
| `wildstyle` | 4–8 | sunset-fade · ember · warm-chrome |
| `piece` | 5–10 | sunset-piece · gold-brick |
| `stencil` | 1–3 | mono · black-red · sepia · charcoal-duotone · rust-bone · amber-nightglow |
| `character` | 3–5 | warm-cel · lacquer-red · koi-kohaku |

Extra maps:
- `FOOTBALL_PALETTES` — 8 real team recipes snapped to indices (giallorossi,
  rossoneri, redwhite, yellowblack, sangetor, claretamber, totenkopf,
  curvaconcrete).
- `MOOD_SCHEMES` — `mood → {fill, accent, ground}` for colouring a phrase by its
  mood tag.

---

## 3 · Layer anatomy

`LAYER_ORDER` is the canonical bottom→top vocabulary (the z-stack `bots.js`
paints and the reproduce mode grades against):

```
ground → base → patch → fade → shade3d → inline → outline →
keyline → forcefield → highlight → detail → fx → caption
```

`TIER_LAYERS[tier]` gives the roles each letter tier actually paints. Note two
paint traditions coexist: **lettering** re-cuts the `outline` *before* the
`highlight`; **characters** ink the `outline` *after* highlights, and
**stencils** weather with `fx` *after* the `caption`. So each `SUBJECTS[].layers`
lists that subject's real paint order (a subset of the vocabulary, not a global
sort). Reproduce-mode checkpoints: **A** = flats (`ground…patch`), **B** =
structure (`fade…keyline`), **C** = finish (`forcefield…caption`).

---

## 4 · Subjects (51, de-duplicated)

`SUBJECTS[] = { name, tier, palette:[indices], layers:[roles], group, difficulty }`.
Subjects that recurred across catalogs (koi, gorilla, skull, fist, gas-mask) are
merged into one entry each. Groups:

- **lettering (4):** handstyle-tag, bubble-throwup, wordmark-block, wildstyle-word
- **football (10):** club-crest, scarf-aloft, pyro-flare, ultras-skull,
  masked-figure, animal-emblem, crown-star-laurel, founding-year-block,
  crossed-flags, curva-cathedral
- **japanese (9):** koi, oni-mask, daruma, maneki-neko, torii, great-wave (warm
  recolour), sakura, anime-bust, kanji-handstyle *(caption/reproduce only — not
  latin-renderable)*
- **stencil (18):** child-balloon, flower-thrower, signboard-rat, dove,
  caged-bird, riot-cop, gas-mask-figure, astronaut, businessman, praying-figure,
  clenched-fist, stray-cat, gorilla, icon-portrait, paper-plane, cctv-camera,
  umbrella-figure, butterfly, skull — all **original** subjects in the Banksy/Blek
  visual language (no protected works reproduced)
- **classic add-ons (5):** spray-can-mascot, b-boy, boombox, bomb-fuse,
  atom-nucleus
- **phrase-pieces (5):** stencil-slogan, roller-statement, handstyle-oneliner,
  slap-sticker (+ the phrase becomes the subject)

Composable wall recipe (ultras example): `wordmark-block` + `club-crest` (left) +
`scarf-aloft`/`pyro-flare` (right) + `founding-year-block` (corner).

---

## 5 · Reference image index (29 files)

`REFERENCE_IMAGES[] = { rel, category, subject, tier?, license, author, source, teaches }`;
absolute path = `REFERENCE_ROOT + "/" + rel`
(`REFERENCE_ROOT = /home/misael/Desktop/game.io/vandal/reference/graffiti-set`).

| category | files | licenses |
|----------|-------|----------|
| football-ultras | 4 | CC BY-SA 4.0, CC BY 4.0 ×2, CC (verify) |
| phrases-slogans | 5 | CC BY-SA 4.0 ×2, CC BY-SA 2.0, CC BY 2.0, CC0 |
| classic-styles | 4 (+3 loose) | CC BY 3.0, CC BY 2.0, CC BY-SA 4.0, PD, +see-file |
| characters-japanese | 6 (+1 loose) | CC BY-SA 3.0 ×2, CC BY-SA 4.0 ×2, CC BY 2.0, PD |
| stencils | 4 (+1 loose) | CC BY-SA / GFDL multi, CC BY 2.0, CC BY-SA 4.0 |

**Attribution:** CC BY / BY-SA require author credit + license link + a
"modified/recoloured" note on any emitted derivative; CC BY-SA derivatives must
stay share-alike. **Banksy** works are study-only references — never downloaded
or reproduced (UK grants no freedom-of-panorama for 2D graphic works, so the art
stays copyrighted even under a CC-licensed photo). Full per-file rows live in
`content.js` → `REFERENCE_IMAGES`.
