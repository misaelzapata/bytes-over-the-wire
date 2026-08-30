package main

// main.go — VANDAL cooperative collaborative-mural server (Go).
//
//  - Serves the static client from ../client over HTTP on PORT (default 4504).
//  - Accepts binary WebSocket upgrades at "/" (little-endian frames; see
//    protocol.go for the documented wire spec — a faithful port of the Node ref).
//  - Keeps the authoritative stroke history (mural.go). New joiners get the whole
//    mural (HISTORY) plus in-progress live strokes; every stroke is broadcast as
//    BEGIN -> APPEND* -> STROKE(commit).
//  - Runs a fixed 20Hz loop for painter-bots, ~20Hz cursor snapshots, ~1Hz
//    PRESENCE, and a periodic coordinated GALLERY fly-through cue.
//
// Join sequence: HANDSHAKE(version) -> SET_NICK(name) -> WELCOME -> HISTORY.

import (
	"log"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ===========================================================================
// World state (guarded by mu)
// ===========================================================================

var (
	mu      sync.Mutex
	conns   = map[*conn]bool{}
	mural   = NewMural()
	bots    *BotManager
	nextID  uint32 = 1
	simTick uint32 = 0
)

func allocID() uint32 {
	id := nextID
	nextID++
	return id
}

type conn struct {
	ws        *websocket.Conn
	id        uint32
	name      string
	handshake bool
	named     bool
	cx, cy    float64
	pressing  bool
	color     byte
	tool      byte
	cursorAt  int64 // ms epoch
	meta      strokeMeta
	hasMeta   bool

	out       chan []byte
	quit      chan struct{}
	closeOnce sync.Once
}

func (c *conn) close() {
	c.closeOnce.Do(func() {
		close(c.quit)
		c.ws.Close()
	})
}

func nowMS() int64 { return time.Now().UnixMilli() }

// send enqueues a frame for this connection's writer goroutine.
func send(c *conn, frame []byte) {
	select {
	case c.out <- frame:
	case <-c.quit:
	default:
		// slow consumer — drop the connection rather than block the tick.
		go c.close()
	}
}

// broadcast to every NAMED connection. Callers hold mu.
func broadcast(frame []byte) {
	for c := range conns {
		if c.named {
			send(c, frame)
		}
	}
}

func humanCount() int {
	n := 0
	for c := range conns {
		if c.named {
			n++
		}
	}
	return n
}

func painterCount() int { return humanCount() + bots.count() }

// ===========================================================================
// Streaming orchestration (shared by humans + bots)
// ===========================================================================

func streamBegin(ownerID uint32, meta strokeMeta, x, y float64) *Stroke {
	s := mural.begin(ownerID, meta, x, y)
	broadcast(encStrokeBegin(s))
	return s
}

func streamAppend(ownerID uint32, meta strokeMeta, hasMeta bool, pts []Point) {
	if !mural.isOpen(ownerID) {
		return
	}
	remaining := pts
	for guard := 0; guard < 64 && len(remaining) > 0; guard++ {
		appended, full := mural.append(ownerID, remaining)
		if len(appended) > 0 {
			broadcast(encStrokeAppend(mural.getOpen(ownerID).ID, appended))
		}
		remaining = remaining[len(appended):]
		if full && len(remaining) > 0 {
			open := mural.getOpen(ownerID)
			last := open.Points[len(open.Points)-1]
			committed := mural.end(ownerID)
			if committed != nil {
				broadcast(encStroke(committed))
			}
			nm := meta
			if !hasMeta {
				nm = strokeMeta{Tool: open.Tool, Color: open.Color, Size: open.Size, Flags: open.Flags}
			}
			streamBegin(ownerID, nm, float64(last.X), float64(last.Y))
		} else if len(appended) == 0 {
			break
		}
	}
}

func streamEnd(ownerID uint32) {
	committed := mural.end(ownerID)
	if committed != nil {
		broadcast(encStroke(committed))
	}
}

// ===========================================================================
// Client message handling (caller holds mu)
// ===========================================================================

func handleClientMessage(c *conn, msg *ClientMsg) {
	switch msg.Type {
	case "handshake":
		c.handshake = true
		if msg.Version != ProtocolVersion {
			send(c, encVersionOutdated())
			go c.close()
		}

	case "nick":
		c.name = truncateRunes(msg.Name, NickMax)
		if c.id == 0 {
			c.id = allocID()
		}
		c.named = true
		send(c, encWelcome(c.id, simTick))
		send(c, encHistory(mural.strokes))
		// Replay any in-progress live strokes so a joiner sees them mid-paint.
		for _, open := range mural.open {
			send(c, encStrokeBegin(open))
			if len(open.Points) > 1 {
				send(c, encStrokeAppend(open.ID, open.Points[1:]))
			}
		}
		send(c, encPresence(painterCount()))
		broadcast(encPresence(painterCount()))

	case "stroke":
		if !c.named || c.id == 0 {
			return
		}
		stored := mural.commitStroke(c.id, msg)
		if stored != nil {
			broadcast(encStroke(stored))
		}

	case "stroke_begin":
		if !c.named || c.id == 0 {
			return
		}
		if mural.isOpen(c.id) {
			streamEnd(c.id)
		}
		c.meta = strokeMeta{Tool: msg.Tool, Color: msg.Color, Size: msg.Size, Flags: msg.Flags}
		c.hasMeta = true
		streamBegin(c.id, c.meta, float64(msg.X), float64(msg.Y))

	case "stroke_append":
		if !c.named || c.id == 0 {
			return
		}
		if len(msg.Points) > 0 {
			streamAppend(c.id, c.meta, c.hasMeta, msg.Points)
		}

	case "stroke_end":
		if !c.named || c.id == 0 {
			return
		}
		streamEnd(c.id)

	case "cursor":
		if !c.named || c.id == 0 {
			return
		}
		c.cx = float64(msg.X)
		c.cy = float64(msg.Y)
		c.pressing = msg.Pressing
		c.color = msg.Color
		c.tool = msg.Tool
		c.cursorAt = nowMS()

	case "undo":
		if !c.named || c.id == 0 {
			return
		}
		removed := mural.undoLast(c.id)
		if removed != 0 {
			broadcast(encUndo(removed))
		}

	case "ping":
		send(c, encPong(msg.ClientMs, simTick))
	}
}

func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) > max {
		return string(r[:max])
	}
	return s
}

