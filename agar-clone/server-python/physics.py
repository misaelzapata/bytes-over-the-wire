"""physics.py -- shared formulas (SPEC §2, §3, §7, §1.3).

Verbatim port of server/physics.js. Full-precision floats; the wire quantizes
only for transport (protocol.py). js_round mirrors JavaScript's Math.round
(round-half-toward-+infinity), which differs from Python's banker's rounding.
"""

import math
import constants as C


def js_round(v):
    # JS Math.round: floor(v + 0.5)  (round half up toward +infinity)
    return math.floor(v + 0.5)


def radius(mass):
    # radius = sqrt(100 * mass) = 10*sqrt(mass)
    return math.sqrt(100 * mass)


def mass_of(r):
    return (r * r) / 100.0


def speed(mass):
    # bigger => slower
    return C.SPEED_BASE * math.pow(mass, C.SPEED_EXP)


def recombine_ticks(mass):
    s = C.MERGE_BASE_S + C.MERGE_PER_MASS_S * mass
    return max(C.NO_MERGE_TICKS, js_round(s * C.TICK_HZ))


def view_scale(R):
    # classic zoom proxy: R = sum of own-cell radii.
    return math.pow(min(64 / R, 1), 0.4)


def view_half(R):
    vs = view_scale(R)
    return C.BASE_VIEW_H / 2 / vs + C.AOI_PAD


def clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)
