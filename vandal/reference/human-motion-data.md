# Human Hand / Drawing / Writing Motion — Empirical Reference

Real, measured parameters from the primary motor-control and HCI literature, for plugging
into a graffiti-painting motion model instead of hand-tuned constants.

**How to read this file:** every row gives the measured value/range, its units, the exact
formula/parameter it feeds, and a source key `[Xn]` resolved in the **Sources** section at
the bottom. Where a number is genuinely uncertain or device-specific, it is flagged
**(UNCERTAIN)** with the reason.

> Units convention: `s` = seconds, `ms` = milliseconds, `bit` = Shannon information bit,
> `cm/s` = centimetres per second, `Hz` = cycles per second, `px` = canvas pixels.

---

## 0. Quick pick-list (numbers a developer can read straight out)

| Quantity | Use this value | Range | Feeds | Source |
|---|---|---|---|---|
| Fitts intercept `a` (hand pointing) | ~0 ms (tapping) … 230 ms (screen pointing) | −300 … +1000 ms (device dep.) | reach base time | [F1][F2] |
| Fitts slope `b` | ~150 ms/bit | 90 … 450 ms/bit | reach time per bit of ID | [F1][F2] |
| Fitts throughput `1/b` | 5–7 bits/s (skilled hand) | 2.3 … 10.6 bits/s | — | [F1][F4] |
| Steering law form | `T = a + b·(A/W)` | linear, R²≈0.96–0.98 | per-stroke draw time | [S1][S2] |
| 2/3-power exponent β (tang. vel vs radius) | 1/3 = 0.333 | 0.28 … 0.35 measured | speed vs curvature | [P1][P2][P3] |
| 2/3-power exponent (ang. vel vs curvature) | 2/3 = 0.667 | — | equivalent form | [P1][P3] |
| Physiological tremor frequency | 8–12 Hz | 6–12 Hz | tremor oscillator | [T1][T2][T3] |
| Physiological tremor amplitude (hand, postural) | 0.01–0.15 mm peak-to-peak | 0.009–0.153 mm | tremor amplitude | [T4] |
| Handwriting pen speed (peak) | ~10 cm/s | 8–12 cm/s | speed ceiling | [H1][H3] |
| Handwriting mean speed (adult, words) | ~8 cm/s (80 mm/s) | 2–10 cm/s | cruise speed | [H2] |
| Handwriting stroke rhythm | 5 Hz | 3–7 Hz (BW ~10 Hz) | stroke cadence | [H1][H3] |
| Simple reaction time (visual) | 190 ms | 180–200 ms | decision dwell | [R1] |
| Simple reaction time (auditory / touch) | 160 / 155 ms | 140–160 ms | decision dwell | [R1] |
| Choice / recognition RT | ~384 ms | 300–500 ms | tool/colour change | [R1][R2] |
| Hick's law slope | 150 ms/bit | ~100–200 ms/bit | menu/choice delay | [R2][R3] |
| Pen-lift / pause threshold (handwriting) | 200–250 ms | — | inter-stroke pause | [R4][H5] |
| Sigma-lognormals per stroke gesture | 8.1 avg (SD 4.4) | 1–10 | velocity profile shape | [K2] |
| Min-jerk peak/mean speed ratio | 1.875 | exact (model) | velocity bell height | [M1] |
| Submovement rate | 2.5 Hz | ~2–3 Hz | correction sub-strokes | [M2] |
| Submovements per accurate reach | 1 primary + 1–2 corrective | 1–4 | double passes | [M2][M3] |

---

## 1. FITTS'S LAW — discrete reach / hop time

**Model:** `MT = a + b · ID`, with the **Shannon** index of difficulty
`ID = log2(D/W + 1)` (bits), where `D` = distance to target centre, `W` = target width
along the movement axis. The `+1` guarantees `ID ≥ 0`. [F1][F5]

- `a` = intercept (**s** or ms): fixed reaction + homing overhead.
- `b` = slope (**s/bit** or ms/bit): time cost per bit of difficulty.
- `1/b` = throughput / index of performance (bits/s).

**Measured coefficients** (MacKenzie 1992 meta-survey, Table; converted to ms and ms/bit) [F1]:

