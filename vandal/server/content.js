"use strict";

// ===========================================================================
// content.js — VANDAL CONTENT LIBRARY (single source of graffiti content).
//
// One de-duplicated, reusable pack compiled from five per-category research
// catalogs (classic-styles, football-ultras, phrases-slogans, stencils,
// characters-japanese). Consumed by:
//   - server/bots.js        (bots pick words / subjects / schemes to paint)
//   - image-reproduce mode  (subject templates + layer stacks + mood schemes)
//
// COLOUR CONTRACT: every colour here is a PALETTE INDEX (0..13) into the fixed
// 14-slot warm spray palette that already travels on the wire (see
// client/js/constants.js PALETTE). The palette is WARM by construction —
// ABSOLUTELY NO violet / magenta / indigo. Slots 11 (teal) & 12 (blue) are the
// only cool-leaning slots and are ACCENT-ONLY. Slot 0 = cream, 13 = warm black.
// Any hex-based palette from the source catalogs was snapped to these slots, so
// nothing this library EMITS can drift out of the warm band.
//
// GLYPH CONTRACT: the stroke font (bots.js GLYPHS) supports only
//   A B C D E F G H I K L M N O P R S T U V W Y   (no J Q X Z, no digits,
//   no accents, no kana/kanji). Multi-word slogans, accented ultras vocab and
//   kanji are kept in FULL for the reproduce mode / captions, but bots that
//   render with the letter font must filter through glyphSafeList() first.
// ===========================================================================

// --- palette mirror (kept in sync with client/js/constants.js PALETTE) ------
// Re-exported so this library + the reproduce mode are self-contained.
const PALETTE = [
  "#F6ECD3", // 0  cream          (neutral / keyline light / highlight)
  "#FBD1A0", // 1  apricot        (warm skin / soft fill)
  "#F9AE63", // 2  mango
  "#FF8A6B", // 3  coral
  "#F26B34", // 4  vitamin C orange
  "#CE3B2E", // 5  malcolm red
  "#FFD873", // 6  beach yellow
  "#FBC02D", // 7  divine yellow / gold
  "#C6892C", // 8  ocher brown    (3D / shadow / wood)
  "#AFC552", // 9  guacamole (warm green — neutral accent only)
  "#6FBE8E", // 10 mojito green   (neutral accent only)
  "#34AEA3", // 11 caribbean teal (ACCENT ONLY)
  "#4F9FD6", // 12 andes blue     (ACCENT ONLY)
  "#2B2620", // 13 bone black     (outline / keyline dark)
];
const MURAL_BG = "#F0E4CF"; // warm plaster wall (stencil "wall"/negative space)

// role buckets over the 14 slots (bots.js already uses the first four)
const IDX = {
  WARM: [1, 2, 3, 4, 5, 6, 7, 8], // primary fills
  REDS: [3, 4, 5],
  GOLDS: [6, 7, 8],
  GREENS: [9, 10], // warm-leaning green, neutral accent only
  ACCENT: [11, 12], // teal / blue — sparingly
  CREAM: 0,
  DARK: 13,
};

// --- glyph safety (letters the stroke font can actually draw) ---------------
const SUPPORTED_GLYPHS = "ABCDEFGHIKLMNOPRSTUVWY";
function glyphSafe(word) {
  return typeof word === "string" && /^[ABCDEFGHIKLMNOPRSTUVWY]+$/.test(word);
}
// filter any string list to single tokens the current font can render
function glyphSafeList(list) {
  return list.filter((w) => glyphSafe(w));
}

// ===========================================================================
// 1) WORDS / PHRASES  (copy-pasteable arrays)
// ===========================================================================

// --- WRITER_WORDS: single-word writer/culture handles + bombs. -------------
// Pre-filtered GLYPH-SAFE (all letters supported) so bots can drop these
// straight into a tag / throw-up / wildstyle. Deduped across classic-styles,
// phrases §G, characters-japanese latin words + the legacy bots.js WORDS list.
const WRITER_WORDS = [
  // 3-letter (fastest to bomb)
  "SEN", "ASK", "RIM", "DUB", "VOR", "TOK", "NUK", "FEN", "WEK", "POK",
  "MEK", "VYN", "BLO", "RIP", "TKO", "OWL", "RSK", "OKR", "CRW", "VNS",
  "ONE", "ROC", "RAW", "DEF", "ILL", "KOI", "ONI",
  // 4-letter (throw-up / blockbuster sweet spot)
  "OKER", "RENO", "KEMS", "GADO", "VELO", "RASK", "MOKE", "DEVO", "TILT",
  "ROVE", "KANE", "REKO", "SABE", "TOSK", "WYRE", "ROKE", "ESKO", "NADO",
  "NOVA", "KORE", "SORE", "MAKO", "FLOW", "GRIM", "WILD", "REAL", "TRUE",
  "KING", "BOMB", "CREW", "FREE", "RISE", "RAGE", "ROAM", "FADE", "ECHO",
  "RUST", "DAWN", "DUSK", "BOLD", "LOUD", "GRIT", "ROOT", "NEON", "CITY",
  "WAVE",
  // 5-6 letter (wildstyle / piece — more interlock)
  "NEKST", "ROSKO", "KADEN", "ORBIT", "SETEK", "VELOR", "RAKEN", "SOBEK",
  "TORCH", "EMBER", "KRONO", "VOLTA", "RIOT", "ROYAL", "URBAN", "REBEL",
  "RAVEN", "SNAKE", "STYLE", "SPARK", "PULSE", "DRIFT", "SOLAR",
  "FERAL", "FRESH", "BLOOM", "DREAM", "HOPE", "VIBE", "UNITY", "KINGS",
  "GHOST", "RONIN", "TOKYO", "CHROME", "VANDAL", "KREW",
];

