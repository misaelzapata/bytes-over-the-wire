package main

import (
	"math"
	"math/rand"
	"sort"
)

// world.go — the authoritative simulation. Owns the entity maps, the ordered
// 25Hz step(), and the event queues drained into wire packets each snapshot.
//
// SPEC §11 tick order:
//   1 simTick++            6 eat pass (cells eat cells/food/eject; virus pop)
//   2 update bots          7 food replenish; virus replenish
//   3 apply queued input   8 mass decay
//   4 integrate entities   9 record finalMass (cull handled via death events)
//   5 own-cell merge/coll  (broadcast handled by main.go)

// --- random helpers (Math.random parity: uniform [0,1)) ---
func randFloat() float64 { return rand.Float64() }
func randIntN(n int) int  { return int(randFloat() * float64(n)) } // matches (Math.random()*n)|0

// --- id allocation ---
var nextID uint32 = 1

func allocID() uint32 {
	id := nextID
	nextID++
	if nextID > 0xffffffff || nextID == 0 {
		nextID = 1
	}
	return id
}

type eatEvent struct {
	eaterID, eatenID uint32
	x, y             float64
}
type deathEvent struct {
	playerID  uint32
	finalMass int
}

type World struct {
	simTick uint32
	players map[uint32]*Player
	cells   map[uint32]*PlayerCell
	food    map[uint32]*Food
	viruses map[uint32]*Virus
	ejects  map[uint32]*EjectedMass

	eatEvents   []eatEvent
	deathEvents []deathEvent

	cellGrid  *Grid
	foodGrid  *Grid
	virusGrid *Grid
	ejectGrid *Grid

	scratch []gridEntry // reusable query buffer
}

func newWorld() *World {
	w := &World{
		players:   make(map[uint32]*Player),
		cells:     make(map[uint32]*PlayerCell),
		food:      make(map[uint32]*Food),
		viruses:   make(map[uint32]*Virus),
		ejects:    make(map[uint32]*EjectedMass),
		cellGrid:  newGrid(),
		foodGrid:  newGrid(),
		virusGrid: newGrid(),
		ejectGrid: newGrid(),
	}
	w.seedFood()
	w.seedViruses()
	w.rebuildGrids()
	return w
}

// --- spawning -----------------------------------------------------------

func (w *World) randomPos(pad float64) (float64, float64) {
	return pad + randFloat()*(WorldSize-2*pad),
		pad + randFloat()*(WorldSize-2*pad)
}

// A spawn point far from any BIGGER player cell.
func (w *World) safeSpawn() (float64, float64) {
	const safe = 700.0
	const safe2 = safe * safe
	for attempt := 0; attempt < 24; attempt++ {
		px, py := w.randomPos(200)
		ok := true
		for _, c := range w.cells {
			if c.mass <= SpawnMass*EatRatio {
				continue
			}
			dx := c.x - px
			dy := c.y - py
			if dx*dx+dy*dy < safe2 {
				ok = false
				break
			}
		}
		if ok {
			return px, py
		}
	}
	return w.randomPos(200)
}

func (w *World) addPlayer(name nick, isBot bool) *Player {
	id := allocID()
	p := newPlayer(id, name, isBot)
	w.players[id] = p
	w.spawnPlayer(p)
	return p
}

func (w *World) spawnPlayer(p *Player) {
	px, py := w.safeSpawn()
	p.dead = false
	p.targetX = px
	p.targetY = py
	c := w.newCell(p.id, px, py, SpawnMass, p.hue)
	p.cells = append(p.cells, c)
}

func (w *World) respawnPlayer(p *Player) {
	for _, c := range p.cells {
		delete(w.cells, c.id)
	}
	p.cells = p.cells[:0]
	w.spawnPlayer(p)
}

func (w *World) removePlayer(id uint32) {
	p := w.players[id]
	if p == nil {
		return
	}
	for _, c := range p.cells {
		delete(w.cells, c.id)
	}
	delete(w.players, id)
}

func (w *World) newCell(ownerID uint32, x, y, mass float64, hue int) *PlayerCell {
	c := &PlayerCell{id: allocID(), ownerID: ownerID, x: x, y: y, mass: mass, hue: hue, bornTick: int(w.simTick)}
	w.cells[c.id] = c
	return c
}

