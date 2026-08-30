package main

// protocol.go — binary (de)serialization for VANDAL. Byte-for-byte mirror of
// ../server/protocol.js and ../client/js/protocol.js.
//
// WIRE RULES
//   * Every multibyte number is LITTLE-ENDIAN.
//   * 1-byte packet id at offset 0 of every frame (both directions).
//   * Canvas positions are absolute u16.
//   * str := [u8 length][length × u16 code unit]  (UTF-16 via charCodeAt),
//            length <= NickMax code units; server clamps.
//
// STROKE_BLOCK (a completed stroke; shared by HISTORY + STROKE commit):
//   [u32 id][u32 ownerId][u8 tool][u8 color][u8 size][u8 flags]
//   [u16 nPoints]{ u16 x, u16 y } × nPoints

import (
	"encoding/binary"
	"math"
	"unicode/utf16"
)

// --- packet ids: server -> client ---
const (
	S2CWelcome         = 0
	S2CHistory         = 1
	S2CStroke          = 2
	S2CUndo            = 3
	S2CPresence        = 4
	S2CGallery         = 5
	S2CPong            = 6
	S2CCursors         = 7
	S2CStrokeBegin     = 8
	S2CStrokeAppend    = 9
	S2CVersionOutdated = 255
)

// --- packet ids: client -> server ---
const (
	C2SSetNick      = 0
	C2SPing         = 1
	C2SStroke       = 2
	C2SUndo         = 3
	C2SStrokeBegin  = 4
	C2SStrokeAppend = 5
	C2SStrokeEnd    = 6
	C2SCursor       = 7
	C2SHandshake    = 255
)

// flag bits
const (
	FlagSoft    = 1 << 0 // soft (blended) brush vs. hard edge
	CurPressing = 1 << 0 // painter is actively laying down a stroke
)

