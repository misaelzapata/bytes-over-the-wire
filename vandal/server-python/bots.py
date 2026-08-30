"""bots.py — painter bots that keep the mural alive (Python port).

Mirror of ../server/bots.js. Bots are cooperative co-creators: each forms a
PLAN (a short graffiti word or a simple figure) and TRACES it as connected
paths over a few seconds, streaming begin/append/end just like a human.

update() returns an ordered list of stream events the server relays + stores:
  {"type": "begin",  "ownerId", "name", "raw": {...}, "x", "y"}
  {"type": "append", "ownerId", "points": [{"x","y"}]}
  {"type": "end",    "ownerId"}
"""

import math
import random

import constants as C

TOOL_BRUSH = 0
TOOL_SPRAY = 5
FLAG_SOFT = 1


def rand(lo, hi):
    return lo + random.random() * (hi - lo)


def rand_int(lo, hi):
    return math.floor(rand(lo, hi + 1))


def pick(a):
    return a[rand_int(0, len(a) - 1)]


def clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


# Vivid, readable palette indices (skip the pale creams so art stays legible).
VIVID = [3, 4, 5, 7, 8, 9, 10, 11, 12, 13]
WORDS = ["HI", "YO", "OK", "ART", "SUN", "WOW", "HEY", "LOVE", "COOL", "PLAY",
         "STAR", "VIBE", "NICE"]
FIGURES = ["heart", "star", "sun", "house", "flower", "smiley", "bolt", "spiral"]

BOT_NAMES = [
    "Sable", "Ochre", "Marigold", "Sienna", "Clementine",
    "Poppy", "Hazel", "Saffron", "Coral", "Amber",
    "Rusty", "Juniper", "Cleo", "Bruno", "Pixel",
]


class BotManager:
    def __init__(self, alloc_id):
        self.alloc_id = alloc_id
        self.bots = []

    def spawn_all(self, n):
        for _ in range(n):
            self.spawn()

    def spawn(self):
        bid = self.alloc_id()
        bot = {
            "id": bid,
            "name": pick(BOT_NAMES),
            "cx": rand(0.15, 0.85) * C.CANVAS_W,
            "cy": rand(0.15, 0.85) * C.CANVAS_H,
            "color": pick(VIVID),
            "plan": None,
            "cooldown": rand_int(10, 70),
            "press": 0,
        }
        self.bots.append(bot)
        return bot

    @property
    def count(self):
        return len(self.bots)

    def cursors(self):
        return [{
            "id": b["id"],
            "x": b["cx"],
            "y": b["cy"],
            "pressing": b["press"] > 0,
            "color": b["color"],
            "name": b["name"],
        } for b in self.bots]

    def update(self):
        events = []
        for bot in self.bots:
            if bot["press"] > 0:
                bot["press"] -= 1

            if not bot["plan"]:
                bot["cooldown"] -= 1
                if bot["cooldown"] > 0:
                    # idle drift so the hovering cursor feels alive
                    bot["cx"] = clamp(bot["cx"] + rand(-6, 6), 20, C.CANVAS_W - 20)
                    bot["cy"] = clamp(bot["cy"] + rand(-6, 6), 20, C.CANVAS_H - 20)
                    continue
                bot["plan"] = self._make_plan(bot)
            self._advance(bot, events)
        return events

    # ---- plan: choose a subject, place + scale it, sample world paths ----
    def _make_plan(self, bot):
        want_word = random.random() < 0.5
        bot["color"] = pick(VIVID)
        spray = random.random() < 0.35
        meta = {
            "tool": TOOL_SPRAY if spray else TOOL_BRUSH,
            "color": bot["color"],
            "size": 2 if spray else rand_int(1, 2),
            "flags": 0 if spray else FLAG_SOFT,
        }

        if want_word:
            word = pick(WORDS)
            built = build_word(word)
            local_subs = built["subs"]
            em_w = built["w"]
            em_h = 1
        else:
            fig = pick(FIGURES)
            local_subs = FIGURE_BUILDERS[fig]()
            em_w = 1
            em_h = 1

        em = rand(180, 340)
        margin = 80
        max_w = C.CANVAS_W - margin * 2
        max_h = C.CANVAS_H - margin * 2
        if em_w * em > max_w:
            em = max_w / em_w
        if em_h * em > max_h:
            em = max_h / em_h
        world_w = em_w * em
        world_h = em_h * em
        ox = rand(margin, C.CANVAS_W - margin - world_w)
        oy = rand(margin, C.CANVAS_H - margin - world_h)

        step = max(10, em * 0.06)
        strokes = []
        for sub in local_subs:
            world = [{"x": ox + p["x"] * em, "y": oy + p["y"] * em} for p in sub]
            rs = resample(world, step)
            if len(rs) >= 1:
                strokes.append(rs)

        return {"meta": meta, "strokes": strokes, "si": 0, "pi": 0, "open": False}

    # ---- advance the trace by one tick ----------------------------------
    def _advance(self, bot, events):
        plan = bot["plan"]
        if plan["si"] >= len(plan["strokes"]):
            bot["plan"] = None
            bot["cooldown"] = rand_int(30, 110)
            return
        sub = plan["strokes"][plan["si"]]

        if not plan["open"]:
            p0 = sub[0]
            bot["cx"] = p0["x"]
            bot["cy"] = p0["y"]
            bot["press"] = 4
            plan["open"] = True
            plan["pi"] = 1
            events.append({"type": "begin", "ownerId": bot["id"], "name": bot["name"],
                           "raw": plan["meta"], "x": p0["x"], "y": p0["y"]})
            if len(sub) == 1:
                events.append({"type": "end", "ownerId": bot["id"]})
                plan["open"] = False
                plan["si"] += 1
            return

        BATCH = 3
        pts = []
        k = 0
        while k < BATCH and plan["pi"] < len(sub):
            pts.append(sub[plan["pi"]])
            plan["pi"] += 1
            k += 1
        if pts:
            last = pts[-1]
            bot["cx"] = last["x"]
            bot["cy"] = last["y"]
            bot["press"] = 4
            events.append({"type": "append", "ownerId": bot["id"], "points": pts})
        if plan["pi"] >= len(sub):
            events.append({"type": "end", "ownerId": bot["id"]})
            plan["open"] = False
            plan["si"] += 1


