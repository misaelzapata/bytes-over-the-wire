package main

import "math"

// cell.go — entity types. All positions/masses are full-precision float64;
// radius is derived from mass via radius = sqrt(100*mass).

const boostThresh2 = BoostSpeed * BoostSpeed

type PlayerCell struct {
	id       uint32
	ownerID  uint32
	x, y     float64
	mass     float64
	hue      int
	mx, my   float64 // momentum engine (split/eject/pop impulse), u/s
	bornTick int     // tick this cell last (re)started its merge timer
}

func (c *PlayerCell) radius() float64 { return math.Sqrt(100 * c.mass) }

// "boosting" = the impulse engine is still significant; merges suppressed and
// the wire FlagSplit is set so the client renders the launch.
func (c *PlayerCell) boosting() bool { return c.mx*c.mx+c.my*c.my > boostThresh2 }

type Food struct {
	id   uint32
	x, y float64
	hue  int
	mass float64
}

func (f *Food) radius() float64 { return math.Sqrt(100 * f.mass) }

type Virus struct {
	id     uint32
	x, y   float64
	mass   float64
	mx, my float64 // momentum engine when shot
	feed   int     // ejected pellets absorbed so far
	fx, fy float64 // accumulated feed direction (for the shot)
}

func (v *Virus) radius() float64 { return math.Sqrt(100 * v.mass) }
func (v *Virus) boosting() bool  { return v.mx*v.mx+v.my*v.my > boostThresh2 }

type EjectedMass struct {
	id     uint32
	x, y   float64
	hue    int
	mass   float64
	mx, my float64
}

func (e *EjectedMass) radius() float64 { return math.Sqrt(100 * e.mass) }
