package main

// player.go — one Player per human or bot. Owns the player's live cells,
// nick, hue, mouse-drift target, and queued split/eject flags.

type Player struct {
	id    uint32
	name  nick
	isBot bool
	hue   int

	cells []*PlayerCell // also present in world.cells map

	targetX, targetY float64 // mouse-drift target (world coords)

	queueSplit bool
	queueEject bool

	dead      bool
	finalMass float64 // last total mass at death (for the DEATH packet)
}

func newPlayer(id uint32, name nick, isBot bool) *Player {
	return &Player{
		id:    id,
		name:  name,
		isBot: isBot,
		hue:   randIntN(256),
		cells: nil,
	}
}

func (p *Player) totalMass() float64 {
	m := 0.0
	for _, c := range p.cells {
		m += c.mass
	}
	return m
}

// mass-weighted centroid of own cells (camera target / AoI center).
func (p *Player) centroid() (float64, float64) {
	var sx, sy, tm float64
	for _, c := range p.cells {
		sx += c.x * c.mass
		sy += c.y * c.mass
		tm += c.mass
	}
	if tm == 0 {
		return p.targetX, p.targetY
	}
	return sx / tm, sy / tm
}

// R = sum of own-cell radii (classic zoom / view-size proxy).
func (p *Player) sumRadius() float64 {
	r := 0.0
	for _, c := range p.cells {
		r += c.radius()
	}
	return r
}
