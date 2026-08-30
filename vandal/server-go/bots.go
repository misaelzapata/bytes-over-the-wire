package main

// bots.go — painter bots that keep the mural alive. Mirror of ../server/bots.js.
// Each bot forms a PLAN (a graffiti word or a simple figure) and TRACES it as
// connected paths, streaming begin/append/end just like a human.

import (
	"math"
	"math/rand"
)

const (
	toolBrush = 0
	toolSpray = 5
	flagSoft  = 1
)

func randF(lo, hi float64) float64 { return lo + rand.Float64()*(hi-lo) }
func randInt(lo, hi int) int       { return int(math.Floor(randF(float64(lo), float64(hi)+1))) }

func pickStr(a []string) string { return a[randInt(0, len(a)-1)] }
func pickInt(a []int) int       { return a[randInt(0, len(a)-1)] }

// Vivid, readable palette indices (skip pale creams).
var vivid = []int{3, 4, 5, 7, 8, 9, 10, 11, 12, 13}
var words = []string{"HI", "YO", "OK", "ART", "SUN", "WOW", "HEY", "LOVE", "COOL", "PLAY", "STAR", "VIBE", "NICE"}
var figures = []string{"heart", "star", "sun", "house", "flower", "smiley", "bolt", "spiral"}

var botNames = []string{
	"Sable", "Ochre", "Marigold", "Sienna", "Clementine",
	"Poppy", "Hazel", "Saffron", "Coral", "Amber",
	"Rusty", "Juniper", "Cleo", "Bruno", "Pixel",
}

type fpoint struct{ X, Y float64 }

type botPlan struct {
	meta    strokeMeta
	strokes [][]fpoint
	si      int
	pi      int
	open    bool
}

type bot struct {
	id       uint32
	name     string
	cx, cy   float64
	color    int
	plan     *botPlan
	cooldown int
	press    int
}

type botEvent struct {
	typ     string // "begin" | "append" | "end"
	ownerID uint32
	raw     strokeMeta
	x, y    float64
	points  []Point
}

type BotManager struct {
	allocID func() uint32
	bots    []*bot
}

func NewBotManager(allocID func() uint32) *BotManager {
	return &BotManager{allocID: allocID}
}

func (bm *BotManager) spawnAll(n int) {
	for i := 0; i < n; i++ {
		bm.spawn()
	}
}

func (bm *BotManager) spawn() *bot {
	b := &bot{
		id:       bm.allocID(),
		name:     pickStr(botNames),
		cx:       randF(0.15, 0.85) * CanvasW,
		cy:       randF(0.15, 0.85) * CanvasH,
		color:    pickInt(vivid),
		plan:     nil,
		cooldown: randInt(10, 70),
		press:    0,
	}
	bm.bots = append(bm.bots, b)
	return b
}

func (bm *BotManager) count() int { return len(bm.bots) }

func (bm *BotManager) cursors() []CursorInfo {
	out := make([]CursorInfo, 0, len(bm.bots))
	for _, b := range bm.bots {
		out = append(out, CursorInfo{
			ID:       b.id,
			X:        b.cx,
			Y:        b.cy,
			Pressing: b.press > 0,
			Color:    byte(b.color),
			Tool:     5, // bots use spray can
			Name:     b.name,
		})
	}
	return out
}

func (bm *BotManager) update() []botEvent {
	events := []botEvent{}
	for _, b := range bm.bots {
		if b.press > 0 {
			b.press--
		}
		if b.plan == nil {
			b.cooldown--
			if b.cooldown > 0 {
				b.cx = clampF(b.cx+randF(-6, 6), 20, CanvasW-20)
				b.cy = clampF(b.cy+randF(-6, 6), 20, CanvasH-20)
				continue
			}
			b.plan = bm.makePlan(b)
		}
		bm.advance(b, &events)
	}
	return events
}