// letters that interlock/arrow well — bias wildstyle generators toward these
const WILDSTYLE_LETTERS = "SKREAZWMN"; // (Z illustrative; not in font, skip)

// --- FOOTBALL_WORDS: ultras group-name components + terrace vocab. ----------
// FULL forms (some accented / multi-script) for captions + reproduce mode.
// Run glyphSafeList(FOOTBALL_WORDS) for the current stroke font.
// hateful/extremist numeric codes (88/18/28 etc.) are intentionally EXCLUDED.
const FOOTBALL_WORDS = [
  // language-neutral core
  "ULTRAS", "ULTRA", "TIFO", "CURVA", "CASUALS", "FIRM", "TERRACE", "KOP",
  "MENTALITA", "IRRIDUCIBILI", "BRIGATE", "COMMANDO", "FOSSA", "NUCLEO",
  "GIOVENTU", "TEPPA", "FEDELISSIMI",
  // Italian
  "CURVA NORD", "CURVA SUD", "GRADINATA", "FORZA", "FEDE", "ONORE", "AMORE",
  "ORGOGLIO", "CUORE",
  // Spanish / South American
  "HINCHADA", "AFICION", "BARRA", "BARRA BRAVA", "AGUANTE", "FUERZA",
  "ORGULLO", "PASION", "LEALTAD", "FANATICOS", "GLORIOSA", "REBELDES",
  // English terrace / casual
  "BOYS", "YOUTH", "LADS", "THE SHED",
  // German
  "KURVE", "NORDKURVE", "SUDKURVE", "FANSZENE", "TREUE", "STOLZ",
  "LEIDENSCHAFT",
  // Turkish / Balkan / Greek
  "CARSI", "GROBARI", "DELIJE", "ARMADA", "HORDE", "TORCIDA", "PONOS",
  "VERNI", "LUDI", "FANATICS",
];

// --- ULTRAS_SLOGANS: terrace chants / wall statements (multi-word). ---------
// Fill slots: {TEAM} {CITY} {GROUP} {YEAR} {N} {NAME} {COLOUR}. Mostly for
// captions / reproduce mode (few are single-glyph-word renderable).
// ACAB / 1312 are genuine ubiquitous terrace culture — flag & exclude via a
// family filter if a deployment wants them out.
const ULTRAS_SLOGANS = [
  "NO TO MODERN FOOTBALL", "AGAINST MODERN FOOTBALL",
  "SUPPORT LOCAL FOOTBALL", "ONE CITY ONE CLUB", "COLOURS DONT RUN",
  "{TEAM} TILL I DIE", "PRIDE OF {CITY}", "WE ARE {TEAM}",
  "BORN NOT MANUFACTURED", "NOT FOR SALE", "OUR CLUB OUR RULES",
  "KEEP THE FAITH", "MARCHING ON TOGETHER", "YOULL NEVER WALK ALONE",
  "NO ONE LIKES US WE DONT CARE", "SCARVES UP", "OLD SCHOOL", "TILL THE END",
  "UN AMORE INFINITO", "SEMPRE CON TE", "NATI PER {TEAM}",
  "{ANNI} ANNI DI STORIA", "HASTA LA MUERTE", "VAMOS {TEAM}",
  "DE LA CUNA AL CAJON", "SOMOS LOCALES", "GEGEN DEN MODERNEN FUSSBALL",
  "NUR DER {TEAM}", "ASLA YALNIZ YURUMEYECEKSIN", "SONUNA KADAR",
  // memorial / dedication templates (cross-cultural, seen live)
  "RIP {NAME}", "{NAME} PRESENTE", "{NAME} SEMPRE CON NOI",
  "{COLOUR} FOREVER", "ONE OF OUR OWN", "GONE BUT NEVER FORGOTTEN",
  // genuine but flaggable
  "ACAB", "1312",
];

