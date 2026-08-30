package main

import (
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// main.go — CLASSIC agar.io clone authoritative game server (Go).
//   - Serves the static client from ../client over HTTP on PORT (default 4100).
//   - Accepts binary WebSocket upgrades at "/" (little-endian frames).
//   - Runs a fixed 25Hz authoritative simulation (world.go) and speaks the exact
//     binary protocol (protocol.go): per-viewport AoI SNAPSHOT every tick,
//     ~1Hz LEADERBOARD, PONG on demand, DEATH on last-cell loss.
//   - Spawns BotCount AI blobs so the arena is always alive.

// ---- static file serving ----

var mimeTypes = map[string]string{
	".html": "text/html; charset=utf-8",
	".js":   "application/javascript; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".svg":  "image/svg+xml",
	".ico":  "image/x-icon",
	".json": "application/json; charset=utf-8",
}

// If a served .js hardcodes an AGAR_WS placeholder endpoint, rewrite it to
// connect back here. (The reference client derives ws://host itself, so this is
// normally a no-op; kept for parity with the Node server.)
var wsPlaceholderRe = regexp.MustCompile(`wss?://[^"'` + "`" + `]*?AGAR_WS[^"'` + "`" + `]*`)

const wsPlaceholderRepl = `ws://' + location.host + '/`

var clientRoot string

func serveStatic(res http.ResponseWriter, req *http.Request) {
	urlPath := req.URL.Path
	if urlPath == "/" {
		urlPath = "/index.html"
	}
	if urlPath == "/favicon.ico" {
		res.WriteHeader(204)
		return
	}
	filePath := filepath.Join(clientRoot, filepath.Clean(urlPath))
	if !strings.HasPrefix(filePath, clientRoot) {
		res.WriteHeader(403)
		res.Write([]byte("Forbidden"))
		return
	}
	data, err := os.ReadFile(filePath)
	if err != nil {
		res.WriteHeader(404)
		res.Write([]byte("Not found"))
		return
	}
	ext := strings.ToLower(filepath.Ext(filePath))
	mime := mimeTypes[ext]
	if mime == "" {
		mime = "application/octet-stream"
	}
	if ext == ".js" {
		text := string(data)
		if wsPlaceholderRe.MatchString(text) {
			text = wsPlaceholderRe.ReplaceAllString(text, wsPlaceholderRepl)
			res.Header().Set("Content-Type", mime)
			res.Write([]byte(text))
			return
		}
	}
	res.Header().Set("Content-Type", mime)
	res.Write(data)
}

// ---- connection state ----

type conn struct {
	ws        *websocket.Conn
	id        uint32
	handshaken bool
	named     bool
	seenNames map[uint32]bool
	visible   map[uint32]bool
}

var (
	mu      sync.Mutex
	world   *World
	bots    *BotManager
	conns   = make(map[*conn]bool)
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 4096,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

func send(c *conn, frame []byte) {
	c.ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	c.ws.WriteMessage(websocket.BinaryMessage, frame)
}

func rootHandler(res http.ResponseWriter, req *http.Request) {
	if websocket.IsWebSocketUpgrade(req) {
		ws, err := upgrader.Upgrade(res, req, nil)
		if err != nil {
			return
		}
		handleConn(ws)
		return
	}
	serveStatic(res, req)
}

func handleConn(ws *websocket.Conn) {
	c := &conn{
		ws:        ws,
		seenNames: make(map[uint32]bool),
		visible:   make(map[uint32]bool),
	}
	mu.Lock()
	conns[c] = true
	mu.Unlock()

	for {
		_, data, err := ws.ReadMessage()
		if err != nil {
			break
		}
		msg := decodeClient(data)
		if msg == nil {
			continue
		}
		mu.Lock()
		handleClientMessage(c, msg)
		mu.Unlock()
	}

	mu.Lock()
	if c.id != 0 {
		world.removePlayer(c.id)
	}
	delete(conns, c)
	mu.Unlock()
	ws.Close()
}

// mu is held by the caller.
func handleClientMessage(c *conn, msg *clientMsg) {
	switch msg.typ {
	case "handshake":
		c.handshaken = true
		if int(msg.version) != ProtocolVersion {
			send(c, encVersionOutdated())
			c.ws.Close()
		}
	case "nick":
		name := msg.name
		if len(name) > NickMax {
			name = name[:NickMax]
		}
		if c.id != 0 {
			if p := world.players[c.id]; p != nil {
				p.name = name // re-nick existing player
				return
			}
		}
		p := world.addPlayer(name, false)
		c.id = p.id
		c.named = true
		c.seenNames = make(map[uint32]bool)
		c.visible = make(map[uint32]bool)
		send(c, encWelcome(p.id, world.simTick))
	case "target":
		if c.id != 0 {
			if p := world.players[c.id]; p != nil && !p.dead {
				world.setTarget(p, float64(msg.x), float64(msg.y))
			}
		}
	case "split":
		if c.id != 0 {
			if p := world.players[c.id]; p != nil && !p.dead {
				world.requestSplit(p)
			}
		}
	case "eject":
		if c.id != 0 {
			if p := world.players[c.id]; p != nil && !p.dead {
				world.requestEject(p)
			}
		}
	case "ping":
		send(c, encPong(msg.clientMs, world.simTick))
	case "respawn":
		if c.id != 0 {
			if p := world.players[c.id]; p != nil && p.dead {
				world.respawnPlayer(p)
				c.seenNames = make(map[uint32]bool)
				c.visible = make(map[uint32]bool)
				send(c, encWelcome(p.id, world.simTick))
			}
		}
	}
}

// ---- AoI collection (per viewer) ----

type aoiResult struct {
	cells   []*PlayerCell
	foods   []*Food
	viruses []*Virus
	ejects  []*EjectedMass
	cx, cy  float64
	half    float64
}

var aoiScratch []gridEntry

func collectAoI(viewer *Player) aoiResult {
	R := viewer.sumRadius()
	if R < 32 {
		R = 32
	}
	half := pViewHalf(R)
	cx, cy := viewer.centroid()

	var cells []*PlayerCell
	for _, c := range world.cells {
		r := c.radius()
		if math.Abs(c.x-cx) <= half+r && math.Abs(c.y-cy) <= half+r {
			cells = append(cells, c)
		}
	}

	var foods []*Food
	aoiScratch = world.foodGrid.queryCircle(cx, cy, half+32, aoiScratch)
	for _, cand := range aoiScratch {
		f := cand.ref.(*Food)
		if math.Abs(f.x-cx) <= half && math.Abs(f.y-cy) <= half {
			foods = append(foods, f)
		}
	}

	var viruses []*Virus
	for _, v := range world.viruses {
		r := v.radius()
		if math.Abs(v.x-cx) <= half+r && math.Abs(v.y-cy) <= half+r {
			viruses = append(viruses, v)
		}
	}

	var ejects []*EjectedMass
	for _, e := range world.ejects {
		r := e.radius()
		if math.Abs(e.x-cx) <= half+r && math.Abs(e.y-cy) <= half+r {
			ejects = append(ejects, e)
		}
	}

	return aoiResult{cells: cells, foods: foods, viruses: viruses, ejects: ejects, cx: cx, cy: cy, half: half}
}

func buildSnapshotFor(c *conn, viewer *Player) []byte {
	aoi := collectAoI(viewer)
	visibleOwners := make(map[uint32]bool)
	currentIDs := make(map[uint32]bool)

	cellBlocks := make([]sCell, 0, len(aoi.cells))
	for _, cellObj := range aoi.cells {
		currentIDs[cellObj.id] = true
		owner := cellObj.ownerID
		visibleOwners[owner] = true
		flags := 0
		if owner == viewer.id {
			flags |= FlagMine
		}
		if cellObj.boosting() {
			flags |= FlagSplit
		}
		var name nick
		if !c.seenNames[owner] {
			flags |= FlagName
			c.seenNames[owner] = true
			if pl := world.players[owner]; pl != nil {
				name = pl.name
			} else {
				name = nick{}
			}
		}
		cellBlocks = append(cellBlocks, sCell{
			id: cellObj.id, ownerID: owner,
			x: cellObj.x, y: cellObj.y, size: cellObj.radius(),
			hue: cellObj.hue, flags: flags, name: name,
		})
	}
	// Drop owners no longer visible so a re-appearance re-sends the name.
	for o := range c.seenNames {
		if !visibleOwners[o] {
			delete(c.seenNames, o)
		}
	}

	foods := make([]sFood, 0, len(aoi.foods))
	for _, f := range aoi.foods {
		currentIDs[f.id] = true
		foods = append(foods, sFood{id: f.id, x: f.x, y: f.y, hue: f.hue})
	}
	viruses := make([]sVirus, 0, len(aoi.viruses))
	for _, v := range aoi.viruses {
		currentIDs[v.id] = true
		viruses = append(viruses, sVirus{id: v.id, x: v.x, y: v.y, size: v.radius()})
	}
	ejects := make([]sEject, 0, len(aoi.ejects))
	for _, e := range aoi.ejects {
		currentIDs[e.id] = true
		ejects = append(ejects, sEject{id: e.id, x: e.x, y: e.y, hue: e.hue})
	}

	// Removals: previously-visible ids now gone or out of viewport.
	var removes []uint32
	for id := range c.visible {
		if !currentIDs[id] {
			removes = append(removes, id)
		}
	}
	c.visible = currentIDs

	// Eat FX events near this viewport.
	var eats []sEat
	for _, ev := range world.eatEvents {
		if math.Abs(ev.x-aoi.cx) <= aoi.half && math.Abs(ev.y-aoi.cy) <= aoi.half {
			eats = append(eats, sEat{eaterID: ev.eaterID, eatenID: ev.eatenID})
		}
	}

	return encSnapshot(world.simTick, eats, cellBlocks, foods, viruses, ejects, removes)
}

// ---- broadcast pump (called after each sim step; mu held) ----

func broadcastTick() {
	tick := world.simTick

	for c := range conns {
		if c.id == 0 {
			continue
		}
		viewer := world.players[c.id]
		if viewer == nil || viewer.dead {
			continue
		}
		send(c, buildSnapshotFor(c, viewer))
	}
	world.eatEvents = world.eatEvents[:0]

	if len(world.deathEvents) > 0 {
		for _, d := range world.deathEvents {
			for c := range conns {
				if c.id == d.playerID {
					send(c, encDeath(d.finalMass))
					break
				}
			}
		}
		world.deathEvents = world.deathEvents[:0]
	}

	if tick%LeaderboardEvery == 0 {
		allRows := world.leaderboardRows()
		top := allRows
		if len(top) > 10 {
			top = top[:10]
		}
		rankByID := make(map[uint32]int, len(allRows))
		for i, r := range allRows {
			rankByID[r.id] = i + 1
		}
		for c := range conns {
			if c.id == 0 {
				continue
			}
			r := rankByID[c.id]
			yourRank := 0
			if r >= 1 && r <= 10 {
				yourRank = r
			}
			send(c, encLeaderboard(top, yourRank))
		}
	}

	if tick%ResyncEvery == 0 {
		for c := range conns {
			if c.id == 0 {
				continue
			}
			c.seenNames = make(map[uint32]bool)
			c.visible = make(map[uint32]bool)
		}
	}
}

func main() {
	port := 4100
	if v := os.Getenv("PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			port = n
		}
	}

	root, err := filepath.Abs(filepath.Join("..", "client"))
	if err != nil {
		log.Fatal(err)
	}
	clientRoot = root

	world = newWorld()
	bots = newBotManager(world)
	bots.spawnAll(BotCount)

	http.HandleFunc("/", rootHandler)

	// 25Hz loop (accumulator, cap 250ms catch-up)
	go func() {
		ticker := time.NewTicker(StepMs * time.Millisecond)
		defer ticker.Stop()
		lastTime := time.Now()
		accumulator := 0.0
		for range ticker.C {
			now := time.Now()
			accumulator += float64(now.Sub(lastTime).Microseconds()) / 1000.0
			lastTime = now
			if accumulator > 250 {
				accumulator = 250
			}
			for accumulator >= StepMs {
				mu.Lock()
				world.step(func(w *World) { bots.update(w) })
				broadcastTick()
				mu.Unlock()
				accumulator -= StepMs
			}
		}
	}()

	addr := ":" + strconv.Itoa(port)
	log.Printf("agar-clone (go) server listening on http://localhost:%d", port)
	log.Printf("WebSocket endpoint: ws://localhost:%d/", port)
	log.Printf("Serving client from: %s", clientRoot)
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatal(err)
	}
}