func (bm *BotManager) makePlan(b *bot) *botPlan {
	wantWord := rand.Float64() < 0.5
	b.color = pickInt(vivid)
	spray := rand.Float64() < 0.35
	size := 2
	flags := 0
	tool := toolSpray
	if !spray {
		tool = toolBrush
		size = randInt(1, 2)
		flags = flagSoft
	}
	meta := strokeMeta{Tool: byte(tool), Color: byte(b.color), Size: byte(size), Flags: byte(flags)}

	var localSubs [][]fpoint
	var emW, emH float64
	if wantWord {
		subs, w := buildWord(pickStr(words))
		localSubs = subs
		emW = w
		emH = 1
	} else {
		fig := pickStr(figures)
		localSubs = figureBuilders[fig]()
		emW = 1
		emH = 1
	}

	em := randF(180, 340)
	margin := 80.0
	maxW := float64(CanvasW) - margin*2
	maxH := float64(CanvasH) - margin*2
	if emW*em > maxW {
		em = maxW / emW
	}
	if emH*em > maxH {
		em = maxH / emH
	}
	worldW := emW * em
	worldH := emH * em
	ox := randF(margin, float64(CanvasW)-margin-worldW)
	oy := randF(margin, float64(CanvasH)-margin-worldH)

	step := math.Max(10, em*0.06)
	strokes := [][]fpoint{}
	for _, sub := range localSubs {
		world := make([]fpoint, len(sub))
		for i, p := range sub {
			world[i] = fpoint{X: ox + p.X*em, Y: oy + p.Y*em}
		}
		rs := resample(world, step)
		if len(rs) >= 1 {
			strokes = append(strokes, rs)
		}
	}

	return &botPlan{meta: meta, strokes: strokes, si: 0, pi: 0, open: false}
}

func (bm *BotManager) advance(b *bot, events *[]botEvent) {
	plan := b.plan
	if plan.si >= len(plan.strokes) {
		b.plan = nil
		b.cooldown = randInt(30, 110)
		return
	}
	sub := plan.strokes[plan.si]

	if !plan.open {
		p0 := sub[0]
		b.cx = p0.X
		b.cy = p0.Y
		b.press = 4
		plan.open = true
		plan.pi = 1
		*events = append(*events, botEvent{typ: "begin", ownerID: b.id, raw: plan.meta, x: p0.X, y: p0.Y})
		if len(sub) == 1 {
			*events = append(*events, botEvent{typ: "end", ownerID: b.id})
			plan.open = false
			plan.si++
		}
		return
	}

	const batch = 3
	pts := []Point{}
	for k := 0; k < batch && plan.pi < len(sub); k, plan.pi = k+1, plan.pi+1 {
		p := sub[plan.pi]
		pts = append(pts, Point{X: int(p.X), Y: int(p.Y)})
	}
	if len(pts) > 0 {
		last := pts[len(pts)-1]
		b.cx = float64(last.X)
		b.cy = float64(last.Y)
		b.press = 4
		*events = append(*events, botEvent{typ: "append", ownerID: b.id, points: pts})
	}
	if plan.pi >= len(sub) {
		*events = append(*events, botEvent{typ: "end", ownerID: b.id})
		plan.open = false
		plan.si++
	}
}

// ===========================================================================
// Geometry helpers
// ===========================================================================

func resample(pts []fpoint, spacing float64) []fpoint {
	if len(pts) == 0 {
		return []fpoint{}
	}
	if len(pts) == 1 {
		return []fpoint{{pts[0].X, pts[0].Y}}
	}
	out := []fpoint{{pts[0].X, pts[0].Y}}
	px := pts[0].X
	py := pts[0].Y
	for i := 1; i < len(pts); i++ {
		cx := pts[i].X
		cy := pts[i].Y
		dx := cx - px
		dy := cy - py
		seg := math.Hypot(dx, dy)
		if seg == 0 {
			continue
		}
		ux := dx / seg
		uy := dy / seg
		for seg >= spacing {
			px += ux * spacing
			py += uy * spacing
			out = append(out, fpoint{px, py})
			dx = cx - px
			dy = cy - py
			seg = math.Hypot(dx, dy)
		}
		px = cx
		py = cy
	}
	last := out[len(out)-1]
	if math.Hypot(pts[len(pts)-1].X-last.X, pts[len(pts)-1].Y-last.Y) > 1 {
		out = append(out, fpoint{pts[len(pts)-1].X, pts[len(pts)-1].Y})
	}
	return out
}

func arc(cx, cy, r, a0, a1 float64, n int) []fpoint {
	out := make([]fpoint, 0, n+1)
	for i := 0; i <= n; i++ {
		a := a0 + (a1-a0)*(float64(i)/float64(n))
		out = append(out, fpoint{cx + math.Cos(a)*r, cy + math.Sin(a)*r})
	}
	return out
}