| Study / device | `a` (ms) | `b` (ms/bit) | `1/b` (bits/s) |
|---|---|---|---|
| Fitts 1954, hand tapping (1 oz stylus) | 12.8 | 94.7 | 10.6 |
| Card et al. 1978, mouse | 1030 | 96 | 10.4 |
| Drury 1975, foot pedal | 187 | 85 | 11.8 |
| Epps 1986, mouse | 108 | 392 | 2.6 |
| Epps 1986, trackball | 282 | 347 | 2.9 |
| Epps 1986, touchpad | 181 | 434 | 2.3 |
| Ware & Mikaelian 1987, eye+button | 680 | 73 | 13.7 |
| Kantowitz & Elvers 1988, joystick (pos.) | −328…−447 | 297 | 3.4 |

**What to use for a hand/arm on a large surface:** intercept `a` is highly device- and
setup-dependent (it can even be negative from regression); for direct-hand tapping it is
near **0**, for on-screen cursor pointing it is commonly **~150–250 ms**. Slope `b` for
unaided hand/arm pointing clusters around **~150 ms/bit** (throughput ~5–7 bits/s for
skilled users; conventional mouse ~4–6 bits/s; Fitts' original hand ~10 bits/s). [F1][F2][F4]

> Feeds: time to jump the cursor/hand between spray points, tag anchor points, or "hop"
> between letters. `hopTime = a + b · log2(dist/targetSize + 1)`.

---

## 2. STEERING LAW (Accot & Zhai) — per-stroke drawing time from length & width

**Model** (Accot & Zhai, CHI 1997, "Beyond Fitts' Law") [S1]:

- Straight constant-width tunnel: `T = a + b · (A / W)`
- General curved/variable-width path C: `T = a + b · ∫_C ds / W(s)`

`A` = path length, `W` = path (tunnel) width. The **steering index of difficulty is the
dimensionless ratio `A/W`** (or the integral for variable width) — note this is *linear*,
not logarithmic like Fitts. `a` (s) = intercept, `b` (s per `A/W` unit) = slope;
`1/b` = steering index of performance. The linear fit is very tight: replications report
**R² ≈ 0.96–0.98**. [S1][S2][S3]

**Coefficient values — (UNCERTAIN, device- and scale-specific):** Accot & Zhai's original
constants were fitted on a specific **stylus-on-tablet** rig in screen pixels, and the
published constants do not transfer to another canvas/scale without recalibration; the
literature repeatedly stresses that `a`,`b` "vary by input device." [S2][S3] Concrete
anchor points from their circular-steering task (to sanity-check magnitude, not to copy):
mean movement time ≈ **2193 ms (pen tablet)** vs **2532 ms (mouse)** for the same
tunnel; pen error rate 22.9% vs mouse 14.0%. [S4]

> Feeds: total time to lay one graffiti stroke. `strokeTime = a + b · (strokeLength /
> strokeWidth)`. Practical recipe: pick `b` so a "cruise" straight stroke of your typical
> length/width lands at the writing speed from §5, and set `a` from the reach time in §1.
> Narrower strokes (smaller `W`) → longer time, exactly the graffiti "thin detail is slow,
> fat fill is fast" behaviour.

---

## 3. TWO-THIRDS POWER LAW (Viviani & Lacquaniti) — along-stroke velocity vs curvature

**Model** (Viviani & Terzuolo 1982; Lacquaniti, Terzuolo & Viviani 1983; Viviani & Flash
1995) [P1][P2][P3]:

- Angular velocity form: `ω(t) = K · κ(t)^(2/3)` → **exponent = 2/3 ≈ 0.667** (the name).
- Tangential-speed form (the one to code): `V(t) = K · R(t)^(1/3) = K · κ(t)^(−1/3)`
  → **exponent β ≈ 1/3 ≈ 0.333**, where `R` = radius of curvature, `κ = 1/R`.

**Measured exponent:** β is close to but often *slightly below* 1/3; empirical fits
typically land in **0.28–0.35** depending on figure and subject (canonical value 1/3).
Report ~1/3 and allow a tunable 0.3–0.35. [P1][P3]

**Velocity gain factor `K`:** piecewise-constant *within a movement segment* (constant
per "stroke unit"), changing between segments. Its role: `K` sets the overall speed for a
given geometry. [P1][P3]

**Isochrony principle** — movement duration is *approximately independent of movement
size*: bigger figures are drawn proportionally faster, so total time stays near-constant.
Quantitatively this is captured by letting `K` grow with the figure's linear extent /
perimeter `P` (Viviani & McCollum 1983): larger `K ∝ P^~1/3` so duration rises only
*weakly* with size rather than linearly. Practically: doubling stroke size increases
duration by far less than 2× (near-constant, with a mild positive residual). [P3][P4]

> Feeds: the along-stroke speed schedule. Compute path curvature κ(s); set
> `v(s) = K · R(s)^(1/3)` (slow in tight corners, fast on straights). Choose one `K` per
> stroke; scale `K` up with stroke length so long strokes stay time-comparable (isochrony).

---

## 4. PHYSIOLOGICAL / DRAWING TREMOR — micro-jitter amplitude & frequency

**Frequency band:** normal physiological hand/finger tremor has a dominant
**8–12 Hz** component (central/neurogenic), with the whole phenomenon spanning
**~6–12 Hz** as a postural/kinetic tremor. The 8–12 Hz component is stable and tracks
motor-unit firing. [T1][T2][T3]

**Amplitude (normal, healthy hand):** postural hand tremor recorded 14 cm from the wrist
shows mean **peak-to-peak displacement 0.009–0.153 mm** (i.e. ~0.01–0.15 mm), with
acceleration 3–33 cm/s². Amplitude grows with muscle force/effort. [T4] It is *sub-visible*
at the fingertip in absolute terms.

**Deviation of drawn lines from ideal:** tablet figure-tracing studies quantify tremor as
the **oscillation of the drawn line about the reference line** (a standard extracted
metric alongside pen lifts, pressure and speed); it increases with task difficulty and
immaturity. [T5]

> Feeds: tremor oscillator on the pen tip. Model as a small band-limited noise / summed
> sinusoids at **~8–12 Hz** with slowly varying phase, amplitude scaled to effort.
>
> **Canvas-mapping note (must be ≥1 px on a ~4000 px canvas):** 0.01–0.15 mm at the hand
> is tiny; to be visible you must scale it by the physical size the canvas represents.
> If the 4000 px canvas maps to a wall of physical width `Wphys` (mm), then
> `tremor_px = tremor_mm · (4000 / Wphys)`. Example: a 2 m (2000 mm) wall → 2 px/mm →
> 0.15 mm ≈ 0.3 px (still sub-pixel), so for gameplay visibility either (a) treat the
> "hand" as a spray-can lever that amplifies tremor (arm tremor amplitudes are larger
> than fingertip), or (b) apply a deliberate gain ≥ ~3–7× so peak tremor reaches 1–2 px.
> Keep the *frequency* physical (8–12 Hz) and only exaggerate amplitude.

---

## 5. HUMAN DRAWING / WRITING SPEED — speed ceiling + cruise

Pen-tip **tangential** speed (in-contact movement, in-air excluded):

| Task | Speed | Note | Source |
|---|---|---|---|
| Adult handwriting, single words (mean) | ~8 cm/s (80 mm/s) | competent writers | [H2] |
| Handwriting, general peak pen speed | ~10 cm/s | "generally reaches about 10 cm/s" | [H1] |
| 6-year-old beginner (mean) | ~1 cm/s (10 mm/s) | for scale/lower bound | [H2] |
| Per-stroke peak (MPV) | task-dependent | 1 velocity peak/stroke when fluent | [H3][H4] |

**Key mechanism:** handwriting speed is *not* set by a high steady pen velocity but by a
**rapid succession of short strokes** — a rhythmic oscillation at a **primary ~5 Hz
(range 3–7 Hz), bandwidth ~10 Hz**. Fluency = fewer velocity peaks per stroke (ideally 1
per straight segment, 2 per curve). [H1][H3][H5]

**Large arm / graffiti strokes:** direct measurements are sparse in this speed regime, but
large ballistic arm strokes are faster than fine writing; wrist-drawn strokes are ~10 cm
long and large arm strokes up to ~30 cm, executed ballistically. **(UNCERTAIN — extrapolated
from writing kinematics + reach literature.)** [H6]

> Feeds: absolute speed ceiling and cruise. Suggested defaults — **cruise ≈ 5–8 cm/s**
> for controlled line work, **peak ≈ 10–12 cm/s**, faster (scale by arm-length ratio) for
> big fill sweeps. Convert cm/s → px/s using your canvas scale (§4 mapping).

---

## 6. REACTION / DECISION TIME — dwells, tool/colour-change delays

**Simple reaction time** (one stimulus, one response), classic consensus values [R1]:

| Modality | Simple RT | Source note |
|---|---|---|
| Visual (light) | ~190 ms | Galton 1899 (187 ms teens); Welford 1980 |
| Auditory (sound) | ~160 ms | Galton 1899 (158 ms teens) |
| Touch | ~155 ms | Robinson 1934 |

**Recognition / choice RT:** recognition RT ~**384 ms** (Laming 1968), sitting between
simple (~220 ms) and choice; choice RT is longer and grows with the number of
alternatives. [R1][R2]

**Hick–Hyman law** (choice reaction): `RT = a + b · log2(N + 1)`, with **b ≈ 150 ms/bit**;
going 1→2 choices adds the most (~150 ms), 7→8 adds far less (~25 ms). [R2][R3]

**Handwriting pauses / pen-lifts:** pen **stops** are scored when the pen is immobile
**> 200 ms**; short **lifts < 250 ms** are treated as within-word transitions. Pauses are
consistently **longer between words than between characters**. [R4][H5]

> Feeds: decision dwell before starting a tag (~190–400 ms), tool-switch / colour-change
> delay (treat as a choice RT: `~200 ms + 150 ms · log2(nOptions+1)`), and inter-stroke
> pauses (200–250 ms within a piece, longer between "words"/sections).

---

## 7. SIGMA-LOGNORMAL / KINEMATIC THEORY (Plamondon) — velocity-profile shape

**Model:** each stroke's speed profile is a **sum of lognormal impulse responses**
(Kinematic Theory of Rapid Human Movements). Single-lognormal speed: [K1][K3]

```
v(t) = (D / (σ·√(2π)·(t − t0))) · exp( −(ln(t − t0) − μ)² / (2σ²) ),   t > t0
```

Per-lognormal parameters (Sigma-Lognormal):
- `D`  = command amplitude (stroke size / area under the bell).
- `t0` = onset time of the neuromuscular command (s).
- `μ`  = log-time delay (controls *when* the peak occurs; ≈ ln of the mode time).
- `σ`  = log-response time (**controls the asymmetry / skew of the velocity bell** — larger
  σ ⇒ more right-skewed, longer tail). [K1][K3]

**Lognormals per stroke:** a *single simple stroke* is 1–2 lognormals; a whole
**stroke gesture / signature** uses **nbLog between 1 and 10, mean ≈ 8.1 (SD 4.4)**, with
model fit **SNR 15–30 dB (mean ~19.2 dB)** for motor-unimpaired writers. [K2]

**Asymmetry of the bell:** the lognormal is *intrinsically* right-skewed (rise faster than
fall) — this is the model's core claim and matches real rapid-movement velocity profiles,
which are asymmetric bell shapes; the "support-bounded lognormal" best fit 23 competing
profile models. [K3][M4]

**Typical `μ`, `σ` magnitudes — (UNCERTAIN, extractor/task-dependent):** the primary
sources define the parameters but published *ranges* vary by extractor; commonly `σ` is
small (order **0.1–0.4**) and `μ` negative (log-seconds, order **−1 to −2.5**) for fast
strokes. Treat these as starting seeds and calibrate the peak-time/skew to your stroke
durations rather than trusting a single literature number. [K1][K2]

> Feeds: the shape of each stroke's speed(t) — an asymmetric bell (quick rise, slower
> decay) rather than a symmetric one. Seed one lognormal per ballistic sub-stroke; add
> more overlapping lognormals for wiggly/curved strokes.

