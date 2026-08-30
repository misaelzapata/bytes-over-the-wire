"""world.py -- the authoritative simulation (port of server/world.js).

Owns the entity maps, the ordered 25Hz step(), and the event queues (eats,
deaths) that main.py drains into wire packets each snapshot.

SPEC §11 tick order:
  1 simTick++            6 eat pass (cells eat cells/food/eject; virus pop)
  2 update bots          7 food replenish; virus replenish
  3 apply queued input   8 mass decay
  4 integrate entities   9 cull dead players
  5 own-cell merge/coll  (broadcast handled by main.py)
"""

import math
import random

import constants as C
import physics as P
from cell import PlayerCell, Food, Virus, EjectedMass
from player import Player
from aoi import Grid

_next_id = 1


def _alloc_id():
    global _next_id
    id = _next_id
    _next_id += 1
    if _next_id > 0xFFFFFFFF:
        _next_id = 1
    return id


DT = 1.0 / C.TICK_HZ


class World:
    def __init__(self):
        self.simTick = 0
        self.players = {}   # playerId -> Player
        self.cells = {}     # cellId -> PlayerCell
        self.food = {}      # id -> Food
        self.viruses = {}   # id -> Virus
        self.ejects = {}    # id -> EjectedMass

        self.eatEvents = []    # { eaterId, eatenId, x, y }
        self.deathEvents = []  # { playerId, finalMass }

        self.cellGrid = Grid()
        self.foodGrid = Grid()
        self.virusGrid = Grid()
        self.ejectGrid = Grid()

        self.seedFood()
        self.seedViruses()
        self.rebuildGrids()

    # --- spawning -----------------------------------------------------------

    def randomPos(self, pad=100):
        return (
            pad + random.random() * (C.WORLD_SIZE - 2 * pad),
            pad + random.random() * (C.WORLD_SIZE - 2 * pad),
        )

    def safeSpawn(self):
        safe = 700
        safe2 = safe * safe
        for _ in range(24):
            px, py = self.randomPos(200)
            ok = True
            for c in self.cells.values():
                if c.mass <= C.SPAWN_MASS * C.EAT_RATIO:
                    continue
                dx = c.x - px
                dy = c.y - py
                if dx * dx + dy * dy < safe2:
                    ok = False
                    break
            if ok:
                return (px, py)
        return self.randomPos(200)

    def addPlayer(self, name, isBot):
        id = _alloc_id()
        p = Player(id, name, isBot)
        self.players[id] = p
        self.spawnPlayer(p)
        return p

    def spawnPlayer(self, p):
        px, py = self.safeSpawn()
        p.dead = False
        p.targetX = px
        p.targetY = py
        c = self.newCell(p.id, px, py, C.SPAWN_MASS, p.hue)
        p.cells.append(c)

    def respawnPlayer(self, p):
        for c in p.cells:
            self.cells.pop(c.id, None)
        p.cells.clear()
        self.spawnPlayer(p)

    def removePlayer(self, id):
        p = self.players.get(id)
        if not p:
            return
        for c in p.cells:
            self.cells.pop(c.id, None)
        self.players.pop(id, None)

    def newCell(self, ownerId, x, y, mass, hue):
        c = PlayerCell(_alloc_id(), ownerId, x, y, mass, hue, self.simTick)
        self.cells[c.id] = c
        return c

    def removeCell(self, cell):
        if cell.id not in self.cells:
            return
        del self.cells[cell.id]
        p = self.players.get(cell.ownerId)
        if not p:
            return
        try:
            p.cells.remove(cell)
        except ValueError:
            pass
        if len(p.cells) == 0 and not p.dead:
            p.dead = True
            self.deathEvents.append(
                {"playerId": p.id, "finalMass": P.js_round(p.finalMass)}
            )

    def seedFood(self):
        while len(self.food) < C.FOOD_CAP:
            self.spawnFood()

    def spawnFood(self):
        px, py = self.randomPos(20)
        f = Food(_alloc_id(), px, py, int(random.random() * 256))
        self.food[f.id] = f

    def seedViruses(self):
        while len(self.viruses) < C.VIRUS_MIN:
            self.spawnVirus()

    def spawnVirus(self):
        px, py = self.randomPos(300)
        v = Virus(_alloc_id(), px, py)
        self.viruses[v.id] = v

    # --- input --------------------------------------------------------------

    def setTarget(self, p, x, y):
        if p.dead:
            return
        p.targetX = P.clamp(x, 0, C.WORLD_SIZE)
        p.targetY = P.clamp(y, 0, C.WORLD_SIZE)

    def requestSplit(self, p):
        if not p.dead:
            p.queueSplit = True

    def requestEject(self, p):
        if not p.dead:
            p.queueEject = True

    # --- main tick ----------------------------------------------------------

    def step(self, updateBots):
        self.simTick += 1

        if updateBots:
            updateBots(self)

        for p in self.players.values():
            if p.dead:
                continue
            if p.queueSplit:
                self.doSplit(p)
            if p.queueEject:
                self.doEject(p)
            p.queueSplit = False
            p.queueEject = False

        self.integrate()
        self.rebuildGrids()
        self.resolveOwnCells()

        self.feedViruses()
        self.eatPass()

        if self.simTick % C.FOOD_SPAWN_TICKS == 0:
            budget = C.FOOD_SPAWN_BATCH
            while budget > 0 and len(self.food) < C.FOOD_CAP:
                self.spawnFood()
                budget -= 1
        while len(self.viruses) < C.VIRUS_MIN:
            self.spawnVirus()

        self.decay()

        for p in self.players.values():
            if not p.dead:
                p.finalMass = p.totalMass()

    def integrate(self):
        for c in self.cells.values():
            p = self.players.get(c.ownerId)
            tx = p.targetX if p else c.x
            ty = p.targetY if p else c.y
            dx = tx - c.x
            dy = ty - c.y
            dist = math.hypot(dx, dy)
            if dist > 1e-6:
                step = min(dist, P.speed(c.mass) * DT)
                c.x += (dx / dist) * step
                c.y += (dy / dist) * step
            c.x += c.mx * DT
            c.y += c.my * DT
            c.mx *= C.MOVEENGINE_DECAY
            c.my *= C.MOVEENGINE_DECAY
            self.borderClamp(c)

        for e in self.ejects.values():
            if e.mx != 0 or e.my != 0:
                e.x += e.mx * DT
                e.y += e.my * DT
                e.mx *= C.MOVEENGINE_DECAY
                e.my *= C.MOVEENGINE_DECAY
                if math.hypot(e.mx, e.my) < 5:
                    e.mx = 0
                    e.my = 0
                self.borderClamp(e)

        for v in self.viruses.values():
            if v.mx != 0 or v.my != 0:
                v.x += v.mx * DT
                v.y += v.my * DT
                v.mx *= C.MOVEENGINE_DECAY
                v.my *= C.MOVEENGINE_DECAY
                if math.hypot(v.mx, v.my) < 5:
                    v.mx = 0
                    v.my = 0
                self.borderClamp(v)

    def borderClamp(self, e):
        r = e.radius
        e.x = P.clamp(e.x, r, C.WORLD_SIZE - r)
        e.y = P.clamp(e.y, r, C.WORLD_SIZE - r)

    def rebuildGrids(self):
        self.cellGrid.clear()
        for c in self.cells.values():
            self.cellGrid.insert(c.x, c.y, c)
        self.foodGrid.clear()
        for f in self.food.values():
            self.foodGrid.insert(f.x, f.y, f)
        self.virusGrid.clear()
        for v in self.viruses.values():
            self.virusGrid.insert(v.x, v.y, v)
        self.ejectGrid.clear()
        for e in self.ejects.values():
            self.ejectGrid.insert(e.x, e.y, e)

    # --- own-cell collision + merge (SPEC §7) -------------------------------

    def mergeable(self, cell):
        if cell.boosting:
            return False
        return self.simTick - cell.bornTick >= P.recombine_ticks(cell.mass)

    def resolveOwnCells(self):
        merges = []
        for p in self.players.values():
            cs = p.cells
            for i in range(len(cs)):
                for j in range(i + 1, len(cs)):
                    a = cs[i]
                    b = cs[j]
                    dx = b.x - a.x
                    dy = b.y - a.y
                    d = math.hypot(dx, dy)
                    both_merge = self.mergeable(a) and self.mergeable(b)
                    if both_merge:
                        if d < max(a.radius, b.radius):
                            big = a if a.mass >= b.mass else b
                            small = b if big is a else a
                            merges.append((big, small))
                    else:
                        rsum = a.radius + b.radius
                        if d < rsum:
                            if d < 1e-6:
                                dx = 1
                                dy = 0
                                d = 1
                            push = (rsum - d) / 2
                            nx = dx / d
                            ny = dy / d
                            a.x -= nx * push
                            a.y -= ny * push
                            b.x += nx * push
                            b.y += ny * push
                            self.borderClamp(a)
                            self.borderClamp(b)
        for big, small in merges:
            if big.id not in self.cells or small.id not in self.cells:
                continue
            big.mass += small.mass
            self.removeCell(small)

    # --- eat pass -----------------------------------------------------------

    def feedViruses(self):
        if len(self.ejects) == 0 or len(self.viruses) == 0:
            return
        for e in list(self.ejects.values()):
            near = self.virusGrid.query_circle(
                e.x, e.y, e.radius + P.radius(C.VIRUS_MASS)
            )
            for v in near:
                if v.id not in self.viruses:
                    continue
                dx = e.x - v.x
                dy = e.y - v.y
                if dx * dx + dy * dy < v.radius * v.radius:
                    fx = e.mx
                    fy = e.my
                    if fx == 0 and fy == 0:
                        fx = dx
                        fy = dy
                    fl = math.hypot(fx, fy) or 1
                    v.fx += fx / fl
                    v.fy += fy / fl
                    v.feed += 1
                    self.ejects.pop(e.id, None)
                    if v.feed >= C.VIRUS_FEED_COUNT:
                        self.shootVirus(v)
                    break

    def shootVirus(self, v):
        dx = v.fx
        dy = v.fy
        dl = math.hypot(dx, dy)
        if dl < 1e-6:
            a = random.random() * math.pi * 2
            dx = math.cos(a)
            dy = math.sin(a)
        else:
            dx /= dl
            dy /= dl
        nv = Virus(_alloc_id(), v.x + dx * v.radius, v.y + dy * v.radius)
        nv.mx = dx * C.VIRUS_SPLIT_BOOST
        nv.my = dy * C.VIRUS_SPLIT_BOOST
        self.borderClamp(nv)
        self.viruses[nv.id] = nv
        v.feed = 0
        v.fx = 0
        v.fy = 0

    def eatPass(self):
        sorted_cells = sorted(self.cells.values(), key=lambda c: c.mass, reverse=True)
        for a in sorted_cells:
            if a.id not in self.cells:
                continue
            ar = a.radius

            nf = self.foodGrid.query_circle(a.x, a.y, ar)
            for f in nf:
                if f.id not in self.food:
                    continue
                dx = f.x - a.x
                dy = f.y - a.y
                if dx * dx + dy * dy < ar * ar:
                    a.mass += f.mass
                    self.food.pop(f.id, None)
                    self.eatEvents.append(
                        {"eaterId": a.id, "eatenId": f.id, "x": f.x, "y": f.y}
                    )

            ne = self.ejectGrid.query_circle(a.x, a.y, ar)
            for e in ne:
                if e.id not in self.ejects:
                    continue
                dx = e.x - a.x
                dy = e.y - a.y
                reach = ar - C.EAT_OVERLAP * e.radius
                if dx * dx + dy * dy < reach * reach:
                    a.mass += e.mass
                    self.ejects.pop(e.id, None)
                    self.eatEvents.append(
                        {"eaterId": a.id, "eatenId": e.id, "x": e.x, "y": e.y}
                    )

            if a.mass >= C.VIRUS_POP_MIN_MASS:
                nv = self.virusGrid.query_circle(a.x, a.y, ar)
                for v in nv:
                    if v.id not in self.viruses:
                        continue
                    dx = v.x - a.x
                    dy = v.y - a.y
                    reach = ar - C.EAT_OVERLAP * v.radius
                    if dx * dx + dy * dy < reach * reach:
                        a.mass += v.mass
                        self.viruses.pop(v.id, None)
                        self.eatEvents.append(
                            {"eaterId": a.id, "eatenId": v.id, "x": v.x, "y": v.y}
                        )
                        self.explode(a)
                        break
                if a.id not in self.cells:
                    continue

            nc = self.cellGrid.query_circle(a.x, a.y, ar)
            for b in nc:
                if b is a or b.id not in self.cells:
                    continue
                if b.ownerId == a.ownerId:
                    continue
                if a.mass < C.EAT_RATIO * b.mass:
                    continue
                dx = b.x - a.x
                dy = b.y - a.y
                reach = ar - C.EAT_OVERLAP * b.radius
                if dx * dx + dy * dy < reach * reach:
                    a.mass += b.mass
                    self.eatEvents.append(
                        {"eaterId": a.id, "eatenId": b.id, "x": b.x, "y": b.y}
                    )
                    self.removeCell(b)

    # --- split / eject / pop ------------------------------------------------

    def doSplit(self, p):
        eligible = sorted(
            (c for c in p.cells if c.mass >= C.SPLIT_MIN_MASS),
            key=lambda c: c.mass,
            reverse=True,
        )
        for c in eligible:
            if len(p.cells) >= C.MAX_CELLS:
                break
            half = c.mass / 2
            c.mass = half
            c.bornTick = self.simTick
            dx = p.targetX - c.x
            dy = p.targetY - c.y
            d = math.hypot(dx, dy) or 1
            dx /= d
            dy /= d
            r = P.radius(half)
            nx = c.x + dx * (r + C.SPLIT_OFFSET)
            ny = c.y + dy * (r + C.SPLIT_OFFSET)
            nc = self.newCell(p.id, nx, ny, half, c.hue)
            nc.mx = dx * C.SPLIT_BOOST
            nc.my = dy * C.SPLIT_BOOST
            self.borderClamp(nc)
            p.cells.append(nc)

    def doEject(self, p):
        for c in p.cells:
            if c.mass < C.EJECT_MIN_MASS:
                continue
            c.mass -= C.EJECT_LOSS
            dx = p.targetX - c.x
            dy = p.targetY - c.y
            d = math.hypot(dx, dy) or 1
            ang = math.atan2(dy / d, dx / d)
            ang += (random.random() * 2 - 1) * C.EJECT_DISPERSION
            dx = math.cos(ang)
            dy = math.sin(ang)
            r = c.radius + P.radius(C.EJECT_MASS)
            ex = c.x + dx * r
            ey = c.y + dy * r
            e = EjectedMass(_alloc_id(), ex, ey, c.hue)
            e.mx = dx * C.EJECT_BOOST
            e.my = dy * C.EJECT_BOOST
            self.borderClamp(e)
            self.ejects[e.id] = e

    def explode(self, cell):
        p = self.players.get(cell.ownerId)
        if not p:
            return
        room = C.MAX_CELLS - len(p.cells)
        by_mass = math.floor(cell.mass / C.SPLIT_MIN_MASS) - 1
        pieces = min(room, by_mass)
        if pieces <= 0:
            return
        piece_mass = cell.mass / (pieces + 1)
        cell.mass = piece_mass
        cell.bornTick = self.simTick
        for i in range(pieces):
            ang = (i / pieces) * math.pi * 2 + random.random() * 0.3
            dx = math.cos(ang)
            dy = math.sin(ang)
            nc = self.newCell(p.id, cell.x, cell.y, piece_mass, cell.hue)
            nc.mx = dx * C.SPLIT_BOOST
            nc.my = dy * C.SPLIT_BOOST
            p.cells.append(nc)

    # --- mass decay ---------------------------------------------------------

    def decay(self):
        for c in self.cells.values():
            if c.mass <= C.DECAY_MIN_MASS:
                continue
            c.mass -= c.mass * C.DECAY_RATE * DT
            if c.mass < C.MIN_CELL_MASS:
                c.mass = C.MIN_CELL_MASS

    # --- leaderboard --------------------------------------------------------

    def leaderboardRows(self):
        rows = []
        for p in self.players.values():
            if p.dead or len(p.cells) == 0:
                continue
            rows.append({"id": p.id, "mass": P.js_round(p.totalMass()), "name": p.name})
        rows.sort(key=lambda r: r["mass"], reverse=True)
        return rows
