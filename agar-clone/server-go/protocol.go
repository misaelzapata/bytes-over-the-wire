package main

import "encoding/binary"

// protocol.go — binary (de)serialization matching SPEC §12 and server/protocol.js
// byte-for-byte. Every multibyte number is LITTLE-ENDIAN. 1-byte packet id at
// offset 0 of every frame (both directions). World positions/sizes are u16,
// leaderboard masses u32. Strings = [u8 length][length × u16 code unit] UTF-16
// (charCodeAt semantics); names <= NickMax code units, server clamps.

// --- packet ids (Server -> Client) ---
const (
	S2CWelcome         = 0
	S2CSnapshot        = 1
	S2CLeaderboard     = 2
	S2CPong            = 3
	S2CDeath           = 4
	S2CVersionOutdated = 255
)

// --- packet ids (Client -> Server) ---
const (
	C2SSetNick     = 0
	C2SPing        = 1
	C2SInputTarget = 2
	C2SSplit       = 3
	C2SEject       = 4
	C2SRespawn     = 5
	C2SHandshake   = 255
)

// cell-block flag bits (SPEC §12.2)
const (
	FlagMine  = 1 << 0
	FlagName  = 1 << 1
	FlagSplit = 1 << 2
)

// nick is a sequence of UTF-16 code units, matching the JS string model.
type nick []uint16

