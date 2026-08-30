"""bots.py -- simple AI blobs so the arena is always alive (port of server/bots.js).

Each bot is a normal Player (isBot=True) driven through the same setTarget /
requestSplit input path humans use.
"""

import math
import random

import constants as C

BOT_NAMES = [
    "Blobby", "Nomz", "Gulp", "Squish", "Pac", "Chonk", "Orbit", "Gooey",
    "Wobble", "Munch", "Bubble", "Jelly", "Splat", "Zippy", "Void", "Puddle",
    "Dot", "Marble", "Cell", "Nibble",
]


class BotManager:
    def __init__(self, world):
        self.world = world
        self.bots = []  # { id, roamX, roamY }

    def spawnAll(self, count=C.BOT_COUNT):
        for i in range(count):
            name = BOT_NAMES[i % len(BOT_NAMES)]
            p = self.world.addPlayer(name, True)
            self.bots.append({"id": p.id, "roamX": 0, "roamY": 0})

    def update(self, world):
        for bot in self.bots:
            p = world.players.get(bot["id"])
            if not p:
                continue
            if p.dead:
                world.respawnPlayer(p)
                continue
            if len(p.cells) == 0:
                continue

            big = p.cells[0]
            for c in p.cells:
                if c.mass > big.mass:
                    big = c
            cx = big.x
            cy = big.y

            R = 1300
            threat = None
            threat_d2 = R * R
            prey = None
            prey_d2 = R * R
            for c in world.cellGrid.query_circle(cx, cy, R):
                if c.ownerId == p.id:
                    continue
                dx = c.x - cx
                dy = c.y - cy
                d2 = dx * dx + dy * dy
                if c.mass >= big.mass * C.EAT_RATIO:
                    if d2 < threat_d2:
                        threat_d2 = d2
                        threat = c
                elif big.mass >= c.mass * 1.3:
                    if d2 < prey_d2:
                        prey_d2 = d2
                        prey = c

            if threat:
                ax = cx - threat.x
                ay = cy - threat.y
                d = math.hypot(ax, ay) or 1
                world.setTarget(p, cx + (ax / d) * 900, cy + (ay / d) * 900)
            elif prey:
                world.setTarget(p, prey.x, prey.y)
                if (
                    big.mass >= C.SPLIT_MIN_MASS
                    and big.mass >= prey.mass * 2.5
                    and prey_d2 < (big.radius + 200) * (big.radius + 200)
                    and random.random() < 0.05
                ):
                    world.requestSplit(p)
            else:
                food = None
                fd2 = math.inf
                for f in world.foodGrid.query_circle(cx, cy, 1000):
                    dx = f.x - cx
                    dy = f.y - cy
                    d2 = dx * dx + dy * dy
                    if d2 < fd2:
                        fd2 = d2
                        food = f
                if food:
                    world.setTarget(p, food.x, food.y)
                else:
                    near = (
                        abs(cx - bot["roamX"]) < 80 and abs(cy - bot["roamY"]) < 80
                    )
                    if near or random.random() < 0.02 or (
                        bot["roamX"] == 0 and bot["roamY"] == 0
                    ):
                        px, py = world.randomPos(300)
                        bot["roamX"] = px
                        bot["roamY"] = py
                    world.setTarget(p, bot["roamX"], bot["roamY"])