// Remove one player cell; if it was the owner's last, the player dies.
func (w *World) removeCell(cell *PlayerCell) {
	if _, ok := w.cells[cell.id]; !ok {
		return
	}
	delete(w.cells, cell.id)
	p := w.players[cell.ownerID]
	if p == nil {
		return
	}
	for i, c := range p.cells {
		if c == cell {
			p.cells = append(p.cells[:i], p.cells[i+1:]...)
			break
		}
	}
	if len(p.cells) == 0 && !p.dead {
		p.dead = true
		w.deathEvents = append(w.deathEvents, deathEvent{playerID: p.id, finalMass: jsRound(p.finalMass)})
	}
}

func (w *World) seedFood() {
	for len(w.food) < FoodCap {
		w.spawnFood()
	}
}
func (w *World) spawnFood() {
	px, py := w.randomPos(20)
	f := &Food{id: allocID(), x: px, y: py, hue: randIntN(256), mass: FoodMass}
	w.food[f.id] = f
}
func (w *World) seedViruses() {
	for len(w.viruses) < VirusMin {
		w.spawnVirus()
	}
}
func (w *World) spawnVirus() {
	px, py := w.randomPos(300)
	v := &Virus{id: allocID(), x: px, y: py, mass: VirusMass}
	w.viruses[v.id] = v
}

// --- input (humans + bots share this path) ------------------------------

func (w *World) setTarget(p *Player, x, y float64) {
	if p.dead {
		return
	}
	p.targetX = clampF(x, 0, WorldSize)
	p.targetY = clampF(y, 0, WorldSize)
}
func (w *World) requestSplit(p *Player) {
	if !p.dead {
		p.queueSplit = true
	}
}
func (w *World) requestEject(p *Player) {
	if !p.dead {
		p.queueEject = true
	}
}

// --- main tick ----------------------------------------------------------

func (w *World) step(updateBots func(*World)) {
	w.simTick++

	// 2 — bots register their inputs through the same setTarget/requestX path
	if updateBots != nil {
		updateBots(w)
	}

	// 3 — apply queued one-shot actions
	for _, p := range w.players {
		if p.dead {
			continue
		}
		if p.queueSplit {
			w.doSplit(p)
		}
		if p.queueEject {
			w.doEject(p)
		}
		p.queueSplit = false
		p.queueEject = false
	}

	// 4 — integrate all moving entities
	w.integrate()

	// rebuild broad-phase grids from post-move positions
	w.rebuildGrids()

	// 5 — own-cell collision + merge
	w.resolveOwnCells()

	// 6 — eat pass
	w.feedViruses()
	w.eatPass()

	// 7 — replenishment
	if w.simTick%FoodSpawnTicks == 0 {
		budget := FoodSpawnBatch
		for budget > 0 && len(w.food) < FoodCap {
			w.spawnFood()
			budget--
		}
	}
	for len(w.viruses) < VirusMin {
		w.spawnVirus()
	}

	// 8 — mass decay
	w.decay()

	// record live total-mass for the death card
	for _, p := range w.players {
		if !p.dead {
			p.finalMass = p.totalMass()
		}
	}
}

func (w *World) integrate() {
	for _, c := range w.cells {
		p := w.players[c.ownerID]
		tx, ty := c.x, c.y
		if p != nil {
			tx, ty = p.targetX, p.targetY
		}
		dx := tx - c.x
		dy := ty - c.y
		dist := math.Hypot(dx, dy)
		if dist > 1e-6 {
			step := pSpeed(c.mass) * DT
			if dist < step {
				step = dist
			}
			c.x += (dx / dist) * step
			c.y += (dy / dist) * step
		}
		c.x += c.mx * DT
		c.y += c.my * DT
		c.mx *= MoveEngineDecay
		c.my *= MoveEngineDecay
		w.borderClampCell(c)
	}

	for _, e := range w.ejects {
		if e.mx != 0 || e.my != 0 {
			e.x += e.mx * DT
			e.y += e.my * DT
			e.mx *= MoveEngineDecay
			e.my *= MoveEngineDecay
			if math.Hypot(e.mx, e.my) < 5 {
				e.mx = 0
				e.my = 0
			}
			w.borderClampXY(&e.x, &e.y, e.radius())
		}
	}

	for _, v := range w.viruses {
		if v.mx != 0 || v.my != 0 {
			v.x += v.mx * DT
			v.y += v.my * DT
			v.mx *= MoveEngineDecay
			v.my *= MoveEngineDecay
			if math.Hypot(v.mx, v.my) < 5 {
				v.mx = 0
				v.my = 0
			}
			w.borderClampXY(&v.x, &v.y, v.radius())
		}
	}
}