func circle(cx, cy, r float64, n int) []fpoint {
	if n == 0 {
		n = 28
	}
	return arc(cx, cy, r, 0, math.Pi*2, n)
}

// ===========================================================================
// Figures (unit cell 0..1 x, 0..1 y, y down)
// ===========================================================================

var figureBuilders = map[string]func() [][]fpoint{
	"heart": func() [][]fpoint {
		pts := []fpoint{}
		for i := 0; i <= 40; i++ {
			t := (float64(i) / 40) * math.Pi * 2
			x := 16 * math.Pow(math.Sin(t), 3)
			y := 13*math.Cos(t) - 5*math.Cos(2*t) - 2*math.Cos(3*t) - math.Cos(4*t)
			pts = append(pts, fpoint{x, -y})
		}
		return [][]fpoint{normalize(pts)}
	},
	"star": func() [][]fpoint {
		pts := []fpoint{}
		cx, cy := 0.5, 0.5
		for i := 0; i <= 10; i++ {
			a := -math.Pi/2 + (float64(i)*math.Pi)/5
			r := 0.21
			if i%2 == 0 {
				r = 0.5
			}
			pts = append(pts, fpoint{cx + math.Cos(a)*r, cy + math.Sin(a)*r})
		}
		return [][]fpoint{pts}
	},
	"sun": func() [][]fpoint {
		subs := [][]fpoint{circle(0.5, 0.5, 0.24, 26)}
		for i := 0; i < 8; i++ {
			a := (float64(i) / 8) * math.Pi * 2
			subs = append(subs, []fpoint{
				{0.5 + math.Cos(a)*0.32, 0.5 + math.Sin(a)*0.32},
				{0.5 + math.Cos(a)*0.48, 0.5 + math.Sin(a)*0.48},
			})
		}
		return subs
	},
	"house": func() [][]fpoint {
		return [][]fpoint{
			{{0.14, 1}, {0.14, 0.46}, {0.86, 0.46}, {0.86, 1}, {0.14, 1}},
			{{0.05, 0.47}, {0.5, 0.08}, {0.95, 0.47}},
			{{0.4, 1}, {0.4, 0.68}, {0.6, 0.68}, {0.6, 1}},
		}
	},
	"flower": func() [][]fpoint {
		subs := [][]fpoint{}
		for i := 0; i < 5; i++ {
			a := -math.Pi/2 + (float64(i)/5)*math.Pi*2
			px := 0.5 + math.Cos(a)*0.22
			py := 0.42 + math.Sin(a)*0.22
			subs = append(subs, circle(px, py, 0.16, 18))
		}
		subs = append(subs, circle(0.5, 0.42, 0.09, 14))
		subs = append(subs, []fpoint{{0.5, 0.56}, {0.5, 1}})
		subs = append(subs, []fpoint{{0.5, 0.8}, {0.74, 0.72}})
		return subs
	},
	"smiley": func() [][]fpoint {
		return [][]fpoint{
			circle(0.5, 0.5, 0.47, 30),
			{{0.34, 0.36}, {0.34, 0.46}},
			{{0.66, 0.36}, {0.66, 0.46}},
			arc(0.5, 0.52, 0.26, math.Pi*0.2, math.Pi*0.8, 14),
		}
	},
	"bolt": func() [][]fpoint {
		return [][]fpoint{
			{{0.62, 0.02}, {0.24, 0.5}, {0.5, 0.5}, {0.14, 0.98}},
		}
	},
	"spiral": func() [][]fpoint {
		pts := []fpoint{}
		for i := 0; i <= 60; i++ {
			t := (float64(i) / 60) * math.Pi * 5
			r := 0.05 + (float64(i)/60)*0.45
			pts = append(pts, fpoint{0.5 + math.Cos(t)*r, 0.5 + math.Sin(t)*r})
		}
		return [][]fpoint{pts}
	},
}

