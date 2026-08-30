package main

import (
	"math"
	"unicode/utf16"
)

// bots.go — simple AI blobs so the arena is always alive. Each bot is a normal
// Player (isBot=true) and drives itself through the SAME setTarget/requestSplit
// input path humans use.

var botNames = []string{
	"Blobby", "Nomz", "Gulp", "Squish", "Pac", "Chonk", "Orbit", "Gooey",
	"Wobble", "Munch", "Bubble", "Jelly", "Splat", "Zippy", "Void", "Puddle",
	"Dot", "Marble", "Cell", "Nibble",
}

type botState struct {
	id           uint32
	roamX, roamY float64
}

type BotManager struct {
	world   *World
	bots    []*botState
	scratch []gridEntry
}

func newBotManager(w *World) *BotManager {
	return &BotManager{world: w}
}

func (bm *BotManager) spawnAll(count int) {
	for i := 0; i < count; i++ {
		name := nick(utf16.Encode([]rune(botNames[i%len(botNames)])))
		p := bm.world.addPlayer(name, true)
		bm.bots = append(bm.bots, &botState{id: p.id})
	}
}

func (bm *BotManager) update(world *World) {
	for _, bot := range bm.bots {
		p := world.players[bot.id]
		if p == nil {
			continue
		}
		if p.dead {
			world.respawnPlayer(p)
			continue
		}
		if len(p.cells) == 0 {
			continue
		}

		// reference point = the bot's largest cell
		big := p.cells[0]
		for _, c := range p.cells {
			if c.mass > big.mass {
				big = c
			}
		}
		cx := big.x
		cy := big.y

		const R = 1300.0
		var threat, prey *PlayerCell
		threatD2 := R * R
		preyD2 := R * R
		bm.scratch = world.cellGrid.queryCircle(cx, cy, R, bm.scratch)
		for _, cand := range bm.scratch {
			c := cand.ref.(*PlayerCell)
			if c.ownerID == p.id {
				continue
			}
			dx := c.x - cx
			dy := c.y - cy
			d2 := dx*dx + dy*dy
			if c.mass >= big.mass*EatRatio {
				if d2 < threatD2 {
					threatD2 = d2
					threat = c
				}
			} else if big.mass >= c.mass*1.3 {
				if d2 < preyD2 {
					preyD2 = d2
					prey = c
				}
			}
		}

		if threat != nil {
			ax := cx - threat.x
			ay := cy - threat.y
			d := math.Hypot(ax, ay)
			if d == 0 {
				d = 1
			}
			world.setTarget(p, cx+(ax/d)*900, cy+(ay/d)*900)
		} else if prey != nil {
			world.setTarget(p, prey.x, prey.y)
			if big.mass >= SplitMinMass &&
				big.mass >= prey.mass*2.5 &&
				preyD2 < (big.radius()+200)*(big.radius()+200) &&
				randFloat() < 0.05 {
				world.requestSplit(p)
			}
		} else {
			var food *Food
			fd2 := math.Inf(1)
			bm.scratch = world.foodGrid.queryCircle(cx, cy, 1000, bm.scratch)
			for _, cand := range bm.scratch {
				f := cand.ref.(*Food)
				dx := f.x - cx
				dy := f.y - cy
				d2 := dx*dx + dy*dy
				if d2 < fd2 {
					fd2 = d2
					food = f
				}
			}
			if food != nil {
				world.setTarget(p, food.x, food.y)
			} else {
				near := math.Abs(cx-bot.roamX) < 80 && math.Abs(cy-bot.roamY) < 80
				if near || randFloat() < 0.02 || (bot.roamX == 0 && bot.roamY == 0) {
					rx, ry := world.randomPos(300)
					bot.roamX = rx
					bot.roamY = ry
				}
				world.setTarget(p, bot.roamX, bot.roamY)
			}
		}
	}
}
