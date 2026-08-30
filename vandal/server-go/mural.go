package main

// mural.go — the authoritative shared canvas state. Mirror of ../server/mural.js.
// The server never rasterizes: it keeps an ordered list of completed strokes plus
// a map of OPEN strokes still being streamed live (one per owner).

import "math"

type Point struct {
	X, Y int
}

type Stroke struct {
	ID      uint32
	OwnerID uint32
	Tool    byte
	Color   byte
	Size    byte
	Flags   byte
	Points  []Point
}

type strokeMeta struct {
	Tool  byte
	Color byte
	Size  byte
	Flags byte
}

func clampIntRound(v float64, lo, hi int) int {
	r := int(math.Round(v))
	return clampI(r, lo, hi)
}

var shapeTools = map[byte]bool{1: true, 2: true, 3: true} // line / rect / circle

type Mural struct {
	strokes      []*Stroke
	open         map[uint32]*Stroke
	nextStrokeID uint32
}

func NewMural() *Mural {
	return &Mural{
		strokes:      []*Stroke{},
		open:         make(map[uint32]*Stroke),
		nextStrokeID: 1,
	}
}

func normMeta(tool, color, size, flags int) strokeMeta {
	return strokeMeta{
		Tool:  byte(clampI(tool, 0, ToolCount-1)),
		Color: byte(clampI(color, 0, PaletteCount-1)),
		Size:  byte(clampI(size, 0, SizeCount-1)),
		Flags: byte(flags & 0xff),
	}
}

func (m *Mural) pushCapped(s *Stroke) {
	m.strokes = append(m.strokes, s)
	if len(m.strokes) > MaxStrokes {
		m.strokes = m.strokes[len(m.strokes)-MaxStrokes:]
	}
}

// one-shot completed stroke (shapes + eraser). Returns nil if no usable geometry.
func (m *Mural) commitStroke(ownerID uint32, msg *ClientMsg) *Stroke {
	meta := normMeta(int(msg.Tool), int(msg.Color), int(msg.Size), int(msg.Flags))
	pts := msg.Points
	if len(pts) > MaxPoints {
		pts = pts[:MaxPoints]
	}
	points := make([]Point, 0, len(pts))
	for _, p := range pts {
		points = append(points, Point{X: clampIntRound(float64(p.X), 0, CanvasW), Y: clampIntRound(float64(p.Y), 0, CanvasH)})
	}
	if len(points) == 0 {
		return nil
	}
	if shapeTools[meta.Tool] && len(points) < 2 {
		return nil
	}
	s := &Stroke{ID: m.nextStrokeID, OwnerID: ownerID, Tool: meta.Tool, Color: meta.Color, Size: meta.Size, Flags: meta.Flags, Points: points}
	m.nextStrokeID++
	m.pushCapped(s)
	return s
}

func (m *Mural) begin(ownerID uint32, meta strokeMeta, x, y float64) *Stroke {
	s := &Stroke{
		ID:      m.nextStrokeID,
		OwnerID: ownerID,
		Tool:    meta.Tool,
		Color:   meta.Color,
		Size:    meta.Size,
		Flags:   meta.Flags,
		Points:  []Point{{X: clampIntRound(x, 0, CanvasW), Y: clampIntRound(y, 0, CanvasH)}},
	}
	m.nextStrokeID++
	m.open[ownerID] = s
	return s
}

// Append points into an owner's open stroke, up to the cap. Returns appended
// points and whether the stroke is now full.
func (m *Mural) append(ownerID uint32, pts []Point) (appended []Point, full bool) {
	open, ok := m.open[ownerID]
	if !ok {
		return nil, false
	}
	for _, p := range pts {
		if len(open.Points) >= MaxPoints {
			break
		}
		q := Point{X: clampIntRound(float64(p.X), 0, CanvasW), Y: clampIntRound(float64(p.Y), 0, CanvasH)}
		open.Points = append(open.Points, q)
		appended = append(appended, q)
	}
	return appended, len(open.Points) >= MaxPoints
}

func (m *Mural) isOpen(ownerID uint32) bool {
	_, ok := m.open[ownerID]
	return ok
}

func (m *Mural) getOpen(ownerID uint32) *Stroke {
	return m.open[ownerID]
}

func (m *Mural) end(ownerID uint32) *Stroke {
	open, ok := m.open[ownerID]
	if !ok {
		return nil
	}
	delete(m.open, ownerID)
	if len(open.Points) == 0 {
		return nil
	}
	m.pushCapped(open)
	return open
}

// Remove the most recent completed stroke by ownerID. Returns id or 0.
func (m *Mural) undoLast(ownerID uint32) uint32 {
	for i := len(m.strokes) - 1; i >= 0; i-- {
		if m.strokes[i].OwnerID == ownerID {
			id := m.strokes[i].ID
			m.strokes = append(m.strokes[:i], m.strokes[i+1:]...)
			return id
		}
	}
	return 0
}