func clampF(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func clampI(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func roundClampU16(v float64, lo, hi int) uint16 {
	r := int(math.Round(v))
	return uint16(clampI(r, lo, hi))
}

// --- growable little-endian writer ---
type Writer struct {
	buf []byte
}

func NewWriter(size int) *Writer { return &Writer{buf: make([]byte, 0, size)} }

func (w *Writer) u8(v byte) *Writer { w.buf = append(w.buf, v); return w }

func (w *Writer) u16(v uint16) *Writer {
	var b [2]byte
	binary.LittleEndian.PutUint16(b[:], v)
	w.buf = append(w.buf, b[:]...)
	return w
}

func (w *Writer) u32(v uint32) *Writer {
	var b [4]byte
	binary.LittleEndian.PutUint32(b[:], v)
	w.buf = append(w.buf, b[:]...)
	return w
}

// str := [u8 length][length × u16 code unit] UTF-16; clamps to NickMax code units.
func (w *Writer) str(s string) *Writer {
	units := utf16.Encode([]rune(s))
	if len(units) > NickMax {
		units = units[:NickMax]
	}
	w.u8(byte(len(units) & 0xff))
	for _, u := range units {
		w.u16(u)
	}
	return w
}

func (w *Writer) done() []byte { return w.buf }

// --- reader for client->server frames ---
type Reader struct {
	buf []byte
	pos int
}

func NewReader(b []byte) *Reader { return &Reader{buf: b} }

func (r *Reader) u8() byte {
	v := r.buf[r.pos]
	r.pos++
	return v
}

func (r *Reader) u16() uint16 {
	v := binary.LittleEndian.Uint16(r.buf[r.pos:])
	r.pos += 2
	return v
}

func (r *Reader) u32() uint32 {
	v := binary.LittleEndian.Uint32(r.buf[r.pos:])
	r.pos += 4
	return v
}

func (r *Reader) str() string {
	n := int(r.u8())
	units := make([]uint16, n)
	for i := 0; i < n; i++ {
		units[i] = r.u16()
	}
	return string(utf16.Decode(units))
}

func (r *Reader) remaining() int { return len(r.buf) - r.pos }

// --- STROKE_BLOCK ---
func writeStrokeBlock(w *Writer, s *Stroke) {
	w.u32(s.ID).u32(s.OwnerID).u8(s.Tool).u8(s.Color).u8(s.Size).u8(s.Flags).u16(uint16(len(s.Points)))
	for _, p := range s.Points {
		w.u16(roundClampU16(float64(p.X), 0, CanvasW)).u16(roundClampU16(float64(p.Y), 0, CanvasH))
	}
}

// ===========================================================================
// Server -> Client encoders
// ===========================================================================

func encWelcome(yourID uint32, serverTick uint32) []byte {
	return NewWriter(16).u8(S2CWelcome).u32(yourID).u16(CanvasW).u16(CanvasH).u32(serverTick).done()
}

func encHistory(strokes []*Stroke) []byte {
	w := NewWriter(4096)
	w.u8(S2CHistory).u32(uint32(len(strokes)))
	for _, s := range strokes {
		writeStrokeBlock(w, s)
	}
	return w.done()
}

func encStroke(s *Stroke) []byte {
	w := NewWriter(256)
	w.u8(S2CStroke)
	writeStrokeBlock(w, s)
	return w.done()
}

func encStrokeBegin(s *Stroke) []byte {
	var p0 Point
	if len(s.Points) > 0 {
		p0 = s.Points[0]
	}
	return NewWriter(24).
		u8(S2CStrokeBegin).u32(s.ID).u32(s.OwnerID).
		u8(s.Tool).u8(s.Color).u8(s.Size).u8(s.Flags).
		u16(roundClampU16(float64(p0.X), 0, CanvasW)).
		u16(roundClampU16(float64(p0.Y), 0, CanvasH)).done()
}

func encStrokeAppend(id uint32, pts []Point) []byte {
	w := NewWriter(8 + len(pts)*4)
	w.u8(S2CStrokeAppend).u32(id).u16(uint16(len(pts)))
	for _, p := range pts {
		w.u16(roundClampU16(float64(p.X), 0, CanvasW)).u16(roundClampU16(float64(p.Y), 0, CanvasH))
	}
	return w.done()
}

func encUndo(strokeID uint32) []byte {
	return NewWriter(5).u8(S2CUndo).u32(strokeID).done()
}

func encPresence(count int) []byte {
	return NewWriter(3).u8(S2CPresence).u16(uint16(count)).done()
}

type CursorInfo struct {
	ID       uint32
	X, Y     float64
	Pressing bool
	Color    byte
	Tool     byte
	Name     string
}

func encCursors(list []CursorInfo) []byte {
	w := NewWriter(64)
	w.u8(S2CCursors).u16(uint16(len(list)))
	for _, c := range list {
		flags := byte(0)
		if c.Pressing {
			flags = CurPressing
		}
		w.u32(c.ID).
			u16(roundClampU16(c.X, 0, 65535)).
			u16(roundClampU16(c.Y, 0, 65535)).
			u8(flags).u8(c.Color).u8(c.Tool).str(c.Name)
	}
	return w.done()
}

func encGallery(cx, cy, half, durMs float64) []byte {
	return NewWriter(9).
		u8(S2CGallery).
		u16(roundClampU16(cx, 0, 65535)).
		u16(roundClampU16(cy, 0, 65535)).
		u16(roundClampU16(half, 1, 65535)).
		u16(roundClampU16(durMs, 0, 65535)).done()
}

func encPong(clientMs, serverTick uint32) []byte {
	return NewWriter(9).u8(S2CPong).u32(clientMs).u32(serverTick).done()
}

func encVersionOutdated() []byte {
	return []byte{S2CVersionOutdated}
}

// ===========================================================================
// Client -> Server decoder
// ===========================================================================

type ClientMsg struct {
	Type     string
	Version  uint32
	Name     string
	ClientMs uint32
	Tool     byte
	Color    byte
	Size     byte
	Flags    byte
	X, Y     uint16
	Pressing bool
	Points   []Point
	ID       byte
}

func readPoints(r *Reader, cap int) []Point {
	n := int(r.u16())
	if n > cap {
		n = cap
	}
	pts := make([]Point, 0, n)
	for i := 0; i < n && r.remaining() >= 4; i++ {
		pts = append(pts, Point{X: int(r.u16()), Y: int(r.u16())})
	}
	return pts
}

func decodeClient(buf []byte) *ClientMsg {
	if len(buf) < 1 {
		return nil
	}
	r := NewReader(buf)
	id := r.u8()
	switch id {
	case C2SHandshake:
		v := uint32(0)
		if len(buf) >= 5 {
			v = r.u32()
		}
		return &ClientMsg{Type: "handshake", Version: v}
	case C2SSetNick:
		if len(buf) < 2 {
			return &ClientMsg{Type: "nick", Name: ""}
		}
		return &ClientMsg{Type: "nick", Name: r.str()}
	case C2SPing:
		ms := uint32(0)
		if len(buf) >= 5 {
			ms = r.u32()
		}
		return &ClientMsg{Type: "ping", ClientMs: ms}
	case C2SStroke:
		if len(buf) < 7 {
			return nil
		}
		tool := r.u8()
		color := r.u8()
		size := r.u8()
		flags := r.u8()
		pts := readPoints(r, MaxPoints)
		return &ClientMsg{Type: "stroke", Tool: tool, Color: color, Size: size, Flags: flags, Points: pts}
	case C2SStrokeBegin:
		if len(buf) < 9 {
			return nil
		}
		tool := r.u8()
		color := r.u8()
		size := r.u8()
		flags := r.u8()
		x := r.u16()
		y := r.u16()
		return &ClientMsg{Type: "stroke_begin", Tool: tool, Color: color, Size: size, Flags: flags, X: x, Y: y}
	case C2SStrokeAppend:
		if len(buf) < 3 {
			return nil
		}
		pts := readPoints(r, MaxPoints)
		return &ClientMsg{Type: "stroke_append", Points: pts}
	case C2SStrokeEnd:
		return &ClientMsg{Type: "stroke_end"}
	case C2SCursor:
		if len(buf) < 8 {
			return nil
		}
		x := r.u16()
		y := r.u16()
		flags := r.u8()
		color := r.u8()
		tool := r.u8()
		return &ClientMsg{Type: "cursor", X: x, Y: y, Pressing: (flags & CurPressing) != 0, Color: color, Tool: tool}
	case C2SUndo:
		return &ClientMsg{Type: "undo"}
	default:
		return &ClientMsg{Type: "unknown", ID: id}
	}
}

// ensure clampF referenced (used by gallery caller); keep for parity helpers.
var _ = clampF
