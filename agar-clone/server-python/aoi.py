"""aoi.py -- uniform spatial hash (AOI_CELL=1024) for broad-phase queries.

Port of server/aoi.js. queryCircle returns the referenced entities (the JS
version returned {x,y,ref} wrappers but every caller reads only .ref).
"""

import math
import constants as C


def _cell_key(cx, cy):
    return cx * 100000 + cy


class Grid:
    def __init__(self, cell=C.AOI_CELL):
        self.cell = cell
        self.map = {}  # key -> list of (x, y, ref)

    def clear(self):
        self.map.clear()

    def _cell_of(self, x, y):
        return (math.floor(x / self.cell), math.floor(y / self.cell))

    def insert(self, x, y, ref):
        cx, cy = self._cell_of(x, y)
        key = _cell_key(cx, cy)
        bucket = self.map.get(key)
        if bucket is None:
            bucket = []
            self.map[key] = bucket
        bucket.append(ref)

    def query_circle(self, x, y, radius):
        out = []
        minx, miny = self._cell_of(x - radius, y - radius)
        maxx, maxy = self._cell_of(x + radius, y + radius)
        m = self.map
        for cx in range(minx, maxx + 1):
            for cy in range(miny, maxy + 1):
                bucket = m.get(_cell_key(cx, cy))
                if bucket:
                    out.extend(bucket)
        return out