---

## 8. SUBMOVEMENTS / MINIMUM-JERK — correction sub-strokes, double passes

**Minimum-jerk trajectory** (Flash & Hogan 1985) for a point-to-point reach of amplitude
`D` and duration `T`: [M1]

```
x(t) = D · (10τ³ − 15τ⁴ + 6τ⁵),   τ = t/T
```

- Velocity profile is a **symmetric bell**; time-to-peak-velocity ≈ **0.5·T** for
  intermediate-speed movements. [M1][M5]
- **Peak speed = 1.875 · (D/T)** → **peak/mean speed ratio = 1.875** (exact model result).
  Handy for setting the height of a stroke's speed bell from its mean speed. [M1]

**Submovement structure of a real reach:**
- One **primary** submovement + **corrective** submovements near the target. A fast
  accurate reach commonly shows **1 primary + 1–2 corrective** (2–4 total in demanding
  cases). [M2][M3]
- Submovements recur at a roughly **constant ~2.5 Hz** rate; the *number* of submovements
  is ~proportional to movement time. [M2]
- Endpoint scatter of the primary submovement rises **linearly with its peak velocity**
  (speed–accuracy trade-off at the sub-movement level). [M2]

> Feeds: after the main stroke, add 1–2 short **corrective sub-strokes** (each its own
> min-jerk / lognormal bell) to "fix" the endpoint — the visible little overshoot-and-touch-
> up at the end of a spray line. Spawn corrections at ~2.5 Hz; more of them for
> tighter-accuracy strokes.