// ===========================================================================
// Gallery fly-through + cursor snapshot
// ===========================================================================

func triggerGallery() {
	strokes := mural.strokes
	cx := float64(CanvasW) / 2
	cy := float64(CanvasH) / 2
	if len(strokes) > 0 {
		span := 60
		if len(strokes) < span {
			span = len(strokes)
		}
		s := strokes[len(strokes)-1-int(float64(span)*rand.Float64())]
		p := s.Points[len(s.Points)/2]
		cx = float64(p.X)
		cy = float64(p.Y)
	}
	half := 320 + rand.Float64()*380
	broadcast(encGallery(cx, cy, half, float64(GalleryMS)))
}

func broadcastCursors() {
	list := []CursorInfo{}
	now := nowMS()
	for c := range conns {
		if c.named && c.id != 0 && c.cursorAt != 0 && now-c.cursorAt < 2000 {
			list = append(list, CursorInfo{ID: c.id, X: c.cx, Y: c.cy, Pressing: c.pressing, Color: c.color, Tool: c.tool, Name: c.name})
		}
	}
	list = append(list, bots.cursors()...)
	if len(list) > 0 {
		broadcast(encCursors(list))
	}
}

// ===========================================================================
// 20Hz loop
// ===========================================================================

func stepOnce() {
	simTick++

	events := bots.update()
	for _, ev := range events {
		switch ev.typ {
		case "begin":
			streamBegin(ev.ownerID, ev.raw, ev.x, ev.y)
		case "append":
			streamAppend(ev.ownerID, strokeMeta{}, false, ev.points)
		case "end":
			streamEnd(ev.ownerID)
		}
	}

	if simTick%CursorsEvery == 0 {
		broadcastCursors()
	}
	if simTick%PresenceEvery == 0 {
		broadcast(encPresence(painterCount()))
	}
	if simTick%GalleryEvery == 0 {
		triggerGallery()
	}
}

func runLoop() {
	ticker := time.NewTicker(StepMS * time.Millisecond)
	defer ticker.Stop()
	lastTime := nowMS()
	accumulator := int64(0)
	for range ticker.C {
		now := nowMS()
		accumulator += now - lastTime
		lastTime = now
		if accumulator > 250 {
			accumulator = 250
		}
		for accumulator >= StepMS {
			mu.Lock()
			stepOnce()
			mu.Unlock()
			accumulator -= StepMS
		}
	}
}