// --- PHRASES: real street slogans/quotes, tagged by mood + hand-style. ------
// mood keys map into MOOD_SCHEMES; hand keys map into a stencil/roller/etc
// render tier. Single-word bombs live in WRITER_WORDS (not duplicated here).
// Deduped across the phrases-slogans + stencils caption catalogs.
const PHRASES = [
  // protest / political
  { text: "EAT THE RICH", mood: "protest", hand: "roller" },
  { text: "NO JUSTICE NO PEACE", mood: "protest", hand: "roller" },
  { text: "SILENCE = DEATH", mood: "protest", hand: "stencil" },
  { text: "POWER TO THE PEOPLE", mood: "protest", hand: "roller" },
  { text: "WHOSE STREETS OUR STREETS", mood: "protest", hand: "hand" },
  { text: "NOT IN MY NAME", mood: "protest", hand: "stencil" },
  { text: "MAKE LOVE NOT WAR", mood: "protest", hand: "hand" },
  { text: "NO WAR", mood: "protest", hand: "roller" },
  { text: "REFUGEES WELCOME", mood: "protest", hand: "stencil" },
  { text: "SMASH THE STATE", mood: "protest", hand: "roller" },
  { text: "NO BORDERS NO NATIONS", mood: "protest", hand: "stencil" },
  { text: "FIGHT THE POWER", mood: "protest", hand: "roller" },
  { text: "CLIMATE JUSTICE NOW", mood: "protest", hand: "stencil" },
  { text: "THERE IS NO PLANET B", mood: "protest", hand: "hand" },
  { text: "MY BODY MY CHOICE", mood: "protest", hand: "stencil" },
  { text: "WATER IS LIFE", mood: "protest", hand: "hand" },
  { text: "LAND BACK", mood: "protest", hand: "roller" },
  // poetic / existential / situationist
  { text: "SOUS LES PAVES LA PLAGE", mood: "poetic", hand: "hand" },
  { text: "IL EST INTERDIT DINTERDIRE", mood: "poetic", hand: "hand" },
  { text: "LIMAGINATION AU POUVOIR", mood: "poetic", hand: "hand" },
  { text: "NE TRAVAILLEZ JAMAIS", mood: "poetic", hand: "hand" },
  { text: "VIVRE SANS TEMPS MORT", mood: "poetic", hand: "hand" },
  { text: "STAY HUMAN", mood: "poetic", hand: "stencil" },
  { text: "THIS TOO SHALL PASS", mood: "poetic", hand: "hand" },
  { text: "WE ARE THE WRITING ON THE WALL", mood: "poetic", hand: "hand" },
  { text: "NOTHING IS REAL", mood: "poetic", hand: "hand" },
  // love / tender
  { text: "ALL YOU NEED IS LOVE", mood: "love", hand: "hand" },
  { text: "ONE LOVE", mood: "love", hand: "bubble" },
  { text: "LOVE WINS", mood: "love", hand: "hand" },
  { text: "LOVE IS THE ANSWER", mood: "love", hand: "hand" },
  { text: "YOU ARE LOVED", mood: "love", hand: "slap" },
  { text: "TE AMO", mood: "love", hand: "hand" },
  { text: "SENDING LOVE", mood: "love", hand: "slap" },
  // hope / uplift
  { text: "YOU ARE BEAUTIFUL", mood: "hope", hand: "slap" },
  { text: "THERE IS ALWAYS HOPE", mood: "hope", hand: "hand" },
  { text: "FOLLOW YOUR DREAMS", mood: "hope", hand: "stencil" },
  { text: "DREAM BIG", mood: "hope", hand: "hand" },
  { text: "KEEP GOING", mood: "hope", hand: "hand" },
  { text: "YOU MATTER", mood: "hope", hand: "stencil" },
  { text: "YOU ARE ENOUGH", mood: "hope", hand: "slap" },
  { text: "NEVER GIVE UP", mood: "hope", hand: "roller" },
  { text: "BETTER DAYS", mood: "hope", hand: "hand" },
  { text: "IT GETS BETTER", mood: "hope", hand: "hand" },
  { text: "BE KIND", mood: "hope", hand: "stencil" },
  { text: "STAY GOLD", mood: "hope", hand: "hand" },
  { text: "STAY WILD", mood: "hope", hand: "hand" },
  { text: "LOOK UP", mood: "hope", hand: "stencil" },
  { text: "WAKE UP", mood: "hope", hand: "stencil" },
  // anti-authority / anarchist
  { text: "NO GODS NO MASTERS", mood: "antiauth", hand: "roller" },
  { text: "PROPERTY IS THEFT", mood: "antiauth", hand: "stencil" },
  { text: "TIERRA Y LIBERTAD", mood: "antiauth", hand: "roller" },
  { text: "BASH THE FASH", mood: "antiauth", hand: "roller" },
  { text: "AGAINST ALL AUTHORITY", mood: "antiauth", hand: "hand" },
  { text: "DIRECT ACTION", mood: "antiauth", hand: "stencil" },
  { text: "SIN MIEDO", mood: "antiauth", hand: "roller" },
  { text: "LA CALLE ES NUESTRA", mood: "antiauth", hand: "hand" },
  { text: "DISOBEY", mood: "antiauth", hand: "stencil" },
  { text: "ONE NATION UNDER CCTV", mood: "antiauth", hand: "stencil" },
  // irony / anti-consumer (banksy deadpan)
  { text: "SALE ENDS NEVER", mood: "antiauth", hand: "stencil" },
  { text: "THIS IS FINE", mood: "antiauth", hand: "stencil" },
  { text: "CONSUME", mood: "antiauth", hand: "stencil" },
  // street / writer-culture classics
  { text: "KILROY WAS HERE", mood: "street", hand: "hand" },
  { text: "CANT STOP WONT STOP", mood: "street", hand: "roller" },
  { text: "ALL CITY", mood: "street", hand: "bubble" },
  { text: "KEEP IT REAL", mood: "street", hand: "hand" },
  { text: "LEGENDS NEVER DIE", mood: "street", hand: "roller" },
  { text: "STAY UP", mood: "street", hand: "bubble" },
];

