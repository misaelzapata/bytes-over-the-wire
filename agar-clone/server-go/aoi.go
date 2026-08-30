package main

import "math"

// aoi.go — uniform spatial hash (AoiCell=1024) for Area-of-Interest queries and
// the cell/food/virus/eject broad-phase used by the eat passes. Rebuilt each
// tick from the live entity maps.

type gridEntry struct {
	x, y float64
	ref  interface{}
}

type Grid struct {
	cell int
	m    map[int64][]gridEntry
}

func newGrid() *Grid {
	return &Grid{cell: AoiCell, m: make(map[int64][]gridEntry)}
}

func cellKey(cx, cy int) int64 {
	return int64(cx)*100000 + int64(cy)
}

func (g *Grid) clear() {
	// reuse allocation where possible
	g.m = make(map[int64][]gridEntry, len(g.m))
}

func (g *Grid) cellOf(x, y float64) (int, int) {
	return int(math.Floor(x / float64(g.cell))), int(math.Floor(y / float64(g.cell)))
}

func (g *Grid) insert(x, y float64, ref interface{}) {
	cx, cy := g.cellOf(x, y)
	k := cellKey(cx, cy)
	g.m[k] = append(g.m[k], gridEntry{x: x, y: y, ref: ref})
}

// queryCircle returns every entry whose cell overlaps the square bounding
// (x,y,radius). Coarse: caller does the precise circle/overlap test.
func (g *Grid) queryCircle(x, y, radius float64, out []gridEntry) []gridEntry {
	out = out[:0]
	minx, miny := g.cellOf(x-radius, y-radius)
	maxx, maxy := g.cellOf(x+radius, y+radius)
	for cx := minx; cx <= maxx; cx++ {
		for cy := miny; cy <= maxy; cy++ {
			if bucket, ok := g.m[cellKey(cx, cy)]; ok {
				out = append(out, bucket...)
			}
		}
	}
	return out
}