func (w *World) borderClampCell(c *PlayerCell) {
	r := c.radius()
	c.x = clampF(c.x, r, WorldSize-r)
	c.y = clampF(c.y, r, WorldSize-r)
}
func (w *World) borderClampXY(x, y *float64, r float64) {
	*x = clampF(*x, r, WorldSize-r)
	*y = clampF(*y, r, WorldSize-r)
}

func (w *World) rebuildGrids() {
	w.cellGrid.clear()
	for _, c := range w.cells {
		w.cellGrid.insert(c.x, c.y, c)
	}
	w.foodGrid.clear()
	for _, f := range w.food {
		w.foodGrid.insert(f.x, f.y, f)
	}
	w.virusGrid.clear()
	for _, v := range w.viruses {
		w.virusGrid.insert(v.x, v.y, v)
	}
	w.ejectGrid.clear()
	for _, e := range w.ejects {
		w.ejectGrid.insert(e.x, e.y, e)
	}
}

// --- own-cell collision + merge (SPEC §7) -------------------------------

func (w *World) mergeable(c *PlayerCell) bool {
	if c.boosting() {
		return false
	}
	return int(w.simTick)-c.bornTick >= pRecombineTicks(c.mass)
}

type mergePair struct{ big, small *PlayerCell }

func (w *World) resolveOwnCells() {
	var merges []mergePair
	for _, p := range w.players {
		cs := p.cells
		for i := 0; i < len(cs); i++ {
			for j := i + 1; j < len(cs); j++ {
				a := cs[i]
				b := cs[j]
				dx := b.x - a.x
				dy := b.y - a.y
				d := math.Hypot(dx, dy)
				bothMerge := w.mergeable(a) && w.mergeable(b)
				if bothMerge {
					if d < math.Max(a.radius(), b.radius()) {
						big, small := a, b
						if b.mass > a.mass {
							big, small = b, a
						}
						merges = append(merges, mergePair{big: big, small: small})
					}
				} else {
					rsum := a.radius() + b.radius()
					if d < rsum {
						if d < 1e-6 {
							dx = 1
							dy = 0
							d = 1
						}
						push := (rsum - d) / 2
						nx := dx / d
						ny := dy / d
						a.x -= nx * push
						a.y -= ny * push
						b.x += nx * push
						b.y += ny * push
						w.borderClampCell(a)
						w.borderClampCell(b)
					}
				}
			}
		}
	}
	for _, m := range merges {
		if _, ok := w.cells[m.big.id]; !ok {
			continue
		}
		if _, ok := w.cells[m.small.id]; !ok {
			continue
		}
		m.big.mass += m.small.mass
		w.removeCell(m.small)
	}
}

// --- eat pass (SPEC §4,§5,§8,§9) ----------------------------------------

func (w *World) feedViruses() {
	if len(w.ejects) == 0 || len(w.viruses) == 0 {
		return
	}
	for _, e := range w.ejects {
		near := w.virusGrid.queryCircle(e.x, e.y, e.radius()+pRadius(VirusMass), w.scratch)
		w.scratch = near
		for _, cand := range near {
			v := cand.ref.(*Virus)
			if _, ok := w.viruses[v.id]; !ok {
				continue
			}
			dx := e.x - v.x
			dy := e.y - v.y
			if dx*dx+dy*dy < v.radius()*v.radius() {
				fx := e.mx
				fy := e.my
				if fx == 0 && fy == 0 {
					fx = dx
					fy = dy
				}
				fl := math.Hypot(fx, fy)
				if fl == 0 {
					fl = 1
				}
				v.fx += fx / fl
				v.fy += fy / fl
				v.feed++
				delete(w.ejects, e.id)
				if v.feed >= VirusFeedCount {
					w.shootVirus(v)
				}
				break
			}
		}
	}
}