// ===========================================================================
// 2) COLOUR SCHEMES — per style TIER (palette indices; warm, no violet).
// ===========================================================================
// Shape matches how bots.js consumes a scheme:
//   fills: [face(light) .. dark]  · shade: 3D block · outline · keyline ·
//   forcefield · hi(highlight) · accent · ground/wall
// Any field may be omitted for a tier that doesn't use that layer.
// Tiers: tag < throwup < blockbuster < wildstyle < piece  (letter tiers),
// plus stencil & character (subject styles) and phrase-hand tiers via
// MOOD_SCHEMES below.
const COLOUR_SCHEMES = {
  tag: [
    { name: "marker-black", fills: [13] },
    { name: "chrome-black", fills: [0], outline: 13 },
    { name: "red-streak", fills: [5] },
  ],
  throwup: [
    { name: "silver-black", fills: [0], outline: 13, drip: 13 },
    { name: "cream-cherry", fills: [0], outline: 5 },
    { name: "amber-umber", fills: [2], outline: 8 },
    { name: "hollow", fills: [], outline: 13 },
  ],
  blockbuster: [
    { name: "red-on-black", fills: [5], shade: 13, keyline: 0 },
    { name: "rust-cream", fills: [0], shade: 8, outline: 13 },
    { name: "gold-straight", fills: [7], shade: 13, keyline: 0 },
  ],
  wildstyle: [
    { name: "sunset-fade", fills: [6, 4, 5], shade: 8, outline: 13, keyline: 0, forcefield: 5, hi: 0, accent: 11 },
    { name: "ember", fills: [2, 8, 5], shade: 13, outline: 13, keyline: 7, forcefield: 0, hi: 0 },
    { name: "warm-chrome", fills: [0], shade: 7, outline: 13, keyline: 0, forcefield: 5, hi: 0 },
  ],
  piece: [
    { name: "sunset-piece", ground: 8, fills: [6, 4, 5], shade: 13, outline: 13, keyline: 0, forcefield: [3, 0], hi: 0, accent: 7, skin: 1 },
    { name: "gold-brick", ground: 8, fills: [7, 8, 5], shade: 13, outline: 13, keyline: 0, forcefield: [4, 0], hi: 0, accent: 5, skin: 1 },
  ],
  // Banksy lineage: flat fills, wall = negative space, ONE warm accent max.
  stencil: [
    { name: "mono", wall: MURAL_BG, key: 13 },
    { name: "black-red", wall: 0, key: 13, accent: 5 },
    { name: "sepia", base: 1, mid: 8, key: 13, accent: 7 },
    { name: "charcoal-duotone", lift: 0, mid: 8, key: 13 },
    { name: "rust-bone", base: 0, key: 13, accent: 4, accent2: 2 },
    { name: "amber-nightglow", wall: 13, figure: 0, accent: 2 },
  ],
  // cel-shaded mascots/characters (japanese + classic add-ons); per-subject
  // palettes live in SUBJECTS — this is the generic warm cel ramp.
  character: [
    { name: "warm-cel", fills: [1], shade: 8, hi: 0, accent: 5, outline: 13 },
    { name: "lacquer-red", fills: [5], shade: 8, hi: 7, accent: 4, outline: 13 },
    { name: "koi-kohaku", fills: [0], shade: 5, mid: 4, hi: 7, accent: 7, outline: 13 },
  ],
};

// warm-substitution note for real team palettes that are cool (navy/royal):
//   navy  -> 13 (bone black)  or  5 (malcolm red, "oxblood" role)
//   keep the warm partner (gold 7 / yellow 6 / red 5) dominant.
// canonical football palette recipes (already snapped to indices):
const FOOTBALL_PALETTES = {
  giallorossi: { fills: [7, 5], shade: 13, outline: 13, hi: 0 }, // gold + oxblood
  rossoneri: { fills: [5], shade: 13, outline: 13, hi: 0 }, //     red + black + white
  redwhite: { fills: [5, 0], shade: 13, outline: 13, hi: 0 }, //   red + white
  yellowblack: { fills: [7], shade: 8, outline: 13, hi: 0 }, //    yellow + black
  sangetor: { fills: [4, 7], shade: 13, outline: 13, hi: 0 }, //   red + gold
  claretamber: { fills: [5, 2], shade: 13, outline: 13, hi: 0 }, // claret + amber
  totenkopf: { fills: [8, 5], shade: 13, outline: 13, hi: 0 }, //  brown skull + red flash
  curvaconcrete: { wall: MURAL_BG, key: 13, brick: 8, chalk: 0 }, // weathered ground
};

// phrase mood -> {fill, accent, ground} (indices). Bots colour a caption by
// the phrase's mood tag; reproduce mode uses it as the target palette.
const MOOD_SCHEMES = {
  protest: { fill: 5, accent: 13, ground: 0 },
  poetic: { fill: 8, accent: 7, ground: 0 },
  love: { fill: 3, accent: 5, ground: 0 },
  hope: { fill: 2, accent: 4, ground: 0 },
  antiauth: { fill: 13, accent: 5, ground: 1 },
  street: { fill: 7, accent: 8, ground: 13 },
};

// ===========================================================================
// 3) LAYER ANATOMY — canonical paint order (bottom -> top).
// ===========================================================================
// Every SUBJECT.layers entry is a subset of these role keys, IN ORDER. This is
// the same z-stack bots.js paints and the checkpoint order the reproduce mode
// grades against. (Grading checkpoints: A=flats[ground..patch],
// B=structure[fade..keyline], C=finish[forcefield..caption].)
const LAYER_ORDER = [
  "ground",     // 1  scene/wall/halo behind the subject (or raw wall)
  "base",       // 2  flat base fill of each region (light tone)
  "patch",      // 3  secondary local-colour blocks (koi spots, calico, flames)
  "fade",       // 4  warm gradient inside the fill (wildstyle/piece only)
  "shade3d",    // 5  offset 3D extrusion / cel shadow (one light direction)
  "inline",     // 6  interior detail inside the fill (scallops, cracks)
  "outline",    // 7  hard silhouette re-cut ON TOP of the fill
  "keyline",    // 8  thin bright line OUTSIDE the outline at constant gap
  "forcefield", // 9  halo following the whole word/subject (can double)
  "highlight",  // 10 specular hits / shines (last colour before drips)
  "detail",     // 11 scales, whiskers, eyes, stamens, kanji, ornaments
  "fx",         // 12 drips, spatter, foam, petals, smoke, overspray halo
  "caption",    // 13 bridged stencil / handstyle text under the subject
];
// per-letter-tier layer recipes (which roles each tier actually paints)
const TIER_LAYERS = {
  tag: ["base", "fx"],
  throwup: ["base", "outline", "highlight", "fx"],
  blockbuster: ["base", "shade3d", "outline", "keyline"],
  wildstyle: ["base", "fade", "shade3d", "inline", "outline", "keyline", "forcefield", "highlight", "detail", "fx"],
  piece: ["ground", "base", "fade", "shade3d", "outline", "keyline", "forcefield", "highlight", "detail", "fx"],
  stencil: ["ground", "base", "outline", "detail", "caption", "fx"], // base only in 2-3 tone; else wall serves as light
  character: ["ground", "base", "patch", "shade3d", "highlight", "outline", "detail", "fx"],
  phrase: ["ground", "base", "outline", "detail", "fx"], // hand-style specifics vary; see PHRASES[].hand
};

