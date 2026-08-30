/*
 * perfect-freehand — pressure-sensitive freehand stroke OUTLINE generator.
 * Algorithm: Steve Ruiz  (https://github.com/steveruizok/perfect-freehand), MIT.
 *
 * This is a self-contained, dependency-free UMD build that exposes the same
 * public API as the upstream package (getStroke / getStrokePoints /
 * getStrokeOutlinePoints). It is a faithful re-implementation of the upstream
 * algorithm authored for an offline environment (no CDN / npm at runtime), and
 * ships with the MIT license text in perfect-freehand.LICENSE alongside it.
 *
 * getStroke(points, options) -> Array<[x, y]>   (a closed fill outline)
 *   points : Array<[x,y] | [x,y,pressure] | {x,y,pressure?}>
 *   options: { size, thinning, smoothing, streamline, simulatePressure,
 *              easing, start:{taper,cap,easing}, end:{taper,cap,easing}, last }
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.PerfectFreehand = api;
    // Bare global for the plain-<script> client renderer.
    root.getStroke = api.getStroke;
    root.getStrokePoints = api.getStrokePoints;
    root.getStrokeOutlinePoints = api.getStrokeOutlinePoints;
  }
})(typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : this), function () {
  "use strict";

  // --- 2D vector helpers (all operate on [x, y] pairs) ----------------------
  function add(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s]; }
  function div(a, s) { return [a[0] / s, a[1] / s]; }
  function per(a) { return [a[1], -a[0]]; }         // perpendicular (rotate -90)
  function neg(a) { return [-a[0], -a[1]]; }
  function dpr(a, b) { return a[0] * b[0] + a[1] * b[1]; } // dot product
  function len(a) { return Math.hypot(a[0], a[1]); }
  function len2(a) { return a[0] * a[0] + a[1] * a[1]; }
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
  function dist2(a, b) { return len2(sub(a, b)); }
  function uni(a) { var l = len(a); return l ? div(a, l) : [0, 0]; }
  function isEqual(a, b) { return a[0] === b[0] && a[1] === b[1]; }
  function lrp(a, b, t) { return add(a, mul(sub(b, a), t)); }
  function med(a, b) { return mul(add(a, b), 0.5); }
  function prj(a, b, c) { return add(a, mul(b, c)); } // a + b*c
  function rotAround(A, C, r) {
    var s = Math.sin(r), c = Math.cos(r);
    var px = A[0] - C[0], py = A[1] - C[1];
    return [px * c - py * s + C[0], px * s + py * c + C[1]];
  }

  var FIXED_PI = Math.PI + 0.0001;

  function getStrokeRadius(size, thinning, pressure, easing) {
    easing = easing || function (t) { return t; };
    return size * easing(0.5 - thinning * (0.5 - pressure));
  }

  // --- getStrokePoints: normalize + streamline + running length + vectors ----
  function getStrokePoints(points, options) {
    options = options || {};
    var streamline = options.streamline == null ? 0.5 : options.streamline;
    var size = options.size == null ? 16 : options.size;
    var isComplete = !!options.last;

    if (!points || points.length === 0) return [];

    var pts;
    if (Array.isArray(points[0])) {
      pts = points.map(function (p) { return [p[0], p[1], p[2] == null ? 0.5 : p[2]]; });
    } else {
      pts = points.map(function (p) { return [p.x, p.y, p.pressure == null ? 0.5 : p.pressure]; });
    }

    if (pts.length === 2) {
      var last = pts[1];
      var seed = [pts[0][0], pts[0][1], pts[0][2]];
      pts = [seed];
      for (var k = 1; k < 5; k++) {
        var q = lrp([seed[0], seed[1]], [last[0], last[1]], k / 4);
        pts.push([q[0], q[1], last[2]]);
      }
    }
    if (pts.length === 1) {
      pts = [pts[0], [pts[0][0] + 1, pts[0][1] + 1, pts[0][2]]];
    }

    var strokePoints = [{
      point: [pts[0][0], pts[0][1]],
      pressure: pts[0][2] >= 0 ? pts[0][2] : 0.25,
      vector: [1, 1],
      distance: 0,
      runningLength: 0,
    }];
    var hasReachedMinimumLength = false;
    var runningLength = 0;
    var prev = strokePoints[0];
    var max = pts.length - 1;

    for (var i = 1; i < pts.length; i++) {
      var point = (isComplete && i === max)
        ? [pts[i][0], pts[i][1]]
        : lrp(prev.point, [pts[i][0], pts[i][1]], 1 - streamline);
      if (isEqual(prev.point, point)) continue;
      var distance = dist(point, prev.point);
      runningLength += distance;
      if (i < max && !hasReachedMinimumLength) {
        if (runningLength < size) continue;
        hasReachedMinimumLength = true;
      }
      prev = {
        point: point,
        pressure: pts[i][2] >= 0 ? pts[i][2] : 0.5,
        vector: uni(sub(prev.point, point)),
        distance: distance,
        runningLength: runningLength,
      };
      strokePoints.push(prev);
    }
    strokePoints[0].vector = (strokePoints[1] && strokePoints[1].vector) || [0, 0];
    return strokePoints;
  }

  // --- getStrokeOutlinePoints: offset ribbon + tapers + round caps -----------
  function getStrokeOutlinePoints(points, options) {
    options = options || {};
    var size = options.size == null ? 16 : options.size;
    var smoothing = options.smoothing == null ? 0.5 : options.smoothing;
    var thinning = options.thinning == null ? 0.5 : options.thinning;
    var simulatePressure = options.simulatePressure == null ? true : options.simulatePressure;
    var easing = options.easing || function (t) { return t; };
    var start = options.start || {};
    var end = options.end || {};
    var isComplete = !!options.last;

    var capStart = start.cap == null ? true : start.cap;
    var capEnd = end.cap == null ? true : end.cap;
    var taperStartEase = start.easing || function (t) { return t * (2 - t); };
    var taperEndEase = end.easing || function (t) { return --t * t * t + 1; };

    if (!points || points.length === 0) return [];

    var totalLength = points[points.length - 1].runningLength;
    var taperStart = start.taper === false ? 0
      : start.taper === true ? Math.max(size, totalLength)
      : (start.taper || 0);
    var taperEnd = end.taper === false ? 0
      : end.taper === true ? Math.max(size, totalLength)
      : (end.taper || 0);

    var minDistance = Math.pow(size * smoothing, 2);
    var leftPts = [];
    var rightPts = [];

    var prevPressure = points.slice(0, 10).reduce(function (acc, curr) {
      var pressure = curr.pressure;
      if (simulatePressure) {
        var sp = Math.min(1, curr.distance / size);
        var rp = Math.min(1, 1 - sp);
        pressure = Math.min(1, acc + (rp - acc) * (sp * 0.275));
      }
      return (acc + pressure) / 2;
    }, points[0].pressure);

    var radius = getStrokeRadius(size, thinning, points[points.length - 1].pressure, easing);
    var firstRadius;
    var prevVector = points[0].vector;
    var pl = points[0].point;
    var pr = points[0].point;
    var tl = pl;
    var tr = pr;
    var isPrevPointSharpCorner = false;

    for (var i = 0; i < points.length; i++) {
      var pressure = points[i].pressure;
      var point = points[i].point;
      var vector = points[i].vector;
      var distance = points[i].distance;
      var runningLength = points[i].runningLength;

      // Trim noise near the very end of the line.
      if (i < points.length - 1 && totalLength - runningLength < 3) continue;

      if (thinning) {
        if (simulatePressure) {
          var sp2 = Math.min(1, distance / size);
          var rp2 = Math.min(1, 1 - sp2);
          pressure = Math.min(1, prevPressure + (rp2 - prevPressure) * (sp2 * 0.275));
        }
        radius = getStrokeRadius(size, thinning, pressure, easing);
      } else {
        radius = size / 2;
      }
      if (firstRadius === undefined) firstRadius = radius;

      // tapers
      var ts = runningLength < taperStart ? taperStartEase(runningLength / taperStart) : 1;
      var te = (totalLength - runningLength) < taperEnd
        ? taperEndEase((totalLength - runningLength) / taperEnd) : 1;
      radius = Math.max(0.01, radius * Math.min(ts, te));

      var nextVector = (i < points.length - 1 ? points[i + 1] : points[i]).vector;
      var nextDpr = i < points.length - 1 ? dpr(vector, nextVector) : 1;
      var prevDpr = dpr(vector, prevVector);

      var isPointSharpCorner = prevDpr < 0 && !isPrevPointSharpCorner;
      var isNextPointSharpCorner = nextDpr != null && nextDpr < 0;

      if (isPointSharpCorner || isNextPointSharpCorner) {
        var offsetC = mul(per(prevVector), radius);
        for (var st = 1 / 13, t = 0; t <= 1; t += st) {
          tl = rotAround(sub(point, offsetC), point, FIXED_PI * t);
          leftPts.push(tl);
          tr = rotAround(add(point, offsetC), point, FIXED_PI * -t);
          rightPts.push(tr);
        }
        pl = tl;
        pr = tr;
        if (isNextPointSharpCorner) isPrevPointSharpCorner = true;
        continue;
      }
      isPrevPointSharpCorner = false;

      // regular point
      if (i === points.length - 1) {
        var offsetE = mul(per(vector), radius);
        leftPts.push(sub(point, offsetE));
        rightPts.push(add(point, offsetE));
        continue;
      }

      var offsetR = mul(per(lrp(nextVector, vector, nextDpr)), radius);
      tl = sub(point, offsetR);
      if (i <= 1 || dist2(pl, tl) > minDistance) { leftPts.push(tl); pl = tl; }
      tr = add(point, offsetR);
      if (i <= 1 || dist2(pr, tr) > minDistance) { rightPts.push(tr); pr = tr; }

      prevPressure = pressure;
      prevVector = vector;
    }

    var firstPoint = points[0].point.slice(0, 2);
    var lastPoint = points.length > 1
      ? points[points.length - 1].point.slice(0, 2)
      : add(points[0].point, [1, 1]);
    var startCap = [];
    var endCap = [];

    // Special case: a single dot.
    if (points.length === 1) {
      if (!(taperStart || taperEnd) || isComplete) {
        var s0 = prj(firstPoint, uni(per(sub(firstPoint, lastPoint))), -(firstRadius || radius));
        var dotPts = [];
        for (var sd = 1 / 13, td = sd; td <= 1; td += sd) {
          dotPts.push(rotAround(s0, firstPoint, FIXED_PI * 2 * td));
        }
        return dotPts;
      }
    } else {
      // start cap
      if (taperStart || (taperEnd && points.length === 1)) {
        // tapered start — no cap
      } else if (capStart) {
        for (var ss = 1 / 13, tsC = ss; tsC <= 1; tsC += ss) {
          startCap.push(rotAround(rightPts[0], firstPoint, FIXED_PI * tsC));
        }
      } else {
        var cs = sub(leftPts[0], rightPts[0]);
        var ca = mul(cs, 0.5);
        var cb = mul(cs, 0.51);
        startCap.push(sub(firstPoint, ca), sub(firstPoint, cb), add(firstPoint, cb), add(firstPoint, ca));
      }

      // end cap
      var mid = med(leftPts[leftPts.length - 1] || lastPoint, rightPts[rightPts.length - 1] || lastPoint);
      var direction = per(neg(points[points.length - 1].vector));
      if (taperEnd || (taperStart && points.length === 1)) {
        endCap.push(lastPoint);
      } else if (capEnd) {
        var se = prj(lastPoint, direction, radius);
        for (var sE = 1 / 29, tE = sE; tE < 1; tE += sE) {
          endCap.push(rotAround(se, lastPoint, FIXED_PI * 3 * tE));
        }
      } else {
        endCap.push(
          add(lastPoint, mul(direction, radius)),
          add(lastPoint, mul(direction, radius * 0.99)),
          sub(lastPoint, mul(direction, radius * 0.99)),
          sub(lastPoint, mul(direction, radius))
        );
      }
    }

    return leftPts.concat(endCap, rightPts.reverse(), startCap);
  }

  function getStroke(points, options) {
    return getStrokeOutlinePoints(getStrokePoints(points, options), options);
  }

  return {
    getStroke: getStroke,
    getStrokePoints: getStrokePoints,
    getStrokeOutlinePoints: getStrokeOutlinePoints,
  };
});