func clampI(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// absolute world coord -> u16
func encPos(v float64) uint16 { return uint16(clampI(jsRound(v), 0, 65535)) }

// radius -> u16
func encSize(v float64) uint16 { return uint16(clampI(jsRound(v), 0, 65535)) }

// --- tiny growable little-endian writer ---
type Writer struct {
	buf []byte
}

func newWriter(size int) *Writer { return &Writer{buf: make([]byte, 0, size)} }

func (w *Writer) u8(v int) *Writer {
	w.buf = append(w.buf, byte(v&0xff))
	return w
}
func (w *Writer) u16(v int) *Writer {
	var b [2]byte
	binary.LittleEndian.PutUint16(b[:], uint16(v&0xffff))
	w.buf = append(w.buf, b[:]...)
	return w
}
func (w *Writer) u16u(v uint16) *Writer {
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

// str: [u8 length][length × u16 code unit] UTF-16; clamps to NickMax code units.
func (w *Writer) str(s nick) *Writer {
	if len(s) > NickMax {
		s = s[:NickMax]
	}
	w.u8(len(s) & 0xff)
	for _, cu := range s {
		w.u16u(cu)
	}
	return w
}

func (w *Writer) done() []byte { return w.buf }

// --- reader for client->server frames ---
type Reader struct {
	buf []byte
	pos int
}

func newReader(b []byte) *Reader { return &Reader{buf: b} }

func (r *Reader) u8() int {
	v := int(r.buf[r.pos])
	r.pos++
	return v
}
func (r *Reader) u16() int {
	v := int(binary.LittleEndian.Uint16(r.buf[r.pos:]))
	r.pos += 2
	return v
}
func (r *Reader) u32() uint32 {
	v := binary.LittleEndian.Uint32(r.buf[r.pos:])
	r.pos += 4
	return v
}
func (r *Reader) str() nick {
	n := r.u8()
	s := make(nick, 0, n)
	for i := 0; i < n; i++ {
		s = append(s, uint16(r.u16()))
	}
	return s
}

// ===========================================================================
// Server -> Client encoders
// ===========================================================================

// id 0 WELCOME: [u8 0][u32 yourPlayerId][u16 worldW][u16 worldH][u32 serverTick]
func encWelcome(yourID uint32, serverTick uint32) []byte {
	w := newWriter(16)
	w.u8(S2CWelcome).u32(yourID).u16(WorldSize).u16(WorldSize).u32(serverTick)
	return w.done()
}

// snapshot wire structs (already culled to a viewer's AoI by main.go)
type sCell struct {
	id, ownerID uint32
	x, y, size  float64
	hue         int
	flags       int
	name        nick // only written when FlagName is set
}
type sFood struct {
	id   uint32
	x, y float64
	hue  int
}
type sVirus struct {
	id         uint32
	x, y, size float64
}
type sEject struct {
	id   uint32
	x, y float64
	hue  int
}
type sEat struct {
	eaterID, eatenID uint32
}

// id 1 SNAPSHOT (SPEC §12.2)
func encSnapshot(serverTick uint32, eats []sEat, cells []sCell, foods []sFood, viruses []sVirus, ejects []sEject, removes []uint32) []byte {
	w := newWriter(2048)
	w.u8(S2CSnapshot).u32(serverTick)

	w.u16(len(eats))
	for _, e := range eats {
		w.u32(e.eaterID).u32(e.eatenID)
	}

	w.u16(len(cells))
	for _, c := range cells {
		w.u32(c.id).u32(c.ownerID).
			u16u(encPos(c.x)).u16u(encPos(c.y)).u16u(encSize(c.size)).
			u8(c.hue & 0xff).u8(c.flags & 0xff)
		if c.flags&FlagName != 0 {
			w.str(c.name)
		}
	}

	w.u16(len(foods))
	for _, f := range foods {
		w.u32(f.id).u16u(encPos(f.x)).u16u(encPos(f.y)).u8(f.hue & 0xff)
	}

	w.u16(len(viruses))
	for _, v := range viruses {
		w.u32(v.id).u16u(encPos(v.x)).u16u(encPos(v.y)).u16u(encSize(v.size))
	}

	w.u16(len(ejects))
	for _, e := range ejects {
		w.u32(e.id).u16u(encPos(e.x)).u16u(encPos(e.y)).u8(e.hue & 0xff)
	}

	w.u16(len(removes))
	for _, id := range removes {
		w.u32(id)
	}

	return w.done()
}

// id 2 LEADERBOARD: [u8 2][u8 n]{ u32 playerId, u32 mass, str name }[u8 yourRank]
type lbRow struct {
	id   uint32
	mass uint32
	name nick
}

func encLeaderboard(rows []lbRow, yourRank int) []byte {
	w := newWriter(256)
	w.u8(S2CLeaderboard).u8(len(rows))
	for _, r := range rows {
		w.u32(r.id).u32(r.mass).str(r.name)
	}
	w.u8(clampI(yourRank, 0, 255))
	return w.done()
}

// id 3 PONG: [u8 3][u32 clientMs][u32 serverTick]
func encPong(clientMs uint32, serverTick uint32) []byte {
	w := newWriter(9)
	w.u8(S2CPong).u32(clientMs).u32(serverTick)
	return w.done()
}

// id 4 DEATH: [u8 4][u32 finalMass]
func encDeath(finalMass int) []byte {
	if finalMass < 0 {
		finalMass = 0
	}
	w := newWriter(5)
	w.u8(S2CDeath).u32(uint32(finalMass))
	return w.done()
}

// id 255 VERSION_OUTDATED: no payload
func encVersionOutdated() []byte { return []byte{S2CVersionOutdated} }

// ===========================================================================
// Client -> Server decoder
// ===========================================================================

type clientMsg struct {
	typ     string
	version uint32
	name    nick
	clientMs uint32
	x, y    int
	id      int
}

func decodeClient(buf []byte) *clientMsg {
	if len(buf) < 1 {
		return nil
	}
	r := newReader(buf)
	id := r.u8()
	switch id {
	case C2SHandshake:
		var v uint32
		if len(buf) >= 5 {
			v = r.u32()
		}
		return &clientMsg{typ: "handshake", version: v}
	case C2SSetNick:
		if len(buf) < 2 {
			return &clientMsg{typ: "nick", name: nick{}}
		}
		return &clientMsg{typ: "nick", name: r.str()}
	case C2SPing:
		var ms uint32
		if len(buf) >= 5 {
			ms = r.u32()
		}
		return &clientMsg{typ: "ping", clientMs: ms}
	case C2SInputTarget:
		if len(buf) < 5 {
			return nil
		}
		x := r.u16()
		y := r.u16()
		return &clientMsg{typ: "target", x: x, y: y}
	case C2SSplit:
		return &clientMsg{typ: "split"}
	case C2SEject:
		return &clientMsg{typ: "eject"}
	case C2SRespawn:
		return &clientMsg{typ: "respawn"}
	default:
		return &clientMsg{typ: "unknown", id: id}
	}
}