func (w *World) shootVirus(v *Virus) {
	dx := v.fx
	dy := v.fy
	dl := math.Hypot(dx, dy)
	if dl < 1e-6 {
		a := randFloat() * math.Pi * 2
		dx = math.Cos(a)
		dy = math.Sin(a)
	} else {
		dx /= dl
		dy /= dl
	}
	nv := &Virus{id: allocID(), x: v.x + dx*v.radius(), y: v.y + dy*v.radius(), mass: VirusMass}
	nv.mx = dx * VirusSplitBoost
	nv.my = dy * VirusSplitBoost
	w.borderClampXY(&nv.x, &nv.y, nv.radius())
	w.viruses[nv.id] = nv
	v.feed = 0
	v.fx = 0
	v.fy = 0
}

func (w *World) eatPass() {
	// Larger cells act first so ties resolve in favour of the bigger blob.
	sorted := make([]*PlayerCell, 0, len(w.cells))
	for _, c := range w.cells {
		sorted = append(sorted, c)
	}
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].mass > sorted[j].mass })

	for _, a := range sorted {
		if _, ok := w.cells[a.id]; !ok {
			continue
		}
		ar := a.radius()

		// food
		nf := w.foodGrid.queryCircle(a.x, a.y, ar, w.scratch)
		w.scratch = nf
		for _, cand := range nf {
			f := cand.ref.(*Food)
			if _, ok := w.food[f.id]; !ok {
				continue
			}
			dx := f.x - a.x
			dy := f.y - a.y
			if dx*dx+dy*dy < ar*ar {
				a.mass += f.mass
				delete(w.food, f.id)
				w.eatEvents = append(w.eatEvents, eatEvent{eaterID: a.id, eatenID: f.id, x: f.x, y: f.y})
			}
		}

		// ejected pellets
		ne := w.ejectGrid.queryCircle(a.x, a.y, ar, w.scratch)
		w.scratch = ne
		for _, cand := range ne {
			e := cand.ref.(*EjectedMass)
			if _, ok := w.ejects[e.id]; !ok {
				continue
			}
			dx := e.x - a.x
			dy := e.y - a.y
			reach := ar - EatOverlap*e.radius()
			if dx*dx+dy*dy < reach*reach {
				a.mass += e.mass
				delete(w.ejects, e.id)
				w.eatEvents = append(w.eatEvents, eatEvent{eaterID: a.id, eatenID: e.id, x: e.x, y: e.y})
			}
		}

		// virus pop
		if a.mass >= VirusPopMinMass {
			nv := w.virusGrid.queryCircle(a.x, a.y, ar, w.scratch)
			w.scratch = nv
			for _, cand := range nv {
				v := cand.ref.(*Virus)
				if _, ok := w.viruses[v.id]; !ok {
					continue
				}
				dx := v.x - a.x
				dy := v.y - a.y
				reach := ar - EatOverlap*v.radius()
				if dx*dx+dy*dy < reach*reach {
					a.mass += v.mass
					delete(w.viruses, v.id)
					w.eatEvents = append(w.eatEvents, eatEvent{eaterID: a.id, eatenID: v.id, x: v.x, y: v.y})
					w.explode(a)
					break
				}
			}
			if _, ok := w.cells[a.id]; !ok {
				continue
			}
		}

		// other players' cells
		nc := w.cellGrid.queryCircle(a.x, a.y, ar, w.scratch)
		w.scratch = nc
		for _, cand := range nc {
			b := cand.ref.(*PlayerCell)
			if b == a {
				continue
			}
			if _, ok := w.cells[b.id]; !ok {
				continue
			}
			if b.ownerID == a.ownerID {
				continue
			}
			if a.mass < EatRatio*b.mass {
				continue
			}
			dx := b.x - a.x
			dy := b.y - a.y
			reach := ar - EatOverlap*b.radius()
			if dx*dx+dy*dy < reach*reach {
				a.mass += b.mass
				w.eatEvents = append(w.eatEvents, eatEvent{eaterID: a.id, eatenID: b.id, x: b.x, y: b.y})
				w.removeCell(b)
			}
		}
	}
}