# ===========================================================================
# Geometry helpers
# ===========================================================================
def resample(pts, spacing):
    if len(pts) == 0:
        return []
    if len(pts) == 1:
        return [{"x": pts[0]["x"], "y": pts[0]["y"]}]
    out = [{"x": pts[0]["x"], "y": pts[0]["y"]}]
    px = pts[0]["x"]
    py = pts[0]["y"]
    for i in range(1, len(pts)):
        cx = pts[i]["x"]
        cy = pts[i]["y"]
        dx = cx - px
        dy = cy - py
        seg = math.hypot(dx, dy)
        if seg == 0:
            continue
        ux = dx / seg
        uy = dy / seg
        while seg >= spacing:
            px += ux * spacing
            py += uy * spacing
            out.append({"x": px, "y": py})
            dx = cx - px
            dy = cy - py
            seg = math.hypot(dx, dy)
        px = cx
        py = cy
    last = out[-1]
    if math.hypot(pts[-1]["x"] - last["x"], pts[-1]["y"] - last["y"]) > 1:
        out.append({"x": pts[-1]["x"], "y": pts[-1]["y"]})
    return out


def arc(cx, cy, r, a0, a1, n):
    out = []
    for i in range(n + 1):
        a = a0 + (a1 - a0) * (i / n)
        out.append({"x": cx + math.cos(a) * r, "y": cy + math.sin(a) * r})
    return out


def circle(cx, cy, r, n=28):
    return arc(cx, cy, r, 0, math.pi * 2, n)


# ===========================================================================
# Figures (unit cell 0..1 x, 0..1 y, y down) — each returns [subpath,...]
# ===========================================================================
def _fig_heart():
    pts = []
    for i in range(41):
        t = (i / 40) * math.pi * 2
        x = 16 * (math.sin(t) ** 3)
        y = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
        pts.append({"x": x, "y": -y})
    return [normalize(pts)]


def _fig_star():
    pts = []
    cx = 0.5
    cy = 0.5
    for i in range(11):
        a = -math.pi / 2 + (i * math.pi) / 5
        r = 0.5 if i % 2 == 0 else 0.21
        pts.append({"x": cx + math.cos(a) * r, "y": cy + math.sin(a) * r})
    return [pts]


