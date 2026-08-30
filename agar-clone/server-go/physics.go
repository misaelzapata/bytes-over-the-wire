package main

import "math"

// physics.go — shared formulas (SPEC §2, §3, §7, §1.3), duplicated verbatim on
// the client for own-cell prediction parity. Everything runs on full-precision
// float64; the wire quantizes only for transport (protocol.go).

const DT = 1.0 / TickHz // seconds per tick (0.04)

// radius = sqrt(100 * mass) = 10*sqrt(mass)   (Ogar Cell.getSize)
func pRadius(mass float64) float64 { return math.Sqrt(100 * mass) }

// mass = radius^2 / 100
func pMassOf(r float64) float64 { return (r * r) / 100 }

// speed (world units / second): bigger => slower.
func pSpeed(mass float64) float64 { return SpeedBase * math.Pow(mass, SpeedExp) }

// recombine time in whole ticks: max(NoMergeTicks, round((30 + 0.02*mass)*TickHz))
func pRecombineTicks(mass float64) int {
	s := MergeBaseS + MergePerMassS*mass
	t := jsRound(s * TickHz)
	if t < NoMergeTicks {
		return NoMergeTicks
	}
	return t
}

// classic zoom proxy: R = sum of own-cell radii.
func pViewScale(R float64) float64 {
	v := 64 / R
	if v > 1 {
		v = 1
	}
	return math.Pow(v, 0.4)
}

// server AoI half-extent (world units) from the same R the client zooms with.
func pViewHalf(R float64) float64 {
	vs := pViewScale(R)
	return BaseViewH/2/vs + AoiPad
}

func clampF(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// jsRound matches JavaScript's Math.round: floor(v + 0.5) (ties toward +Inf).
func jsRound(v float64) int {
	return int(math.Floor(v + 0.5))
}