// --- split / eject / pop (SPEC §6,§8,§9) --------------------------------

func (w *World) doSplit(p *Player) {
	eligible := make([]*PlayerCell, 0, len(p.cells))
	for _, c := range p.cells {
		if c.mass >= SplitMinMass {
			eligible = append(eligible, c)
		}
	}
	sort.SliceStable(eligible, func(i, j int) bool { return eligible[i].mass > eligible[j].mass })
	for _, c := range eligible {
		if len(p.cells) >= MaxCells {
			break
		}
		half := c.mass / 2
		c.mass = half
		c.bornTick = int(w.simTick)
		dx := p.targetX - c.x
		dy := p.targetY - c.y
		d := math.Hypot(dx, dy)
		if d == 0 {
			d = 1
		}
		dx /= d
		dy /= d
		r := pRadius(half)
		nx := c.x + dx*(r+SplitOffset)
		ny := c.y + dy*(r+SplitOffset)
		nc := w.newCell(p.id, nx, ny, half, c.hue)
		nc.mx = dx * SplitBoost
		nc.my = dy * SplitBoost
		w.borderClampCell(nc)
		p.cells = append(p.cells, nc)
	}
}

func (w *World) doEject(p *Player) {
	for _, c := range p.cells {
		if c.mass < EjectMinMass {
			continue
		}
		c.mass -= EjectLoss
		dx := p.targetX - c.x
		dy := p.targetY - c.y
		d := math.Hypot(dx, dy)
		if d == 0 {
			d = 1
		}
		ang := math.Atan2(dy/d, dx/d)
		ang += (randFloat()*2 - 1) * EjectDispersion
		dx = math.Cos(ang)
		dy = math.Sin(ang)
		r := c.radius() + pRadius(EjectMass)
		ex := c.x + dx*r
		ey := c.y + dy*r
		e := &EjectedMass{id: allocID(), x: ex, y: ey, hue: c.hue, mass: EjectMass}
		e.mx = dx * EjectBoost
		e.my = dy * EjectBoost
		w.borderClampXY(&e.x, &e.y, e.radius())
		w.ejects[e.id] = e
	}
}

// A popped cell (mass already boosted by VirusMass) scatters into pieces.
func (w *World) explode(cell *PlayerCell) {
	p := w.players[cell.ownerID]
	if p == nil {
		return
	}
	room := MaxCells - len(p.cells)
	byMass := int(math.Floor(cell.mass/SplitMinMass)) - 1
	pieces := room
	if byMass < pieces {
		pieces = byMass
	}
	if pieces <= 0 {
		return
	}
	pieceMass := cell.mass / float64(pieces+1)
	cell.mass = pieceMass
	cell.bornTick = int(w.simTick)
	for i := 0; i < pieces; i++ {
		ang := (float64(i)/float64(pieces))*math.Pi*2 + randFloat()*0.3
		dx := math.Cos(ang)
		dy := math.Sin(ang)
		nc := w.newCell(p.id, cell.x, cell.y, pieceMass, cell.hue)
		nc.mx = dx * SplitBoost
		nc.my = dy * SplitBoost
		p.cells = append(p.cells, nc)
	}
}

// --- mass decay (SPEC §10) ----------------------------------------------

func (w *World) decay() {
	for _, c := range w.cells {
		if c.mass <= DecayMinMass {
			continue
		}
		c.mass -= c.mass * DecayRate * DT
		if c.mass < MinCellMass {
			c.mass = MinCellMass
		}
	}
}

// --- leaderboard (SPEC §13) ---------------------------------------------

func (w *World) leaderboardRows() []lbRow {
	rows := make([]lbRow, 0, len(w.players))
	for _, p := range w.players {
		if p.dead || len(p.cells) == 0 {
			continue
		}
		rows = append(rows, lbRow{id: p.id, mass: uint32(jsRound(p.totalMass())), name: p.name})
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].mass > rows[j].mass })
	return rows
}