// ===========================================================================
// Static file serving
// ===========================================================================

var mimeTypes = map[string]string{
	".html": "text/html; charset=utf-8",
	".js":   "application/javascript; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".png":  "image/png",
	".svg":  "image/svg+xml",
	".ico":  "image/x-icon",
	".json": "application/json; charset=utf-8",
}

var clientRoot string

func serveStatic(w http.ResponseWriter, r *http.Request) {
	urlPath := r.URL.Path
	if urlPath == "/" {
		urlPath = "/index.html"
	}
	if urlPath == "/favicon.ico" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	fp := filepath.Join(clientRoot, filepath.Clean(urlPath))
	if !strings.HasPrefix(fp, clientRoot) {
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte("Forbidden"))
		return
	}
	data, err := os.ReadFile(fp)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte("Not found"))
		return
	}
	ext := strings.ToLower(filepath.Ext(fp))
	ct := mimeTypes[ext]
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.WriteHeader(http.StatusOK)
	w.Write(data)
}

// ===========================================================================
// WebSocket handling
// ===========================================================================

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	ws.SetReadLimit(1 << 20)

	c := &conn{
		ws:    ws,
		color: 4,
		out:   make(chan []byte, 512),
		quit:  make(chan struct{}),
	}

	mu.Lock()
	conns[c] = true
	mu.Unlock()

	// writer goroutine (gorilla writes are not concurrency-safe; one writer only)
	go func() {
		for {
			select {
			case <-c.quit:
				return
			case frame := <-c.out:
				ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if err := ws.WriteMessage(websocket.BinaryMessage, frame); err != nil {
					c.close()
					return
				}
			}
		}
	}()

	// read loop (this goroutine)
	for {
		typ, data, err := ws.ReadMessage()
		if err != nil {
			break
		}
		if typ != websocket.BinaryMessage {
			continue
		}
		processFrame(c, data)
	}

	// cleanup
	c.close()
	mu.Lock()
	if c.id != 0 && mural.isOpen(c.id) {
		streamEnd(c.id) // finalize a dropped live stroke
	}
	delete(conns, c)
	broadcast(encPresence(painterCount()))
	mu.Unlock()
}

// processFrame decodes + handles one client frame under the world lock, with a
// recover guard (mirrors the Node try/catch around decodeClient).
func processFrame(c *conn, data []byte) {
	defer func() { _ = recover() }()
	msg := decodeClient(data)
	if msg == nil {
		return
	}
	mu.Lock()
	handleClientMessage(c, msg)
	mu.Unlock()
}

// rootHandler routes WS upgrades on "/" and static files everywhere else.
func rootHandler(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/" && strings.Contains(strings.ToLower(r.Header.Get("Upgrade")), "websocket") {
		handleWS(w, r)
		return
	}
	serveStatic(w, r)
}

func resolveClientRoot() string {
	if env := os.Getenv("CLIENT_ROOT"); env != "" {
		abs, _ := filepath.Abs(env)
		return abs
	}
	candidates := []string{}
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(wd, "..", "client"))
		candidates = append(candidates, filepath.Join(wd, "client"))
	}
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), "..", "client"))
	}
	for _, cand := range candidates {
		if st, err := os.Stat(filepath.Join(cand, "index.html")); err == nil && !st.IsDir() {
			abs, _ := filepath.Abs(cand)
			return abs
		}
	}
	// fallback: ../client from wd
	abs, _ := filepath.Abs(filepath.Join("..", "client"))
	return abs
}

func main() {
	rand.Seed(time.Now().UnixNano())

	port := 4504
	if p := os.Getenv("PORT"); p != "" {
		if n, err := strconv.Atoi(p); err == nil {
			port = n
		}
	}

	clientRoot = resolveClientRoot()

	bots = NewBotManager(allocID)
	bots.spawnAll(BotCount)

	go runLoop()

	mux := http.NewServeMux()
	mux.HandleFunc("/", rootHandler)

	addr := ":" + strconv.Itoa(port)
	log.Printf("VANDAL server listening on http://localhost:%d", port)
	log.Printf("WebSocket endpoint: ws://localhost:%d/", port)
	log.Printf("Serving client from: %s", clientRoot)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}
