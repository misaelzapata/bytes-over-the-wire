"""player.py -- PlayerTracker: one per human or bot (port of server/player.js)."""

import random


class Player:
    def __init__(self, id, name, isBot):
        self.id = id
        self.name = name or ""
        self.isBot = bool(isBot)
        self.hue = int(random.random() * 256)

        self.cells = []  # PlayerCell[] (also present in world.cells)

        # mouse-drift target (world coords)
        self.targetX = 0.0
        self.targetY = 0.0

        # queued one-shot actions
        self.queueSplit = False
        self.queueEject = False

        self.dead = False
        self.finalMass = 0.0

    def totalMass(self):
        m = 0.0
        for c in self.cells:
            m += c.mass
        return m

    def centroid(self):
        sx = 0.0
        sy = 0.0
        tm = 0.0
        for c in self.cells:
            sx += c.x * c.mass
            sy += c.y * c.mass
            tm += c.mass
        if tm == 0:
            return (self.targetX, self.targetY)
        return (sx / tm, sy / tm)

    def sumRadius(self):
        r = 0.0
        for c in self.cells:
            r += c.radius
        return r