---

## 9. MULTI-PASS / RE-TRACING — double passes, pressure build-up

This is the **weakest-quantified** area; report qualitatively with the sources that exist.

- **Retracing (over-tracing) defined:** the pen re-inks an already-drawn portion of a line,
  typically travelling in the *opposite* direction over the existing stroke (down-then-up
  over the same path). A recognised, catalogued human behaviour in questioned-document and
  sketch literature. [X1][X2]
- **Strategy differs by skill/age:** children rehearse and build a figure **piecemeal**
  (more, shorter passes); adults treat a pattern **as a whole** (fewer passes; longer
  patterns cost more retrieval time). [X3]
- **Pen-pressure build-up:** more pressure — and *more variable* pressure — under greater
  difficulty / cognitive load; pressure, pen-lift count, line-oscillation and speed are the
  standard extracted figure-tracing metrics. [X3][T5]
- **(UNCERTAIN):** no clean published "average number of re-traces per line" exists for
  free drawing; use a small stochastic pass count (e.g. 1 pass normal, 2 passes for
  emphasis/fills with ~10–30% probability) and ramp pen pressure/opacity on each pass.

> Feeds: double-pass rendering — probability of a second pass over a stroke, with
> increased pressure → wider/darker line, and slight path deviation between passes (§4
> tremor + §8 corrective offset).