// ===========================================================================
// 4) SUBJECTS — de-duplicated motif templates.
// ===========================================================================
// { name, tier, palette:[warm indices 0..13], layers:[role keys in paint order],
//   group, difficulty }.  palette lists ONLY the slots that subject uses.
// tier selects the render family (drives TIER_LAYERS + a COLOUR_SCHEMES entry).
// A subject that appears in several source catalogs (koi, gorilla, skull, fist,
// gas-mask) is merged into ONE entry here.
const SUBJECTS = [
  // -- lettering (the word IS the subject) -----------------------------------
  { name: "handstyle-tag", tier: "tag", group: "lettering", difficulty: "easy", palette: [13, 5], layers: TIER_LAYERS.tag },
  { name: "bubble-throwup", tier: "throwup", group: "lettering", difficulty: "easy", palette: [0, 2, 5, 13], layers: TIER_LAYERS.throwup },
  { name: "wordmark-block", tier: "blockbuster", group: "lettering", difficulty: "med", palette: [5, 7, 8, 13, 0], layers: TIER_LAYERS.blockbuster },
  { name: "wildstyle-word", tier: "wildstyle", group: "lettering", difficulty: "hard", palette: [6, 4, 5, 8, 0, 13], layers: TIER_LAYERS.wildstyle },

  // -- football / ultras -----------------------------------------------------
  { name: "club-crest", tier: "stencil", group: "football", difficulty: "med", palette: [7, 5, 0, 13], layers: TIER_LAYERS.stencil },
  { name: "scarf-aloft", tier: "piece", group: "football", difficulty: "med", palette: [5, 7, 0, 13], layers: ["base", "patch", "outline", "highlight", "fx"] },
  { name: "pyro-flare", tier: "character", group: "football", difficulty: "med", palette: [6, 4, 5, 0, 13], layers: ["ground", "base", "highlight", "outline", "fx"] },
  { name: "ultras-skull", tier: "character", group: "football", difficulty: "hard", palette: [8, 5, 0, 7, 13], layers: TIER_LAYERS.character },
  { name: "masked-figure", tier: "stencil", group: "football", difficulty: "med", palette: [13, 5, 0], layers: TIER_LAYERS.stencil },
  { name: "animal-emblem", tier: "piece", group: "football", difficulty: "hard", palette: [8, 5, 7, 0, 13], layers: TIER_LAYERS.piece },
  { name: "crown-star-laurel", tier: "piece", group: "football", difficulty: "easy", palette: [7, 5, 0, 13], layers: ["base", "outline", "highlight", "detail"] },
  { name: "founding-year-block", tier: "blockbuster", group: "football", difficulty: "easy", palette: [5, 0, 13], layers: TIER_LAYERS.blockbuster },
  { name: "crossed-flags", tier: "piece", group: "football", difficulty: "easy", palette: [5, 7, 8, 13], layers: ["base", "patch", "outline", "detail"] },
  { name: "curva-cathedral", tier: "piece", group: "football", difficulty: "hard", palette: [8, 5, 0, 13], layers: ["ground", "base", "shade3d", "detail", "fx"] },

  // -- characters / japanese (warm cel-shade) --------------------------------
  { name: "koi", tier: "character", group: "japanese", difficulty: "med", palette: [0, 5, 4, 2, 7, 13], layers: TIER_LAYERS.character },
  { name: "oni-mask", tier: "character", group: "japanese", difficulty: "hard", palette: [5, 8, 4, 7, 13], layers: TIER_LAYERS.character },
  { name: "daruma", tier: "character", group: "japanese", difficulty: "easy", palette: [5, 8, 4, 7, 0, 13], layers: ["ground", "base", "patch", "highlight", "outline", "detail"] },
  { name: "maneki-neko", tier: "character", group: "japanese", difficulty: "med", palette: [0, 7, 4, 5, 8, 13], layers: TIER_LAYERS.character },
  { name: "torii", tier: "character", group: "japanese", difficulty: "easy", palette: [5, 4, 7, 0, 13], layers: ["base", "patch", "shade3d", "detail", "outline"] },
  { name: "great-wave", tier: "character", group: "japanese", difficulty: "hard", palette: [11, 10, 0, 4, 13], layers: ["ground", "base", "patch", "highlight", "detail", "fx"] }, // teal(11) is warm-recolor of banned indigo
  { name: "sakura", tier: "character", group: "japanese", difficulty: "easy", palette: [3, 1, 8, 0, 7, 13], layers: ["base", "patch", "highlight", "detail", "fx"] },
  { name: "anime-bust", tier: "character", group: "japanese", difficulty: "hard", palette: [1, 8, 4, 7, 5, 13], layers: TIER_LAYERS.character },
  { name: "kanji-handstyle", tier: "tag", group: "japanese", difficulty: "easy", palette: [13, 5, 7, 0], layers: ["base", "detail", "fx"] }, // NOTE: not renderable by latin stroke font — reproduce/caption only

  // -- stencils (Banksy/Blek lineage — ORIGINAL subjects, warm) --------------
  { name: "child-balloon", tier: "stencil", group: "stencil", difficulty: "easy", palette: [13, 5], layers: TIER_LAYERS.stencil },
  { name: "flower-thrower", tier: "stencil", group: "stencil", difficulty: "med", palette: [13, 4, 5], layers: TIER_LAYERS.stencil },
  { name: "signboard-rat", tier: "stencil", group: "stencil", difficulty: "easy", palette: [13, 5], layers: TIER_LAYERS.stencil },
  { name: "dove", tier: "stencil", group: "stencil", difficulty: "easy", palette: [13, 9, 2], layers: TIER_LAYERS.stencil },
  { name: "caged-bird", tier: "stencil", group: "stencil", difficulty: "med", palette: [13, 5], layers: TIER_LAYERS.stencil },
  { name: "riot-cop", tier: "stencil", group: "stencil", difficulty: "med", palette: [13, 8, 5], layers: TIER_LAYERS.stencil },
  { name: "gas-mask-figure", tier: "stencil", group: "stencil", difficulty: "med", palette: [13, 2], layers: TIER_LAYERS.stencil },
  { name: "astronaut", tier: "stencil", group: "stencil", difficulty: "med", palette: [13, 7], layers: TIER_LAYERS.stencil },
  { name: "businessman", tier: "stencil", group: "stencil", difficulty: "med", palette: [13, 5], layers: TIER_LAYERS.stencil },
  { name: "praying-figure", tier: "stencil", group: "stencil", difficulty: "easy", palette: [13, 7], layers: TIER_LAYERS.stencil },
  { name: "clenched-fist", tier: "stencil", group: "stencil", difficulty: "easy", palette: [13, 5], layers: TIER_LAYERS.stencil }, // merges ultras raised-fist
  { name: "stray-cat", tier: "stencil", group: "stencil", difficulty: "easy", palette: [13, 5], layers: TIER_LAYERS.stencil },
  { name: "gorilla", tier: "stencil", group: "stencil", difficulty: "med", palette: [13, 8], layers: TIER_LAYERS.stencil },
  { name: "icon-portrait", tier: "stencil", group: "stencil", difficulty: "hard", palette: [0, 8, 13], layers: ["ground", "base", "outline", "detail", "fx"] }, // 2-3 tone chiaroscuro
  { name: "paper-plane", tier: "stencil", group: "stencil", difficulty: "easy", palette: [13, 5], layers: TIER_LAYERS.stencil },
  { name: "cctv-camera", tier: "stencil", group: "stencil", difficulty: "easy", palette: [13, 5], layers: TIER_LAYERS.stencil },
  { name: "umbrella-figure", tier: "stencil", group: "stencil", difficulty: "med", palette: [13, 2], layers: TIER_LAYERS.stencil },
  { name: "butterfly", tier: "stencil", group: "stencil", difficulty: "easy", palette: [13, 2, 7], layers: TIER_LAYERS.stencil },
  { name: "skull", tier: "stencil", group: "stencil", difficulty: "easy", palette: [13, 8], layers: TIER_LAYERS.stencil }, // bandana/scarf variant => ultras-skull

  // -- classic character add-ons (piece mascots) -----------------------------
  { name: "spray-can-mascot", tier: "character", group: "classic", difficulty: "med", palette: [1, 5, 7, 0, 13], layers: TIER_LAYERS.character },
  { name: "b-boy", tier: "character", group: "classic", difficulty: "med", palette: [1, 8, 5, 7, 13], layers: TIER_LAYERS.character },
  { name: "boombox", tier: "character", group: "classic", difficulty: "easy", palette: [13, 8, 7, 0], layers: ["base", "shade3d", "outline", "detail"] },
  { name: "bomb-fuse", tier: "character", group: "classic", difficulty: "easy", palette: [13, 4, 6, 0], layers: ["base", "outline", "highlight", "fx"] },
  { name: "atom-nucleus", tier: "character", group: "classic", difficulty: "easy", palette: [4, 7, 13], layers: ["base", "outline", "detail"] },

  // -- phrase-pieces (the phrase becomes the subject) ------------------------
  { name: "stencil-slogan", tier: "phrase", group: "phrase", difficulty: "easy", palette: [13, 5, 0], layers: ["base", "outline", "detail", "caption", "fx"] },
  { name: "roller-statement", tier: "phrase", group: "phrase", difficulty: "easy", palette: [13, 5, 0], layers: ["base", "outline", "fx"] },
  { name: "handstyle-oneliner", tier: "phrase", group: "phrase", difficulty: "easy", palette: [13, 5, 3], layers: ["base", "detail", "fx"] },
  { name: "slap-sticker", tier: "phrase", group: "phrase", difficulty: "easy", palette: [0, 13, 3], layers: ["ground", "base", "detail"] },
];