def _fig_sun():
    subs = [circle(0.5, 0.5, 0.24, 26)]
    for i in range(8):
        a = (i / 8) * math.pi * 2
        subs.append([
            {"x": 0.5 + math.cos(a) * 0.32, "y": 0.5 + math.sin(a) * 0.32},
            {"x": 0.5 + math.cos(a) * 0.48, "y": 0.5 + math.sin(a) * 0.48},
        ])
    return subs


def _fig_house():
    return [
        [
            {"x": 0.14, "y": 1}, {"x": 0.14, "y": 0.46}, {"x": 0.86, "y": 0.46},
            {"x": 0.86, "y": 1}, {"x": 0.14, "y": 1},
        ],
        [
            {"x": 0.05, "y": 0.47}, {"x": 0.5, "y": 0.08}, {"x": 0.95, "y": 0.47},
        ],
        [
            {"x": 0.4, "y": 1}, {"x": 0.4, "y": 0.68}, {"x": 0.6, "y": 0.68},
            {"x": 0.6, "y": 1},
        ],
    ]


def _fig_flower():
    subs = []
    for i in range(5):
        a = -math.pi / 2 + (i / 5) * math.pi * 2
        px = 0.5 + math.cos(a) * 0.22
        py = 0.42 + math.sin(a) * 0.22
        subs.append(circle(px, py, 0.16, 18))
    subs.append(circle(0.5, 0.42, 0.09, 14))
    subs.append([{"x": 0.5, "y": 0.56}, {"x": 0.5, "y": 1}])
    subs.append([{"x": 0.5, "y": 0.8}, {"x": 0.74, "y": 0.72}])
    return subs


def _fig_smiley():
    return [
        circle(0.5, 0.5, 0.47, 30),
        [{"x": 0.34, "y": 0.36}, {"x": 0.34, "y": 0.46}],
        [{"x": 0.66, "y": 0.36}, {"x": 0.66, "y": 0.46}],
        arc(0.5, 0.52, 0.26, math.pi * 0.2, math.pi * 0.8, 14),
    ]


def _fig_bolt():
    return [
        [
            {"x": 0.62, "y": 0.02}, {"x": 0.24, "y": 0.5}, {"x": 0.5, "y": 0.5},
            {"x": 0.14, "y": 0.98},
        ],
    ]


def _fig_spiral():
    pts = []
    for i in range(61):
        t = (i / 60) * math.pi * 5
        r = 0.05 + (i / 60) * 0.45
        pts.append({"x": 0.5 + math.cos(t) * r, "y": 0.5 + math.sin(t) * r})
    return [pts]


FIGURE_BUILDERS = {
    "heart": _fig_heart,
    "star": _fig_star,
    "sun": _fig_sun,
    "house": _fig_house,
    "flower": _fig_flower,
    "smiley": _fig_smiley,
    "bolt": _fig_bolt,
    "spiral": _fig_spiral,
}


# Normalize an arbitrary point cloud into [0.05,0.95] x [0.05,0.95] keeping aspect.
def normalize(pts):
    min_x = math.inf
    min_y = math.inf
    max_x = -math.inf
    max_y = -math.inf
    for p in pts:
        if p["x"] < min_x:
            min_x = p["x"]
        if p["y"] < min_y:
            min_y = p["y"]
        if p["x"] > max_x:
            max_x = p["x"]
        if p["y"] > max_y:
            max_y = p["y"]
    w = (max_x - min_x) or 1
    h = (max_y - min_y) or 1
    s = 0.9 / max(w, h)
    off_x = 0.5 - ((min_x + max_x) / 2) * s
    off_y = 0.5 - ((min_y + max_y) / 2) * s
    return [{"x": p["x"] * s + off_x, "y": p["y"] * s + off_y} for p in pts]


# ===========================================================================
# Stroke font (capitals) — cell x in [0,0.6], y in [0,1]; advance 0.75 per char
# ===========================================================================
O_LOOP = [{"x": p["x"], "y": (p["y"] - 0.5) * (1 / 0.6) * 0.5 + 0.5}
          for p in circle(0.3, 0.5, 0.3, 24)]