---

## Sources

**Fitts's Law**
- [F1] MacKenzie, I. S. (1992). *Fitts' Law as a Research and Design Tool in Human-Computer
  Interaction.* Human-Computer Interaction 7, 91–139. Coefficient survey table & Shannon ID.
  https://www.yorku.ca/mack/hci1992.html
- [F2] MacKenzie, I. S. (2018 course notes). *Fitts' Law.* Formulation, throughput.
  https://www.yorku.ca/mack/hhci2018.html
- [F4] Soukoreff, R. W. & MacKenzie, I. S. (2004). *Towards a standard for pointing device
  evaluation…* Int. J. Human-Computer Studies 61, 751–789. Interpreting a, b, throughput.
- [F5] Fitts, P. M. (1954). *The information capacity of the human motor system in
  controlling the amplitude of movement.* J. Exp. Psychol. 47, 381–391. Original law.

**Steering Law**
- [S1] Accot, J. & Zhai, S. (1997). *Beyond Fitts' Law: Models for Trajectory-Based HCI
  Tasks.* Proc. CHI '97, 295–302.
  https://research.cs.vt.edu/ns/cs5724papers/2.humanperf.fitts.accot.beyondfitts.pdf
- [S2] Steering law overview (equation, device dependence).
  https://en.wikipedia.org/wiki/Steering_law
- [S3] "Curves Ahead: Enhancing the Steering Law for Complex Curved Trajectories" (2025),
  ID = L/W, MT = a + b·ID, R² ≈ 0.96. https://arxiv.org/html/2503.11914v1
- [S4] Accot & Zhai steering results summary (mouse vs pen movement times / error rates),
  via Nielsen Norman Group. https://www.nngroup.com/articles/steering-law/

**Two-Thirds Power Law & Isochrony**
- [P1] Lacquaniti, F., Terzuolo, C. & Viviani, P. (1983). *The law relating the kinematic
  and figural aspects of drawing movements.* Acta Psychologica 54, 115–130. (2/3 power law.)
- [P2] Viviani, P. & Terzuolo, C. (1982). *Trajectory determines movement dynamics.*
  Neuroscience 7, 431–437.
