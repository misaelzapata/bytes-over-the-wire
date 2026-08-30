"""cell.py -- entity classes (port of server/cell.js).

PlayerCell / Food / Virus / EjectedMass. Positions/masses are full-precision
floats; radius is derived from mass via radius = sqrt(100*mass).
"""

import math
import constants as C

BOOST_THRESH2 = C.BOOST_SPEED * C.BOOST_SPEED


class PlayerCell:
    __slots__ = ("id", "ownerId", "x", "y", "mass", "hue", "mx", "my", "bornTick")

    def __init__(self, id, ownerId, x, y, mass, hue, bornTick):
        self.id = id
        self.ownerId = ownerId
        self.x = x
        self.y = y
        self.mass = mass
        self.hue = hue
        self.mx = 0.0
        self.my = 0.0
        self.bornTick = bornTick

    @property
    def radius(self):
        return math.sqrt(100 * self.mass)

    @property
    def boosting(self):
        return self.mx * self.mx + self.my * self.my > BOOST_THRESH2


class Food:
    __slots__ = ("id", "x", "y", "hue", "mass")

    def __init__(self, id, x, y, hue):
        self.id = id
        self.x = x
        self.y = y
        self.hue = hue
        self.mass = C.FOOD_MASS

    @property
    def radius(self):
        return math.sqrt(100 * self.mass)


class Virus:
    __slots__ = ("id", "x", "y", "mass", "mx", "my", "feed", "fx", "fy")

    def __init__(self, id, x, y):
        self.id = id
        self.x = x
        self.y = y
        self.mass = C.VIRUS_MASS
        self.mx = 0.0
        self.my = 0.0
        self.feed = 0
        self.fx = 0.0
        self.fy = 0.0

    @property
    def radius(self):
        return math.sqrt(100 * self.mass)

    @property
    def boosting(self):
        return self.mx * self.mx + self.my * self.my > BOOST_THRESH2


class EjectedMass:
    __slots__ = ("id", "x", "y", "hue", "mass", "mx", "my")

    def __init__(self, id, x, y, hue):
        self.id = id
        self.x = x
        self.y = y
        self.hue = hue
        self.mass = C.EJECT_MASS
        self.mx = 0.0
        self.my = 0.0

    @property
    def radius(self):
        return math.sqrt(100 * self.mass)

    @property
    def boosting(self):
        return self.mx * self.mx + self.my * self.my > BOOST_THRESH2