GLYPHS = {
    "A": [[{"x": 0, "y": 1}, {"x": 0.3, "y": 0}, {"x": 0.6, "y": 1}],
          [{"x": 0.12, "y": 0.6}, {"x": 0.48, "y": 0.6}]],
    "B": [
        [{"x": 0, "y": 0}, {"x": 0, "y": 1}],
        [{"x": 0, "y": 0}, {"x": 0.42, "y": 0.12}, {"x": 0.42, "y": 0.38}, {"x": 0, "y": 0.5}],
        [{"x": 0, "y": 0.5}, {"x": 0.48, "y": 0.62}, {"x": 0.48, "y": 0.88}, {"x": 0, "y": 1}],
    ],
    "C": [[{"x": 0.56, "y": 0.18}, {"x": 0.3, "y": 0.02}, {"x": 0.08, "y": 0.22},
           {"x": 0.03, "y": 0.5}, {"x": 0.08, "y": 0.78}, {"x": 0.3, "y": 0.98},
           {"x": 0.56, "y": 0.82}]],
    "E": [[{"x": 0.55, "y": 0}, {"x": 0, "y": 0}, {"x": 0, "y": 1}, {"x": 0.55, "y": 1}],
          [{"x": 0, "y": 0.5}, {"x": 0.42, "y": 0.5}]],
    "H": [[{"x": 0, "y": 0}, {"x": 0, "y": 1}], [{"x": 0.55, "y": 0}, {"x": 0.55, "y": 1}],
          [{"x": 0, "y": 0.5}, {"x": 0.55, "y": 0.5}]],
    "I": [[{"x": 0.28, "y": 0}, {"x": 0.28, "y": 1}], [{"x": 0.08, "y": 0}, {"x": 0.48, "y": 0}],
          [{"x": 0.08, "y": 1}, {"x": 0.48, "y": 1}]],
    "K": [[{"x": 0, "y": 0}, {"x": 0, "y": 1}],
          [{"x": 0.5, "y": 0}, {"x": 0, "y": 0.55}, {"x": 0.52, "y": 1}]],
    "L": [[{"x": 0, "y": 0}, {"x": 0, "y": 1}, {"x": 0.5, "y": 1}]],
    "N": [[{"x": 0, "y": 1}, {"x": 0, "y": 0}, {"x": 0.55, "y": 1}, {"x": 0.55, "y": 0}]],
    "O": [O_LOOP],
    "P": [[{"x": 0, "y": 1}, {"x": 0, "y": 0}, {"x": 0.45, "y": 0.1}, {"x": 0.45, "y": 0.4},
           {"x": 0, "y": 0.5}]],
    "R": [
        [{"x": 0, "y": 1}, {"x": 0, "y": 0}, {"x": 0.45, "y": 0.1}, {"x": 0.45, "y": 0.4},
         {"x": 0, "y": 0.5}],
        [{"x": 0.12, "y": 0.5}, {"x": 0.54, "y": 1}],
    ],
    "S": [[{"x": 0.55, "y": 0.15}, {"x": 0.3, "y": 0.02}, {"x": 0.08, "y": 0.16},
           {"x": 0.1, "y": 0.4}, {"x": 0.5, "y": 0.58}, {"x": 0.5, "y": 0.85},
           {"x": 0.28, "y": 0.98}, {"x": 0.05, "y": 0.85}]],
    "T": [[{"x": 0, "y": 0}, {"x": 0.6, "y": 0}], [{"x": 0.3, "y": 0}, {"x": 0.3, "y": 1}]],
    "U": [[{"x": 0, "y": 0}, {"x": 0, "y": 0.72}, {"x": 0.16, "y": 0.96}, {"x": 0.44, "y": 0.96},
           {"x": 0.6, "y": 0.72}, {"x": 0.6, "y": 0}]],
    "V": [[{"x": 0, "y": 0}, {"x": 0.3, "y": 1}, {"x": 0.6, "y": 0}]],
    "W": [[{"x": 0, "y": 0}, {"x": 0.15, "y": 1}, {"x": 0.3, "y": 0.4}, {"x": 0.45, "y": 1},
           {"x": 0.6, "y": 0}]],
    "Y": [[{"x": 0, "y": 0}, {"x": 0.3, "y": 0.5}, {"x": 0.6, "y": 0}],
          [{"x": 0.3, "y": 0.5}, {"x": 0.3, "y": 1}]],
}


# Assemble a word into em-space subpaths (y in [0,1]); returns { subs, w }.
def build_word(word):
    advance = 0.75
    subs = []
    x = 0
    for ch in word:
        g = GLYPHS.get(ch)
        if g:
            for sub in g:
                subs.append([{"x": p["x"] + x, "y": p["y"]} for p in sub])
        x += advance
    w = max(0.6, x - (advance - 0.6))
    return {"subs": subs, "w": w}