// ===========================================================================
// 5) REFERENCE IMAGE INDEX — downloaded refs w/ category + license.
// ===========================================================================
// Absolute path = REFERENCE_ROOT + "/" + rel. license/author/source per file;
// CC BY / BY-SA require author credit + license link on any emitted derivative.
// teaches = what the reproduce mode should learn from it.
const REFERENCE_ROOT = require("path").resolve(__dirname, "..", "reference", "graffiti-set");
const REFERENCE_IMAGES = [
  // football-ultras
  { rel: "football-ultras/ultras_hapoel_graffiti_rabin_square_2017.jpg", category: "football-ultras", subject: "block-wordmark/memorial", license: "CC BY-SA 4.0", author: "Sebastian27", source: "https://commons.wikimedia.org/wiki/File:Ultras_Hapoel_Graffiti.jpg", teaches: "roller block-caps + memorial 'colour forever' template" },
  { rel: "football-ultras/ultras_hapoel_bar_ilan_interchange_2024.jpg", category: "football-ultras", subject: "block-wordmark", license: "CC BY 4.0", author: "Nizzan Cohen", source: "https://commons.wikimedia.org/wiki/File:Ultras_Hapoel_Graffiti_at_Bar_Ilan_Interchange.jpg", teaches: "large territorial group-name mark" },
  { rel: "football-ultras/ultras_hapoel_hashaon_beach_1999.jpg", category: "football-ultras", subject: "block-wordmark", license: "CC (verify per-file BY/BY-SA)", author: "Wikimedia Commons", source: "https://commons.wikimedia.org/wiki/File:Graffiti_in_HaShaon_beach_-_Ultras_Hapoel_Tel_Aviv_1999.jpg", teaches: "aged terrace wordmark on concrete" },
  { rel: "football-ultras/football_ultras_flares_levski_cska_2017.jpg", category: "football-ultras", subject: "pyro-flare/scarf (motif ref, not graffiti)", license: "CC BY 4.0", author: "Biser Todorov (Biso)", source: "https://commons.wikimedia.org/wiki/File:Football_ultras.jpg", teaches: "flare/smoke plume + scarf-aloft motif" },
  // phrases-slogans
  { rel: "phrases-slogans/slogan_eattherich_beirut.jpg", category: "phrases-slogans", subject: "roller-statement", license: "CC BY-SA 4.0", author: "RomanDeckert", source: "https://commons.wikimedia.org/wiki/File:BeirutHamra-EatTheRichGraffito_RomanDeckert24112021.jpg", teaches: "rough single-colour block caps + icon + drips" },
  { rel: "phrases-slogans/slogan_nojusticenopeace_jerusalem.jpg", category: "phrases-slogans", subject: "roller-statement", license: "CC BY-SA 2.0", author: "brionv", source: "https://commons.wikimedia.org/wiki/File:Jerusalem_No_justice_no_peace_(6032854486).jpg", teaches: "freehand spray caps layered over older paint" },
  { rel: "phrases-slogans/slogan_refugeeswelcome_groningen.jpg", category: "phrases-slogans", subject: "stencil-slogan", license: "CC BY-SA 4.0", author: "Donald Trung", source: "https://commons.wikimedia.org/wiki/File:Refugees_welcome_graffiti,_Groningen_(2019)_01.jpg", teaches: "white stencil caps, letter-bridges + overspray halo, repeated" },
  { rel: "phrases-slogans/slogan_youarebeautiful_portland.jpg", category: "phrases-slogans", subject: "slap-sticker", license: "CC BY 2.0", author: "Tony Webster", source: "https://commons.wikimedia.org/wiki/File:You_Are_Beautiful_Urban_Street_Art_Portland_(18142351146).jpg", teaches: "paste-up: rounded frame, lowercase + doodle heart" },
  { rel: "phrases-slogans/slogan_onelove_mauerpark_berlin.jpg", category: "phrases-slogans", subject: "bubble-word", license: "CC0", author: "Singlespeedfahrer", source: "https://commons.wikimedia.org/wiki/File:Graffiti_Bob_Marley_One_Love_eme_Freethinker_Mauerpark_Berlin-Prenzlauer_Berg.jpg", teaches: "gradient bubble fill + outline + heart icon (recolor pink->coral)" },
  // classic-styles
  { rel: "classic-styles/wildstyle_germany_kochstudio_CC-BY-3.0.jpg", category: "classic-styles", subject: "wildstyle-word", license: "CC BY 3.0", author: "KOchstudiO", source: "https://commons.wikimedia.org/wiki/File:Wildstyle_graffiti.JPG", teaches: "full wildstyle layer stack: fade+3D+outline+keyline+shines" },
  { rel: "classic-styles/wildstyle_california_defame_CC-BY-2.0.jpg", category: "classic-styles", subject: "wildstyle-word/piece", license: "CC BY 2.0", author: "Defame", source: "https://commons.wikimedia.org/wiki/File:Wildstyle_graffiti_from_cali.jpg", teaches: "piece composition w/ background + character" },
  { rel: "classic-styles/throwup_spleen_notcharizard_CC-BY-SA-4.0.jpg", category: "classic-styles", subject: "bubble-throwup", license: "CC BY-SA 4.0", author: "Notcharizard", source: "https://commons.wikimedia.org/wiki/File:Bubble_writing_graffiti.jpg", teaches: "hollow throw-up: minimal fill + single outline" },
  { rel: "classic-styles/tag_panel_train_NL_stevenlek_PublicDomain.jpg", category: "classic-styles", subject: "handstyle-tag", license: "Public Domain", author: "Steven Lek", source: "https://commons.wikimedia.org/wiki/File:Graffiti_on_a_train.JPG", teaches: "tag / panel handstyle, single gesture" },
  // characters-japanese
  { rel: "characters-japanese/koi_underpass_carp.jpg", category: "characters-japanese", subject: "koi", license: "CC BY-SA 3.0", author: "Tubbi", source: "https://commons.wikimedia.org/wiki/File:Colored_carp-underpass1.jpg", teaches: "kohaku block-colour koi (navy patches are FORM-ONLY, do not sample)" },
  { rel: "characters-japanese/koi_streetlight_carp.jpg", category: "characters-japanese", subject: "koi", license: "CC BY-SA 3.0", author: "Tubbi", source: "https://commons.wikimedia.org/wiki/File:Colored_carp-streetlight.jpg", teaches: "koi colour-blocking on 3-D form" },
  { rel: "characters-japanese/koi_stencil_novy.jpg", category: "characters-japanese", subject: "koi (stencil)", license: "CC BY-SA 4.0", author: "JeremyNovy", source: "https://commons.wikimedia.org/wiki/File:Koi_Stencil.jpg", teaches: "warm orange/black koi stencil school, top-down" },
  { rel: "characters-japanese/koi_stencil_novy_multi.jpg", category: "characters-japanese", subject: "koi (stencil)", license: "CC BY-SA 4.0", author: "JeremyNovy", source: "https://commons.wikimedia.org/wiki/File:Jeremy_Novy.jpg", teaches: "multi-koi flow-direction layout" },
  { rel: "characters-japanese/koi_mural_nagoya.jpg", category: "characters-japanese", subject: "koi (mural)", license: "CC BY 2.0", author: "rumpleteaser", source: "https://commons.wikimedia.org/wiki/File:Koi_in_front_of_TV_tower_(4550165565).jpg", teaches: "urban-scale koi mural" },
  { rel: "characters-japanese/wave_hokusai_reference.jpg", category: "characters-japanese", subject: "great-wave", license: "Public Domain", author: "Katsushika Hokusai (c.1831)", source: "https://commons.wikimedia.org/wiki/File:The_Great_Wave_off_Kanagawa.jpg", teaches: "wave silhouette + foam fractals + Fuji (EMIT warm teal-cream, never indigo)" },
  // stencils
  { rel: "stencils/warsaw_gorilla_stencil.jpg", category: "stencils", subject: "gorilla", license: "CC BY-SA 3.0 / BY 2.5 / GFDL", author: "Rovdyr", source: "https://commons.wikimedia.org/wiki/File:Stencil_Graffiti_at_Topiel_Street_in_Warsaw_(2).JPG", teaches: "1-colour silhouette stencil (scheme mono/rust-bone)" },
  { rel: "stencils/bruce_lee_stencil.jpg", category: "stencils", subject: "icon-portrait", license: "CC BY 2.0", author: "Giga Paitchadze", source: "https://commons.wikimedia.org/wiki/File:Bruce_Lee_Stencil.jpg", teaches: "high-contrast 2-3 tone chiaroscuro portrait (scheme charcoal-duotone)" },
  { rel: "stencils/koi_stencil.jpg", category: "stencils", subject: "koi", license: "CC BY-SA 4.0", author: "JeremyNovy", source: "https://commons.wikimedia.org/wiki/File:Koi_Stencil.jpg", teaches: "repeat koi motif stencil (scheme rust-bone)" },
  { rel: "stencils/anarchy_a_stencil.jpg", category: "stencils", subject: "symbol (circle-A)", license: "CC BY-SA 3.0/2.5/2.0/1.0 / GFDL", author: "Dfrg.msc", source: "https://commons.wikimedia.org/wiki/File:Anarchy_A_Stencil.jpg", teaches: "single-colour symbol stencil (scheme mono/black-red)" },
  // loose set-root refs (mixed styles for reproduce mode)
  { rel: "wildstyle_halloffame.jpg", category: "classic-styles", subject: "wildstyle-word + character", license: "CC (see file page)", author: "Wikimedia Commons", source: "https://commons.wikimedia.org/wiki/File:Graffiti_aus_der_Hall_of_Fame_in_Ingolstadt.jpg", teaches: "all layers incl. chrome 3D + yellow shines + drips" },
  { rel: "piece_aresone.jpg", category: "classic-styles", subject: "bubble-throwup", license: "CC (see file page)", author: "Wikimedia Commons", source: "https://commons.wikimedia.org/wiki/File:AresOne.jpg", teaches: "minimal throw-up anatomy: fill + single outline" },
  { rel: "wholehouse_berlin.jpg", category: "classic-styles", subject: "whole-wall bombing", license: "CC (see file page)", author: "Wikimedia Commons", source: "https://commons.wikimedia.org/wiki/File:BERLIN_KIDZ_wholehouse,_K%C3%B6penicker_Strasse_Berlin.jpg", teaches: "large-scale composition" },
  { rel: "character_bordalo.jpg", category: "characters-japanese", subject: "animal-character (Bordalo II)", license: "CC (see file page)", author: "Wikimedia Commons", source: "https://commons.wikimedia.org/wiki/File:BordaloII_Nuart_Aberdeen-2018-DSC07437.jpg", teaches: "animal subject / character mass" },
  { rel: "simple_blueheart.jpg", category: "stencils", subject: "simple icon (heart)", license: "CC (see file page)", author: "Wikimedia Commons", source: "https://commons.wikimedia.org/wiki/File:Blue_heart_(634921540).jpg", teaches: "flat silhouette icon (recolor blue->coral 3)" },
  { rel: "tag_anarchist.jpg", category: "classic-styles", subject: "handstyle-tag", license: "CC (see file page)", author: "Wikimedia Commons", source: "https://commons.wikimedia.org/wiki/File:Anarchist_tag_near_Paris_-_October_2025.jpg", teaches: "single-gesture handstyle tag" },
];
// Banksy works were deliberately NOT downloaded: UK has no freedom-of-panorama
// for 2D graphic works, so the underlying art stays copyrighted even under a
// CC photo. Use the stencil SUBJECTS (original, warm) instead of reproducing
// specific protected pieces.
const REFERENCE_NOTE_BANKSY = "Banksy pieces are study-only references, never downloaded/reproduced (no UK FoP for 2D works).";

module.exports = {
  // palette
  PALETTE, PALETTE_COUNT: 14, MURAL_BG, IDX,
  // glyph helpers
  SUPPORTED_GLYPHS, glyphSafe, glyphSafeList,
  // words / phrases
  WRITER_WORDS, WILDSTYLE_LETTERS, FOOTBALL_WORDS, ULTRAS_SLOGANS, PHRASES,
  // colour
  COLOUR_SCHEMES, FOOTBALL_PALETTES, MOOD_SCHEMES,
  // structure
  LAYER_ORDER, TIER_LAYERS, SUBJECTS,
  // reference index
  REFERENCE_ROOT, REFERENCE_IMAGES, REFERENCE_NOTE_BANKSY,
};