// Normalize a point cloud into [0.05,0.95]² keeping aspect.
func normalize(pts []fpoint) []fpoint {
	minX, minY := math.Inf(1), math.Inf(1)
	maxX, maxY := math.Inf(-1), math.Inf(-1)
	for _, p := range pts {
		minX = math.Min(minX, p.X)
		minY = math.Min(minY, p.Y)
		maxX = math.Max(maxX, p.X)
		maxY = math.Max(maxY, p.Y)
	}
	w := maxX - minX
	if w == 0 {
		w = 1
	}
	h := maxY - minY
	if h == 0 {
		h = 1
	}
	s := 0.9 / math.Max(w, h)
	offX := 0.5 - ((minX+maxX)/2)*s
	offY := 0.5 - ((minY+maxY)/2)*s
	out := make([]fpoint, len(pts))
	for i, p := range pts {
		out[i] = fpoint{p.X*s + offX, p.Y*s + offY}
	}
	return out
}

// ===========================================================================
// Stroke font (capitals) — cell x in [0,0.6], y in [0,1]; advance 0.75 per char
// ===========================================================================

var oLoop = func() []fpoint {
	c := circle(0.3, 0.5, 0.3, 24)
	out := make([]fpoint, len(c))
	for i, p := range c {
		out[i] = fpoint{p.X, (p.Y-0.5)*(1.0/0.6)*0.5 + 0.5}
	}
	return out
}()

var glyphs = map[rune][][]fpoint{
	'A': {{{0, 1}, {0.3, 0}, {0.6, 1}}, {{0.12, 0.6}, {0.48, 0.6}}},
	'B': {
		{{0, 0}, {0, 1}},
		{{0, 0}, {0.42, 0.12}, {0.42, 0.38}, {0, 0.5}},
		{{0, 0.5}, {0.48, 0.62}, {0.48, 0.88}, {0, 1}},
	},
	'C': {{{0.56, 0.18}, {0.3, 0.02}, {0.08, 0.22}, {0.03, 0.5}, {0.08, 0.78}, {0.3, 0.98}, {0.56, 0.82}}},
	'E': {{{0.55, 0}, {0, 0}, {0, 1}, {0.55, 1}}, {{0, 0.5}, {0.42, 0.5}}},
	'H': {{{0, 0}, {0, 1}}, {{0.55, 0}, {0.55, 1}}, {{0, 0.5}, {0.55, 0.5}}},
	'I': {{{0.28, 0}, {0.28, 1}}, {{0.08, 0}, {0.48, 0}}, {{0.08, 1}, {0.48, 1}}},
	'K': {{{0, 0}, {0, 1}}, {{0.5, 0}, {0, 0.55}, {0.52, 1}}},
	'L': {{{0, 0}, {0, 1}, {0.5, 1}}},
	'N': {{{0, 1}, {0, 0}, {0.55, 1}, {0.55, 0}}},
	'O': {oLoop},
	'P': {{{0, 1}, {0, 0}, {0.45, 0.1}, {0.45, 0.4}, {0, 0.5}}},
	'R': {
		{{0, 1}, {0, 0}, {0.45, 0.1}, {0.45, 0.4}, {0, 0.5}},
		{{0.12, 0.5}, {0.54, 1}},
	},
	'S': {{{0.55, 0.15}, {0.3, 0.02}, {0.08, 0.16}, {0.1, 0.4}, {0.5, 0.58}, {0.5, 0.85}, {0.28, 0.98}, {0.05, 0.85}}},
	'T': {{{0, 0}, {0.6, 0}}, {{0.3, 0}, {0.3, 1}}},
	'U': {{{0, 0}, {0, 0.72}, {0.16, 0.96}, {0.44, 0.96}, {0.6, 0.72}, {0.6, 0}}},
	'V': {{{0, 0}, {0.3, 1}, {0.6, 0}}},
	'W': {{{0, 0}, {0.15, 1}, {0.3, 0.4}, {0.45, 1}, {0.6, 0}}},
	'Y': {{{0, 0}, {0.3, 0.5}, {0.6, 0}}, {{0.3, 0.5}, {0.3, 1}}},
}

// Assemble a word into em-space subpaths (y in [0,1]); returns subs and width.
func buildWord(word string) ([][]fpoint, float64) {
	advance := 0.75
	subs := [][]fpoint{}
	x := 0.0
	for _, ch := range word {
		if g, ok := glyphs[ch]; ok {
			for _, sub := range g {
				moved := make([]fpoint, len(sub))
				for i, p := range sub {
					moved[i] = fpoint{p.X + x, p.Y}
				}
				subs = append(subs, moved)
			}
		}
		x += advance
	}
	w := math.Max(0.6, x-(advance-0.6))
	return subs, w
}
