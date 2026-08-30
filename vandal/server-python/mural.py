"""mural.py — the authoritative shared canvas state (Python port).

Mirror of ../server/mural.js. The server is a pixel-agnostic historian: it
never rasterizes anything. It keeps (a) an ordered list of completed STROKE
records so any new joiner can be handed the whole mural and undo can target a
stroke by id, and (b) a map of OPEN strokes still being streamed live (one per
owner). Rendering lives entirely on the clients.
"""

import math

import constants as C

SHAPE_TOOLS = {1, 2, 3}  # line / rect / circle need 2 points


def clamp_int(v, lo, hi):
    v = math.floor(v + 0.5)  # JS Math.round
    return lo if v < lo else (hi if v > hi else v)


class Mural:
    def __init__(self):
        self.strokes = []        # ordered oldest -> newest (completed)
        self.open = {}           # ownerId -> open stroke being streamed
        self.next_stroke_id = 1

    def _norm(self, raw):
        return {
            "tool": clamp_int(raw.get("tool") or 0, 0, C.TOOL_COUNT - 1),
            "color": clamp_int(raw.get("color") or 0, 0, C.PALETTE_COUNT - 1),
            "size": clamp_int(raw.get("size") or 0, 0, C.SIZE_COUNT - 1),
            "flags": (int(raw.get("flags") or 0)) & 0xFF,
        }

    def _push_capped(self, stroke):
        self.strokes.append(stroke)
        if len(self.strokes) > C.MAX_STROKES:
            del self.strokes[0:len(self.strokes) - C.MAX_STROKES]

    # ---- one-shot completed stroke (shapes + eraser) --------------------
    def commit_stroke(self, owner_id, raw):
        m = self._norm(raw)
        pts = raw.get("points") if isinstance(raw.get("points"), list) else []
        if len(pts) > C.MAX_POINTS:
            pts = pts[:C.MAX_POINTS]
        points = []
        for p in pts:
            points.append({"x": clamp_int(p["x"], 0, C.CANVAS_W),
                           "y": clamp_int(p["y"], 0, C.CANVAS_H)})
        if len(points) == 0:
            return None
        if m["tool"] in SHAPE_TOOLS and len(points) < 2:
            return None
        stroke = {"id": self.next_stroke_id, "ownerId": owner_id & 0xFFFFFFFF,
                  **m, "points": points}
        self.next_stroke_id += 1
        self._push_capped(stroke)
        return stroke

    # ---- streaming (brush + spray) --------------------------------------
    def begin(self, owner_id, raw, x, y):
        m = self._norm(raw)
        stroke = {"id": self.next_stroke_id, "ownerId": owner_id & 0xFFFFFFFF,
                  **m, "points": [{"x": clamp_int(x, 0, C.CANVAS_W),
                                   "y": clamp_int(y, 0, C.CANVAS_H)}]}
        self.next_stroke_id += 1
        self.open[owner_id] = stroke
        return stroke

    def append(self, owner_id, pts):
        open_stroke = self.open.get(owner_id)
        if not open_stroke:
            return [], False
        appended = []
        for p in pts:
            if len(open_stroke["points"]) >= C.MAX_POINTS:
                break
            q = {"x": clamp_int(p["x"], 0, C.CANVAS_W),
                 "y": clamp_int(p["y"], 0, C.CANVAS_H)}
            open_stroke["points"].append(q)
            appended.append(q)
        return appended, len(open_stroke["points"]) >= C.MAX_POINTS

    def is_open(self, owner_id):
        return owner_id in self.open

    def end(self, owner_id):
        open_stroke = self.open.get(owner_id)
        if not open_stroke:
            return None
        del self.open[owner_id]
        if len(open_stroke["points"]) == 0:
            return None
        self._push_capped(open_stroke)
        return open_stroke

    def undo_last(self, owner_id):
        for i in range(len(self.strokes) - 1, -1, -1):
            if self.strokes[i]["ownerId"] == owner_id:
                sid = self.strokes[i]["id"]
                del self.strokes[i]
                return sid
        return 0

    def remove_by_id(self, sid):
        for i in range(len(self.strokes) - 1, -1, -1):
            if self.strokes[i]["id"] == sid:
                del self.strokes[i]
                return True
        return False