- [P3] Viviani, P. & Flash, T. (1995). *Minimum-jerk, two-thirds power law, and isochrony:
  converging approaches to movement planning.* J. Exp. Psychol. HPP 21, 32–53.
  http://wexler.free.fr/library/files/viviani%20(1995)%20minimum-jerk,%20two-thirds%20power%20law,%20and%20isochrony.%20converging%20approaches%20to%20movement%20planning.pdf
  (PubMed: https://pubmed.ncbi.nlm.nih.gov/7707032/ )
- [P4] Viviani, P. & McCollum, G. (1983). *The relation between linear extent and velocity
  in drawing movements.* Neuroscience 10, 211–218. (Isochrony / gain factor scaling.)
  Discussed in [P3] and: https://www.jneurosci.org/content/22/18/8201

**Physiological Tremor**
- [T1] Elble, R. J. & Randall, J. E. (1976). *Motor-unit activity responsible for the
  8- to 12-Hz component of human physiological finger tremor.* J. Neurophysiol.
  https://pubmed.ncbi.nlm.nih.gov/943474/
- [T2] *Physiological Tremor (8–12 Hz component) in Isometric Force Control* (2017),
  Neuroscience Letters. https://www.sciencedirect.com/science/article/abs/pii/S0304394017300447
- [T3] Raethjen et al. / *Characteristics of physiologic tremor in young and elderly
  adults* (2004), Clin. Neurophysiol. https://pubmed.ncbi.nlm.nih.gov/12686271/
- [T4] *Diagnostic significance of rhythmicity in postural hand tremor* — normal postural
  hand tremor peak-to-peak amplitude 0.009–0.153 mm, accel 3–33 cm/s² (recorded 14 cm from
  wrist). Scientific Reports. https://www.nature.com/articles/s41598-026-35257-3
- [T5] *Psychological and Physiological Processes in Figure-Tracing Abilities…* (2016),
  Frontiers in Psychology — tablet metrics: pen lifts, line oscillation vs reference,
  pressure, speed. https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5067481/

**Handwriting / Drawing Speed**
- [H1] *Motor control of handwriting in the developing brain: A review* (hal-01734945) —
  handwriting rhythm ~5 Hz, bandwidth ~10 Hz, pen velocity "generally reaches ~10 cm/s."
  https://hal.science/hal-01734945v1/document
- [H2] Pen-tip velocity in handwriting (Schomaker / NICI HWR tutorial) and beginning-writer
  fluency data: competent adults ~80 mm/s writing words; 6-yo ~10 mm/s.
  https://www.ai.rug.nl/~lambert/recog/hwr-tutor/velocity.html ;
  https://pmc.ncbi.nlm.nih.gov/articles/PMC8172624/
- [H3] *Learning Handwriting: Factors Affecting Pen-Movement Fluency in Beginning Writers*
  (2021), Frontiers — mean peak velocity per stroke, velocity-peak counts.
  https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2021.663829/full
- [H4] *Computerized handwriting evaluation…* (2022), Scientific Reports — tangential
  velocity, 10 Hz low-pass, NPV. https://www.nature.com/articles/s41598-022-19913-y
- [H5] Handwriting movement analysis (graphonomics overview / stroke frequency 3–7 Hz).
  https://en.wikipedia.org/wiki/Handwriting_movement_analysis
- [H6] Drawing-tablet stroke-length practitioner data (wrist ~10 cm, arm up to ~30 cm) —
  approximate, non-primary. https://veikk.com/blogs/news/how-to-use-drawing-tablets-tips-for-comfort-and-efficiency

**Reaction / Decision Time**
- [R1] Kosinski, R. J. *A Literature Review on Reaction Time* (Clemson Univ.) — simple RT
  ~190 ms visual / ~160 ms auditory / ~155 ms touch; recognition ~384 ms (Laming 1968);
  cites Galton 1899, Welford 1980, Robinson 1934.
  https://www.fon.hum.uva.nl/rob/Courses/InformationInSpeech/CDROM/Literature/LOTwinterschool2006/biae.clemson.edu/bpc/bp/Lab/110/reaction.htm
- [R2] Proctor, R. W. & Schneider, D. W. (2018). *Hick's law for choice reaction time: A
  review.* Quarterly J. Exp. Psychology. https://pubmed.ncbi.nlm.nih.gov/28434379/
  (PDF: https://web.ics.purdue.edu/~dws/pubs/ProctorSchneider_2018_QJEP.pdf )
- [R3] Hick, W. E. (1952). *On the rate of gain of information.* QJEP 4, 11–26. (b ≈ 150 ms/bit.)
- [R4] *Lifts and stops in proficient and dysgraphic handwriting* (2013), Human Movement
  Science — pen stop > 200 ms, lift < 250 ms.
  https://www.sciencedirect.com/science/article/abs/pii/S0167945713001620

**Sigma-Lognormal / Kinematic Theory (Plamondon)**
- [K1] Plamondon, R. (1995). *A kinematic theory of rapid human movements. Part I.*
  Biological Cybernetics 72, 295–307. (Lognormal impulse response; μ, σ definitions.)
  https://www.researchgate.net/publication/271086989_A_kinematic_theory_of_rapid_human_movements
- [K2] O'Reilly, C. & Plamondon, R. (2009). *Development of a Sigma-Lognormal representation
  for on-line signatures.* Pattern Recognition 42, 3324–3337. nbLog 1–10 (mean 8.1, SD 4.4),
  SNR 15–30 dB (mean 19.2). https://www.sciencedirect.com/science/article/abs/pii/S0031320308004470
  (Extractor: http://www.cenparmi.concordia.ca/ICFHR2008/Proceedings/papers/cr1020.pdf )
- [K3] *The lognormal handwriter: learning, performing, and declining* (2013), Front.
  Psychology — asymmetry / lognormal velocity profile.
  https://pmc.ncbi.nlm.nih.gov/articles/PMC3867641/

**Submovements / Minimum-Jerk**
- [M1] Flash, T. & Hogan, N. (1985). *The coordination of arm movements: an experimentally
  confirmed mathematical model.* J. Neuroscience 5, 1688–1703. (Min-jerk profile;
  peak/mean speed = 1.875.)
- [M2] Meyer, D. E. et al. (1988) optimized-submovement model; and Novak/Milner submovement
  decomposition — ~2.5 Hz submovement rate, count ∝ movement time, endpoint scatter ∝
  peak velocity. https://pmc.ncbi.nlm.nih.gov/articles/PMC4110007/
- [M3] *Characterizing and Predicting Submovements during Human 3-D Arm Reaches* (2014),
  PLOS ONE. https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0103387
- [M4] Plamondon et al., *Modelling velocity profiles of rapid movements: a comparative
  study* (1993), Biological Cybernetics — support-bounded lognormal best of 23 models.
  https://link.springer.com/article/10.1007/BF00226195
- [M5] *Asymmetric velocity and acceleration profiles of human arm movements*, Exp. Brain
  Res. — time-to-peak ≈ 0.5·T at intermediate speeds.
  https://link.springer.com/article/10.1007/BF00248865

**Multi-pass / Re-tracing**
- [X1] Norwitch Document Laboratory — *Individual Characteristics: retracing* definition
  (pen re-inks a line, opposite direction).
  https://www.questioneddocuments.com/individual-characteristics/
- [X2] Sezgin, T. M. & Davis, R. (2004). *Handling Overtraced Strokes in Hand-Drawn
  Sketches.* MIT CSAIL. https://rationale.csail.mit.edu/publications/Sezgin2004Handling.pdf
- [X3] *Pressure, Velocity, and Time in Speeded Drawing of Basic Graphic Patterns by Young
  Children* (Meulenbroek & Van Galen, 1998); and figure-tracing pressure/load studies —
  piecemeal vs whole strategies, pressure ∝ difficulty.
  https://pubmed.ncbi.nlm.nih.gov/9700806/

---

### Model-integration cheat sheet (which number goes where)

| Motion-model stage | Parameter it needs | Section |
|---|---|---|
| Reach/hop to next anchor | `MT = a + b·log2(D/W+1)` | §1 |
| Whole-stroke duration | `T = a + b·(len/width)` | §2 |
| Along-stroke speed schedule | `v(s) = K·R(s)^(1/3)` | §3 |
| Size-invariant timing | scale `K ∝ len^~1/3` (isochrony) | §3 |
| Micro-jitter on pen tip | 8–12 Hz sinusoid noise, amp ×gain→≥1 px | §4 |
| Speed ceiling / cruise | peak ~10–12 cm/s, cruise ~5–8 cm/s | §5 |
| Decision dwell before tag | 190–400 ms | §6 |
| Tool/colour switch delay | `~200 + 150·log2(n+1)` ms | §6 |
| Inter-stroke pause | 200–250 ms (longer between sections) | §6 |
| Stroke speed-bell shape | lognormal, σ≈0.1–0.4 asymmetry | §7 |
| Bell height from mean speed | peak = 1.875 × mean | §8 |
| End-of-stroke touch-ups | 1–2 corrective sub-strokes @ ~2.5 Hz | §8 |
| Double-pass fills | stochastic 2nd pass + pressure ramp | §9 |
