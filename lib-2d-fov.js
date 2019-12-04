var canvas = document.getElementById("canvas2d");
var ctx, scene;
var FoV = 1.98968;  // 72° field of vision in radians
var halfFoV = FoV / 2;
var halfFoVCos = Math.cos(halfFoV); // 0.809016994375
var halfFoVSin = Math.sin(halfFoV); // 0.587785252292
var visionRadius = 240;
var personRadius = 5;
var wallColour = "105, 105, 105";
var observerColour = "255, 128, 128";
//  var targetColour = "128, 128, 255";
//  var targetSeenColour = "255, 0, 255";
// 0.01 or even 0.05 doesn't work in this case: an angle point was found by an
// edge – sector arc intersection; later the ray formed due to this angle point
// hits the same (blocking) edge and the edge – ray intersection point obtained
// would be on the arc, but the squared distance between the sector centre and
// this point is slightly smaller than the sector radius.
// Test case: keep only the first two and the world boundary polygons, set
// sector.centre = (129, 316), rotate sector 360° and test for correctness.
// Test case: keep only the triangle and the world boundary polygons, set
// sector.centre = (120, 249), rotate sector 360° and test for correctness.
var epsilon = 0.075;
var halfAuxRayTilt = 8.72664625995e-3;               // half degree in radians
var halfAuxRayTiltCos = Math.cos(halfAuxRayTilt);    // 0.999961923064
var halfAuxRayTiltSin = Math.sin(halfAuxRayTilt);    // 8.72653549837e-3

// enable this for debug view
var debug = false;

function isZero(v) {
    return (Math.abs(v[0]) + Math.abs(v[1])) <= epsilon;
}

function cross2d(a, b) {
    return (a[0] * b[1]) - (a[1] * b[0]);
}

// direction is optional; defaults to counter-clockwise
function perp2d(v, clockwise) {
    clockwise = clockwise || false;
    if (clockwise)
        return vec2.fromValues(v[1], -v[0]);
    return vec2.fromValues(-v[1], v[0]);
}

function areParallel(a, b) {
    return (Math.abs(cross2d(a, b)) <= epsilon);
}

// line should have start point, vector and square length
function invLerp(line, point) {
    var t = vec2.create();
    vec2.sub(t, point, line.ends[0]);
    return vec2.dot(t, line.vec) / line.len_2;
}

function isPointOnLine(pt, line) {
    var v = vec2.create();
    vec2.sub(v, pt, line.ends[0]);
    return areParallel(v, line.vec);
}

function pointOnLine(line, t) {
    var pt = vec2.create();
    vec2.scaleAndAdd(pt, line.ends[0], line.vec, t);
    return pt;
}

// rotates dir based on cosA and sinA both counter-clockwise and clockwise
function rotateDir(dir, cosA, sinA) {
    // doing it manually instead of using mat2d as these can be reused for
    // rotation in both directions, avoiding their recalculation
    var xC = dir[0] * cosA;
    var yC = dir[1] * cosA;
    var xS = dir[0] * sinA;
    var yS = dir[1] * sinA;
    var rotDir = [vec2.fromValues(xC - yS, xS + yC),
    vec2.fromValues(xC + yS, -xS + yC)];
    return rotDir;
}

function setDirection(p, lookAt) {
    var newDir = vec2.create();
    vec2.sub(newDir, lookAt, p.loc);
    if (!isZero(newDir)) {
        vec2.normalize(newDir, newDir);
        p.dir = newDir;
    }
}

// returns square distance from pt to the closest point on line
// Refer §5.1.2, Mathematics for 3D Game Programming and Computer Graphics,
// Third Edition by Eric Lengyel
function pointSegShortestDistance(line, pt) {
    // computing s is nothing but invLerp; not using it since we need
    // our hands on the vector from the line start to pt, e1ToPt
    var e1ToPt = vec2.create();
    vec2.sub(e1ToPt, pt, line.ends[0]);
    var num = vec2.dot(e1ToPt, line.vec);
    var s = num / line.len_2;
    // if the scalar is going to scale the line vector beyond the
    // line segment's end points, then on of the end points is the
    // closest point; clamp the scalar to an end
    // http://doswa.com/2009/07/13/circle-segment-intersectioncollision.html
    s = (s <= 0) ? 0 : ((s >= 1) ? 1 : s);
    // the closest point = line.ends[0] + (s * line.vec), but we only need
    // the squared distance to closest point from pt and nothing more.
    // e1ToPt − (s * line.vec) would give the vector covering said distance
    // i.e. the perpendicular component of e1ToPt
    var perp = vec2.create();
    vec2.scale(perp, line.vec, s);
    vec2.sub(perp, e1ToPt, perp)
    return vec2.sqrLen(perp);
}

// this tests only for intersection and doesn't actually
// calculate the point of intersection
function lineSegCircleXsect(line, centre, radius_2) {
    // not using <= since tangents to circle don't really intersect the circle;
    // also such an edge wouldn't affect the field of vision (sector)
    return pointSegShortestDistance(line, centre) < radius_2;
}

var PointInSector = {
    FrontSemicircle: 0,   // point within sector-containing semicircle
    // but outside sector
    Behind: 1,   // point behind sector
    Outside: 2,   // point outside bounding circle
    Within: 4    // point contained within sector
};

function isPointInSector(pt, sector) {
    var v = vec2.create();
    vec2.sub(v, pt, sector.centre);
    var dot = vec2.dot(v, sector.midDir);
    if (dot <= 0)
        return PointInSector.Behind;

    // point in front and outside the circle
    if ((vec2.sqrLen(v) - sector.radius_2) > epsilon)
        return PointInSector.Outside;
    // a point on the bouding circle (not in or out) would be
    // classified based on its presence within the sector's angles
    // i.e. on the sector's arc is Within, elsewhere on the circle is 0
    // as in any point inside the front part of the circle minus sector

    /*
     * We now know that the point is neither behind nor outside the circle; we
     * need to check if it's within the sector i.e. if the vector from the
     * sector centre to pt is, by angle, within the edge vectors of the
     * sector. A method for testing if a point is on a circle's arc and not
     * elsewhere on the circle is presented by David Eberly (Intersection of
     * Linear and Circular Component in 2D; see references of lineSegArcXsect
     * for the link) but the below method is superior since the point neededn't
     * be on the circle's perimeter, it can be anywhere; also it has lesser
     * computatons involved.
     *
     * When a vector X lies, by angle, in between vectors A and B, the sign of
     * cross product of A and X and that of X and B would be the same. If it
     * isn't the signs would differ i.e. if X is beyond A or B, the signs will
     * differ. This method taps the anti-commutative nature of the cross
     * product; the order of the operands determine the sign of the result.
     */

    // point in front and within the sector
    // the check is negative since HTML5 canvas is a right-handed system with
    // the +Z axis going away from the viewer, into the screen. Hence crossing
    // in counter-clockwise from A to B would give a pseudovector that comes
    // out of the screen, towards the viewer, so reverse the check.
    if ((cross2d(sector.fovEdges[0].vec, v) <= 0) &&
        (cross2d(v, sector.fovEdges[1].vec) <= 0))
        return PointInSector.Within;

    // point in front and within the circle, but not the sector
    return PointInSector.FrontSemicircle;
}

// References:
// 1. Intersection of Linear and Circular Components in 2D by David Eberly
// 2. Numerically Stable Method for Solving Quadratic Equations
// http://www.geometrictools.com/Documentation/IntersectionLine2Circle2.pdf
// http://people.csail.mit.edu/bkph/articles/Quadratics.pdf
function lineSegArcXsect(line, sector) {
    var delta = vec2.create();
    vec2.sub(delta, line.ends[0], sector.centre);
    var b = vec2.dot(line.vec, delta);
    var d_2 = line.len_2;
    var c = vec2.sqrLen(delta) - sector.radius_2;
    var det = (b * b) - (d_2 * c);
    // only interested in a line cutting the circle at two points
    if (det > 0) {
        var det_sqrt = Math.sqrt(det);
        var t, t1, t2;
        if (b >= 0) {
            t = b + det_sqrt;
            t1 = -t / d_2;
            t2 = -c / t;
        }
        else {
            t = det_sqrt - b;
            t1 = c / t;
            t2 = t / d_2;
        }
        var p1, p2, p1InSector, p2InSector;
        var points = [];
        if ((t1 >= 0) && (t1 <= 1)) {
            p1 = pointOnLine(line, t1);
            p1InSector = isPointInSector(p1, sector);
            if (p1InSector === PointInSector.Within)
                points.push(p1);
        }
        if ((t2 >= 0) && (t2 <= 1)) {
            p2 = pointOnLine(line, t2);
            p2InSector = isPointInSector(p2, sector);
            if (p2InSector === PointInSector.Within)
                points.push(p2);
        }
        // line segment is contained within circle; it may be cutting
        // the sector, but not the arc, so return false, as there're
        // no angle points
        if (p1 === undefined && p2 === undefined)
            return;
        // both intersection points are behind, the edge has no way of cutting
        // the sector
        if ((p1InSector === PointInSector.Behind) &&
            (p2InSector === PointInSector.Behind))
            return { config: PointInSector.Behind };
        // don't return Behind when one of them is undefined and Behind, as one
        // of the endpoints may be in the front semicircle blocking vision

        // if any point was within, points should have atleast one element
        if (points.length)
            return { config: PointInSector.Within, points: points };
    }
    // line doesn't cut or is tangential
}

var LineSegConfig = {
    Disjoint: 0,
    Parallel: 1,
    Intersect: 2,
};

// from §16.16.1, Real-Time Rendering, 3rd Edition with Antonio's optimisation
function lineSegLineSegXsect(line1, line2, shouldComputePoint, isLine1Ray) {
    shouldComputePoint = shouldComputePoint || false;
    isLine1Ray = isLine1Ray || false;
    var result = { config: LineSegConfig.Disjoint };
    var l1p = perp2d(line1.vec);
    var f = vec2.dot(line2.vec, l1p);
    if (Math.abs(f) <= epsilon) {
        result.config = LineSegConfig.Parallel;
        /*
         * below check is needed if edges can exist on their own, without being
         * part of a polygon; if edges are always part of a polygon, when a ray
         * is shot to a blocking edge's end point (angle point) and if the edge
         * is parallel to the ray then this function's result will be ignored
         * by a caller that checks only for the intersecting case; however,
         * another edge of the polygon with the same angle point as one of its
         * end point would be deemed intersecting and the resulting point would
         * become the hit point. This wouldn't happen if edges can exist on
         * their own, independant of a polygon. With the below block, even for
         * such an independant, parallel edge, the result would contain a
         * parameter t and an intersection point that can be checked by the
         * caller.
         */

        // if line1 is a ray and an intersection point is needed, then filter
        // cases where line and ray are parallel, but the line isn't part of
        // ray e.g. ---> ____ should be filterd, but ---> ----- should not be.
        if (isLine1Ray && shouldComputePoint &&
            isPointOnLine(line2.ends[0], line1)) {
            // find the ray origin position w.r.t the line segment
            var alpha = invLerp(line2, line1.ends[0]);
            // ray is originating within the segment
            if ((alpha >= 0) && (alpha <= 1)) {
                result.t = 0;
                result.point = vec2.create();
                vec2.copy(result.point, line1.ends[0]);
            }
            // the ray can see the line i.e. ray origin before segment start
            else if (alpha < 0) {
                result.point = vec2.create();
                vec2.copy(result.point, line2.ends[0]);
                result.t = invLerp(line1, result.point);
            }
            // else alpha > 1, the segment is behind the ray
        }
    }
    else {
        var c = vec2.create();
        vec2.sub(c, line1.ends[0], line2.ends[0]);
        var e = vec2.dot(c, l1p);
        // t = e ÷ f, but computing t isn't necessary, just checking the values
        // of e and f we deduce if t ∈ [0, 1], if not the division and further
        // calculations are avoided: Antonio's optimisation.
        // f should never be zero here which means they're parallel
        if (((f > 0) && (e >= 0) && (e <= f)) ||
            ((f < 0) && (e <= 0) && (e >= f))) {
            var l2p = perp2d(line2.vec);
            var d = vec2.dot(c, l2p);
            // if line 1 is a ray, checks relevant to restricting s to 1
            // isn't needed, just check if it wouldn't become < 0
            if ((isLine1Ray && (((f > 0) && (d >= 0)) ||
                ((f < 0) && (d <= 0)))) ||
                (((f > 0) && (d >= 0) && (d <= f)) ||
                    ((f < 0) && (d <= 0) && (d >= f)))) {
                result.config = LineSegConfig.Intersect;
                if (shouldComputePoint) {
                    var s = d / f;
                    result.t = s;
                    result.point = pointOnLine(line1, s);
                }
            }
        }
    }
    return result;
}

/*
 * Auxiliary rays (primary ray rotated both counter-clockwise and clockwise by
 * an iota angle). These are needed for cases where a primary ray would get hit
 * an edge's vertex and get past it to hit things behind it too.
 *
 *   ALLOW PENETRATION             DISALLOW PENETRATION
 *
 *  ----------X                        \  polygon  /
 *  polygon  / \  <- ray                X---------X
 *          /   \                                  \  <- ray
 *                                                  \
 * References:
 * 1: http://ncase.me/sight-and-light
 * 2: http://www.redblobgames.com/articles/visibility
 */
function addAnglePointWithAux(point, prevEdge, nextEdge, sector, anglePoints) {
    var currentSize = anglePoints.size;
    anglePoints.add(point);
    // Add aux points only if the addition of the primary point was successful.
    // When a corner vertex of a polygon is added twice for edges A and B,
    // although the primary point would not be added since constructEdges would
    // have used the same vec2 object to make the end points of both edges,
    // this isn't case for the auxiliary points created in this function afresh
    // on each call. This check avoids redundant auxiliary point addition.
    if (currentSize != anglePoints.size) {
        var ray = vec2.create();
        vec2.sub(ray, point, sector.centre);
        var auxiliaries = rotateDir(ray, halfAuxRayTiltCos, halfAuxRayTiltSin);
        vec2.add(auxiliaries[0], sector.centre, auxiliaries[0]);
        vec2.add(auxiliaries[1], sector.centre, auxiliaries[1]);
        var projAxis = perp2d(ray);
        // special case polygons with a single edge i.e. an independant wall
        if ((nextEdge === undefined) || (nextEdge === prevEdge)) {
            // lineVec should originate from the added endpoint going to the
            // other end; if added point is second in edge, flip edge's vector
            var lineVec = (point === prevEdge.ends[0]) ? prevEdge.vec :
                vec2.fromValues(-prevEdge.vec[0], -prevEdge.vec[1]);
            var p = vec2.dot(lineVec, projAxis);
            // if lineVec is in −ve halfspace of projAxis, add the auxiliary
            // ray that would be in the +ve halfspace (i.e. the auxiliary ray
            // due to rotating ray counter-clockwise by iota) and vice-versa
            if (p <= 0)
                anglePoints.add(auxiliaries[0]);
            // use if instead of else if to deal with the case where ray and
            // edge are parallel, in which case both auxiliary rays are needed
            if (p >= 0)
                anglePoints.add(auxiliaries[1]);
        }
        else {
            // refer vision_beyond.html workout to understand in which
            // situation vision can extend beyond corners and auxiliary rays
            // are needed
            var p1 = vec2.dot(prevEdge.vec, projAxis);
            var p2 = vec2.dot(nextEdge.vec, projAxis);
            if ((p1 >= 0) && (p2 <= 0))
                anglePoints.add(auxiliaries[0]);
            else if ((p1 <= 0) && (p2 >= 0))
                anglePoints.add(auxiliaries[1]);
        }
    }
}

function checkPolygon(polygon, sector, anglePoints, blockingEdges) {
    var n = polygon.edges.length;
    var prevEdge = polygon.edges[n - 1];
    for (var i = 0; i < n; ++i) {
        var edge = polygon.edges[i];
        // if this edge intersects the sector's bounding circle do further
        // processing; this rejects any edge not within or cutting the circle.
        if (lineSegCircleXsect(edge, sector.centre, sector.radius_2)) {
            // deduce the relationship between the points and the sector
            var e1InSector = isPointInSector(edge.ends[0], sector);
            var e2InSector = isPointInSector(edge.ends[1], sector);
            // early exit if both points are behind, the edge formed cannot be
            // intersecting the sector
            if ((e1InSector === PointInSector.Behind) &&
                (e2InSector === PointInSector.Behind))
                continue;

            /*
             * Vision extends beyond an edge's endpoints (building corners);
             * see the comment above addAnglePointWithAux for an illustration.
             * When adding an angle point, if that point was obtained from an
             * intersection then just adding that point will do since the
             * observer will not be able to see beyond the edge, while if the
             * angle point is from an edge's endpoint, then additional
             * auxiliary angle points are to be added to cover the case where
             * the observer can see beyond the edge's end. Doing this at a
             * later stage would be difficult since data on whether the point
             * was from an edge end or an intersection is lost by then.
             */

            // both points are inside the sector, add both to anglePoints set
            // and add their edge to the blockingEdges list; don't process
            // further since the edge can't cut the sector's arc, no further
            // angle point due to this edge other than its endpoints
            if ((e1InSector === PointInSector.Within) &&
                (e2InSector === PointInSector.Within)) {
                addAnglePointWithAux(edge.ends[0],
                    prevEdge,
                    edge,
                    sector,
                    anglePoints);
                // for the last edge, send undefined as nextEdge to
                // addAnglePointWithAux; it should never get used since
                // both endpoints of the last edge would be handled by now
                // due to edges 0 and n − 2
                addAnglePointWithAux(edge.ends[1],
                    edge,
                    polygon.edges[i + 1],
                    sector,
                    anglePoints);
                blockingEdges.push(edge);
            }
            else {
                /*
                 * ANGLE POINTS
                 * Either one or both the points are outside the sector; add
                 * the one which is inside. Perform edge – arc intersection
                 * test, if this edge has a possibility of intersecting the
                 * arc, add resultant intersection point(s) to anglePoints.
                 *
                 * BLOCKING EDGE
                 * If one of the points is inside, then the edge is blocking,
                 * add it without any checks. If one or both are out, and the
                 * edge cuts the sector's arc then too the edge is blocking,
                 * add it to blockingEdges. If both are out and edge doesn't
                 * cut the arc, check if it cuts one of the sector's edges and
                 * add to blockingEdges if it does.
                 */
                var blocking = false;
                if (e1InSector === PointInSector.Within) {
                    addAnglePointWithAux(edge.ends[0],
                        prevEdge,
                        edge,
                        sector,
                        anglePoints);
                    blocking = true;
                }
                if (e2InSector === PointInSector.Within) {
                    addAnglePointWithAux(edge.ends[1],
                        edge,
                        polygon.edges[i + 1],
                        sector,
                        anglePoints);
                    blocking = true;
                }

                /*
                 * The edge has the possibility of intersecting the sector's
                 * arc only if one of its endpoints is outside the sector's
                 * bounding circle. If one of the points is within sector and
                 * the other is not outside then it cannot be intersecting the
                 * arc. Likewise, if both points are not within the sector,
                 * then both behind case is already pruned, both or one is in
                 * FrontSemicircle and other is behind then too it cannot, in
                 * anyway, be intersecting the arc.
                 */
                var edgeMayIntersectArc =
                    (e1InSector === PointInSector.Outside) ||
                    (e2InSector === PointInSector.Outside);

                var testSegSegXsect = true;
                if (edgeMayIntersectArc) {
                    // perform line segment – sector arc intersection test to
                    // check if there're more angle points i.e. if the edge
                    // intersects the sector's arc then the intersection points
                    // would also become angle points.
                    var arcXsectResult = lineSegArcXsect(edge, sector);
                    if (arcXsectResult) {
                        if (arcXsectResult.config === PointInSector.Within) {
                            // just add intersection point to Set without any
                            // auxiliarys as it's an intersection angle point
                            var len = arcXsectResult.points.length;
                            for (var j = 0; j < len; ++j)
                                anglePoints.add(arcXsectResult.points[j]);
                            blocking = true;
                        }
                        // edge – edge intersection test is not needed when the
                        // intersection point(s) are within or behind; the
                        // within case is ignored since it's already blocking
                        // and hence won't reach the lineSegLineSegXsect code
                        testSegSegXsect =
                            (arcXsectResult.config !== PointInSector.Behind);
                    }
                }

                // If there was an angle point added due to this edge, then it
                // is blocking; add and continue to avoid further processing.
                if (blocking)
                    blockingEdges.push(edge);

                /*
                 * If any angle point(s) would occur because of this edge, they
                 * would have been found by now and the edge would have been
                 * tagged as a blocking one. Even if no angle points were found
                 * due to this edge it still may be a blocking, or not. Perform
                 * a couple of segment – segment intersection tests with the
                 * sector's edges to check if the edge is indeed blocking. This
                 * is worth the expenditure incurred; say we have 10 angle
                 * points, for every redundant, non-blocking edge added without
                 * such a check means we waste time in performing 10 futile
                 * line segment intersection tests. Prune them early on by
                 * performing the tests beforehand.
                 *
                 * Perform segment – segment testing if testSegSegXsect is
                 * true; this will be so if the arc intersection was never
                 * performed (say when both points are in FrontSemicircle and
                 * their edge occluding vision) or if the intersection points
                 * aren't behind the sector; there can be cases where not both
                 * points are behind (if so they'd have gotten pruned by now),
                 * but the intersection points are behind, prune them.
                 */
                else if (testSegSegXsect &&
                    sector.fovEdges.some(function (sectorEdge) {
                        return LineSegConfig.Intersect ===
                            lineSegLineSegXsect(edge, sectorEdge).config;
                    }))
                    blockingEdges.push(edge);
            }
        }
        prevEdge = edge;
    }
}

/*
 * input: sorted array of vec2 points
 * Makes rays originating from sector centre to angle point without any
 * duplicate rays.
 *
 * If two points are in the same line of sight e.g. when the sector is at
 * (0, 0) and two angle points (1, 0), (2.5, 0), one of them can be removed;
 * in JS there is no built-in routine to remove duplicates, check the sorted
 * array for duplicates and remove them: http://stackoverflow.com/a/840808.
 */
function makeRays(sector, anglePoints) {
    // first ray needs no check for duplicity; calculate and add to array
    var ray = vec2.create();
    vec2.sub(ray, anglePoints[0], sector.centre);
    var rays = [ray];
    // i for anglePoints, j for rays to avoid doing anglePoints.length - 1
    for (var i = 1, j = 0, n = anglePoints.length; i < n; ++i) {
        ray = vec2.create();
        vec2.sub(ray, anglePoints[i], sector.centre);
        // check if the ray for this angle point is parallel to the previous
        if (!areParallel(ray, rays[j])) {
            rays.push(ray);
            ++j;
        }
    }
    return rays;
}

function updateSector(sector) {
    sector.centre = scene.observer.loc;
    sector.midDir = scene.observer.dir;
    var fovDirs = rotateDir(sector.midDir, halfFoVCos, halfFoVSin);
    // make sector edges
    vec2.scale(fovDirs[0], fovDirs[0], sector.radius);
    vec2.scale(fovDirs[1], fovDirs[1], sector.radius);
    var e0 = vec2.create();
    var e1 = vec2.create();
    vec2.add(e0, sector.centre, fovDirs[0]);
    vec2.add(e1, sector.centre, fovDirs[1]);
    var sectorEdges = sector.fovEdges;
    vec2.copy(sectorEdges[0].vec, fovDirs[0]);
    vec2.copy(sectorEdges[0].ends[0], sector.centre);
    vec2.copy(sectorEdges[0].ends[1], e0);
    vec2.copy(sectorEdges[1].vec, fovDirs[1]);
    vec2.copy(sectorEdges[1].ends[0], sector.centre);
    vec2.copy(sectorEdges[1].ends[1], e1);
}

// sorts the array of points radially in counter-clockwise direction
function sortAngularPoints(anglePoints, sector) {
    var aV = vec2.create();
    var bV = vec2.create();
    anglePoints.sort(function (a, b) {
        vec2.sub(aV, a, sector.centre);
        vec2.sub(bV, b, sector.centre);
        // sort expects a negative value when a should come before b; since
        // cross2d gives a negative value when the rotation from a to b is
        // counter-clockwise we use it as-is; see comment in isPointInSector
        return cross2d(aV, bV);
    });
}

// v1 should be a unit vector
function calcQuadBezCurveCtrlPoint(v1, v2, centre, radius) {
    var ctrlPt = vec2.create();
    // the control point would be on the unit bisector vector, r * (2 − cos ½θ)
    // units far; refer BezierArc/Quadratic workout for the calculation of a
    // quadratic Bézier curve control point that approximates a circle
    vec2.add(ctrlPt, v1, v2);
    vec2.normalize(ctrlPt, ctrlPt);    // unit bisector mid ray
    // the dot product between the mid ray and unitRay would give the cosine of
    // the half angle between v1 and v2
    vec2.scaleAndAdd(ctrlPt,
        centre,
        ctrlPt,
        radius * (2 - vec2.dot(v1, ctrlPt)));
    return ctrlPt;
}

function shootRays(rays, blockingEdges, sector) {
    var line1IsRay = true, shouldComputePoint = true;
    var n = rays.length;
    var hitPoints = new Array(n);
    var ctrlPoints = new Array(n);
    // rays is an array of vectors only, however the intersection functions
    // work on edges i.e. it also needs the end points and square length; hence
    // thisRay would act as the ray with additional edge data
    var thisRay = { ends: [sector.centre] }, unitRay = vec2.create();
    // unitRay, prevUnitRay, etc. are temporaries used later; create once, use
    // many, instead of recreating everytime
    var prevPointOnArc = false, prevUnitRay = vec2.create();
    var connector = vec2.create();
    var hitPoint;
    for (var i = 0; i < n; ++i) {
        // set edge data on thisRay specific to the ray currently shot
        thisRay.vec = rays[i];
        thisRay.len_2 = vec2.sqrLen(thisRay.vec);

        hitPoint = hitPoints[i] = vec2.create();
        // without the = undefined these variables would retain their values
        // beyond the current iteration, since JS has no block-scoped variables
        var t = undefined, blocker = undefined, hitDist_2 = undefined;
        for (var j = 0, len = blockingEdges.length; j < len; ++j) {
            var res = lineSegLineSegXsect(thisRay,
                blockingEdges[j],
                shouldComputePoint,
                line1IsRay);
            // both parallel and intersecting cases are valid for inspection;
            // both have the parameter and point defined
            if ((res.t !== undefined) && ((t === undefined) || (res.t < t))) {
                // This is needed when the observer is exactly at a polygon's
                // vertex, from where both worlds (outside and inside the
                // polygon/building) are visible as the observer is standing at
                // a pillar point where two walls meet. In such case, all rays
                // emanating from the centre would hit one of these edges with
                // t = 0 but this point should be discounted from calculations.
                // However, the value of t can vary depending on the length of
                // the ray, hence using the distance between the points as a
                // better measure of proximity
                hitDist_2 = vec2.sqrDist(res.point, sector.centre);
                if (hitDist_2 > epsilon) {
                    t = res.t;
                    vec2.copy(hitPoint, res.point);
                    blocker = blockingEdges[j];
                }
            }
        }
        /*
         * the ray could've hit
         *
         *    i. nothing (no blocking edge was in its way; t undefined)
         *   ii. blocking edge(s) of which the closest intersecting point is
         *       a. within the sector
         *       b. on the sector's arc
         *       c. beyond the sector's arc
         *
         * For (ii.c) t may be defined but the point would be beyond the
         * sector's radius. For everything except (ii.a), the hit point would
         * be on the arc and the unit vector along the ray would be needed to
         * draw the Bézier curve, if the next point is also going to be on the
         * arc. For cases (i) and (ii.c), a new hit point needs to be
         * calculated too, which can use the unit vector.
         *
         * One can avoid sqrt and call atan2 to get the angle directly which
         * would also help in drawing the actual arc (using ctx.arc) and not an
         * approximation of the arc using ctx.quadraticCurveTo. However, sqrt
         * is chosen over atan2 since it's usually faster:
         * http://stackoverflow.com/a/9318108.
         */
        var pointOnArc = (t === undefined) ||
            ((hitDist_2 + epsilon - sector.radius_2) >= 0);
        if (pointOnArc) {
            vec2.normalize(unitRay, thisRay.vec);
            // for cases (i), (ii.b) and (ii.c) set the hit point; this would
            // be redundant for case (ii.b) but checking for it would be
            // cumbersome, so just reassign
            vec2.scaleAndAdd(hitPoint, sector.centre, unitRay, sector.radius);
            if (prevPointOnArc) {
                var needsArc = true;
                /*
                 * the case where part of the arc is cut by a blocking edge
                 * needs to be handled differently:
                 *
                 *                     /---  +----------+
                 *                 /---    \-|          |
                 *             /---          X          |
                 *          /--              |\         |
                 *      /---                 | \        |
                 *     o                     |  |       |
                 *      ---\                 | /        |
                 *          --\              |/         |
                 *             ---\          X          |
                 *                 ---\    /-|          |
                 *                     ----  +----------+
                 *
                 * although both hit points would be on the arc, they shouldn't
                 * be connected by an arc since the blocking edge wouldn't
                 * allow vision beyond; hence check if this ray hit a blocking
                 * edge, if yes, then check if it's parallel to the edge formed
                 * by the connection between this and the previous hit points,
                 * if so don't make an arc.
                 */
                // the check i > 0 isn't needed since if that was the case the
                // variable prevPointOnArc would be false and the control
                // would've not reached here, so doing i - 1 is safe here
                if (blocker) {
                    vec2.sub(connector, hitPoints[i - 1], hitPoint);
                    needsArc = !areParallel(blocker.vec, connector);
                }
                if (needsArc)
                    ctrlPoints[i] = calcQuadBezCurveCtrlPoint(unitRay,
                        prevUnitRay,
                        sector.centre,
                        sector.radius);
            }
            vec2.copy(prevUnitRay, unitRay);
        }
        prevPointOnArc = pointOnArc;
    }
    return { hitPoints: hitPoints, ctrlPoints: ctrlPoints };
}

function isSubjectVisible(blockingEdges, sector) {
    if (isPointInSector(scene.target.loc, sector) == PointInSector.Within) {
        var ray = { vec: vec2.create(), ends: [sector.centre] };
        vec2.sub(ray.vec, scene.target.loc, sector.centre);
        return !blockingEdges.some(function (edge) {
            var res = lineSegLineSegXsect(ray,
                edge,
                true /* shouldComputePoint */);
            if (LineSegConfig.Intersect === res.config)
                return vec2.sqrDist(res.point, sector.centre) > epsilon;
        });
    }
    return false;
}

function update() {
    var sector = scene.observer.sector;
    updateSector(sector);

    var fov = scene.observer.fov;
    var anglePtSet = fov.anglePtSet;
    anglePtSet.clear();
    var blockingEdges = fov.blockingEdges;
    blockingEdges.length = 0;
    for (var i = 0, n = scene.polygons.length; i < n; ++i) {
        checkPolygon(scene.polygons[i], sector, anglePtSet, blockingEdges);
    }

    // Spread anglePtSet into an array for sorting. Sector edge end points are
    // also angle points; add them too to their rightful, sorted places so that
    // sorting them doesn't take much time; adding them post sorting needs the
    // points to be pushed and unshifted for the array to remain sorted; avoid
    // this as unshift may be costly. Even if these are collinear to existing
    // angle points, makeRays will remove duplicates from the sorted array.
    var anglePoints = [sector.fovEdges[0].ends[1],
    ...anglePtSet,
    sector.fovEdges[1].ends[1]];
    sortAngularPoints(anglePoints, sector);
    var rays = makeRays(sector, anglePoints);
    var result = shootRays(rays, blockingEdges, sector);
    fov.anglePoints = anglePoints;
    fov.rays = rays;
    fov.hitPoints = result.hitPoints;
    fov.ctrlPoints = result.ctrlPoints;
    //  scene.target.colour = isSubjectVisible(blockingEdges, sector) ?
    //                        targetSeenColour : targetColour;
}

function render() {
    // clear canvas
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, ctx.width, ctx.height);

    // draw polygons
    for (var i = 0, n = scene.polygons.length; i < n; ++i)
        drawPolygon(scene.polygons[i]);

    // draw personnel
    //  drawPerson(scene.target);
    drawPerson(scene.observer);
    //  drawPerson(scene.observer);   

    var fov = scene.observer.fov;
    var sector = scene.observer.sector;
    drawFoV(fov, sector);

    if (debug) {
        var radius = visionRadius;
        var dir = scene.observer.dir;
        var pos = scene.observer.loc;
        // calculate end points by rotating observer.dir
        var rotDir = rotateDir(dir, halfFoVCos, halfFoVSin);
        var e1 = vec2.create();
        vec2.scaleAndAdd(e1, pos, rotDir[0], radius);
        var e2 = vec2.create();
        vec2.scaleAndAdd(e2, pos, rotDir[1], radius);
        var cp = vec2.create();
        vec2.scaleAndAdd(cp, pos, dir, radius * (2 - halfFoVCos));
        // calculate line perpendicular to observer.dir
        var clockwise = true;
        var p1 = perp2d(dir, clockwise);
        var p2 = vec2.create();
        vec2.negate(p2, p1);
        vec2.scaleAndAdd(p1, pos, p1, radius);
        vec2.scaleAndAdd(p2, p1, p2, radius * 2);

        ctx.beginPath();
        // draw perpendicular
        ctx.moveTo(p1[0], p1[1]);
        ctx.lineTo(p2[0], p2[1]);
        // draw sector
        ctx.moveTo(pos[0], pos[1]);
        ctx.lineTo(e1[0], e1[1]);
        ctx.quadraticCurveTo(cp[0], cp[1], e2[0], e2[1]);
        ctx.closePath();
        ctx.stroke();

        // black angle points
        if (fov.anglePoints) {
            fov.anglePoints.forEach(function (p, _, set) {
                drawCircle(p[0], p[1], 3, "0, 0, 0");
            });
        }
        // black blocking edges
        for (var i = 0, n = fov.blockingEdges.length; i < n; ++i) {
            drawLine(fov.blockingEdges[i], 2, "0, 0, 0");
        }
        // gray rays
        var r = {
            ends: [vec2.fromValues(sector.centre[0], sector.centre[1]),
            vec2.create()]
        };
        for (var i = 0, n = fov.rays.length; i < n; ++i) {
            vec2.add(r.ends[1], r.ends[0], fov.rays[i]);
            drawLine(r, 0.25, "128, 128, 128");
        }
        // red hit points
        fov.hitPoints.forEach(function (p, _, set) {
            drawCircle(p[0], p[1], 3, "255, 0, 0");
        });
        // blue control points
        fov.ctrlPoints.forEach(function (p, _, set) {
            drawCircle(p[0], p[1], 3, "0, 0, 255");
        });
    }
}

function mainLoop() {
    update();
    render();
}

function init2DCanvas(canvas) {
    try {
        ctx = canvas.getContext("2d");
        ctx.width = canvas.width;
        ctx.height = canvas.height;
    }
    catch (e) {
        alert("Unable to initialize Canvas. Your browser may not support it.");
    }
}

function constructEdges(polygons) {
    for (var i = 0, n = polygons.length; i < n; ++i) {
        var p = polygons[i];
        var pointCount = p.coords.length / 2;
        var points = new Array(pointCount);
        for (var j = 0; j < pointCount; ++j) {
            var idx = j * 2;
            points[j] = vec2.fromValues(p.coords[idx], p.coords[idx + 1]);
        }
        // handle polygons with a single edge i.e. two points
        var edgeCount = (pointCount > 2) ? pointCount : (pointCount - 1);
        var edges = new Array(edgeCount);
        for (var j = 0; j < edgeCount; ++j) {
            var k = (j + 1) % pointCount;
            var v = vec2.create();
            vec2.sub(v, points[k], points[j]);
            edges[j] = {
                vec: v,
                len_2: vec2.sqrLen(v),
                ends: [points[j], points[k]]
            };
        }
        p.edges = edges;
    }
}

function start() {
    init2DCanvas(canvas);

    // global scene dictionary
    scene = {
        polygons: [
            {
                coords: [100, 100, 200, 100, 200, 200, 100, 200],
                colour: wallColour,
                stroke: 3,
                fill: true
            },
            {
                coords: [230, 50, 350, 70, 330, 140, 305, 90],
                colour: wallColour,
                stroke: 3,
                fill: true
            },
            {
                coords: [475, 56, 475, 360, 616, 360, 616, 56],
                colour: wallColour,
                stroke: 3,
                fill: true
            },
            {
                coords: [374, 300, 374, 450, 400, 400],
                colour: wallColour,
                stroke: 3,
                fill: true
            }],
        observer: {
            loc: vec2.fromValues(374, 203),
            dir: vec2.fromValues(-0.707106781186, 0.707106781186),
            colour: observerColour
        }

        //  target: { loc: vec2.fromValues(0, 0),
        //            dir: vec2.fromValues(-1, 0),
        //            colour: targetColour }
    };
    constructEdges(scene.polygons);

    var radius_2 = visionRadius * visionRadius;
    scene.observer.sector = {
        radius: visionRadius,
        radius_2: radius_2,
        fovEdges: [{
            vec: vec2.create(),
            ends: [vec2.create(),
            vec2.create()],
            len_2: radius_2
        },
        {
            vec: vec2.create(),
            ends: [vec2.create(),
            vec2.create()],
            len_2: radius_2
        }]
    };

    scene.observer.fov = {
        blockingEdges: [],
        anglePtSet: new Set(),
        anglePoints: []
    };

    canvas.addEventListener('click', handleClick, false);
    canvas.addEventListener('mousemove', handleMouseMove, false);

    window.requestAnimationFrame(mainLoop);
}

// http://stackoverflow.com/a/18053642
function getCursorPosition(event, element) {
    var rect = element.getBoundingClientRect();
    var x = event.clientX - rect.left;
    var y = event.clientY - rect.top;
    return vec2.fromValues(x, y);
}

function handleClick(e) {
    scene.observer.loc = getCursorPosition(e, canvas);
    window.requestAnimationFrame(mainLoop);
}

function handleMouseMove(e) {
    var lookAt = getCursorPosition(e, canvas);
    setDirection(scene.observer, lookAt);
    window.requestAnimationFrame(mainLoop);
}

function drawLine(line, thickness, colour) {
    var e0 = line.ends[0], e1 = line.ends[1];
    ctx.beginPath();
    ctx.moveTo(e0[0], e0[1]);
    ctx.lineTo(e1[0], e1[1]);
    ctx.lineWidth = thickness;
    ctx.strokeStyle = "rgb(" + colour + ")";
    ctx.stroke();
}

function drawPolygon(p) {
    ctx.beginPath();
    ctx.moveTo(p.coords[0], p.coords[1]);
    for (var i = 2, n = p.coords.length; i < n; i += 2)
        ctx.lineTo(p.coords[i], p.coords[i + 1]);
    ctx.closePath();
    if (p.fill) {
        ctx.fillStyle = "rgba(" + p.colour + ", 0.15)";
        ctx.fill();
    }
    if (p.stroke) {
        ctx.lineWidth = p.stroke;
        ctx.strokeStyle = "rgb(" + p.colour + ")";
        ctx.stroke();
    }
}

function drawCircle(x, y, radius, colour) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI);
    // without closePath the circle isn't completed properly
    ctx.closePath();
    ctx.fillStyle = "rgba(" + colour + ", 0.5)";
    ctx.fill();
    ctx.strokeStyle = "rgb(" + colour + ")";
    ctx.stroke();
}

function drawPerson(p) {
    drawCircle(p.loc[0], p.loc[1], personRadius, p.colour);
}

function drawFoV(fig, sector) {
    ctx.beginPath();
    ctx.moveTo(sector.centre[0], sector.centre[1]);
    for (var i = 0, len = fig.hitPoints.length; i < len; ++i) {
        var p = fig.hitPoints[i];
        var cp = fig.ctrlPoints[i];
        if (cp)
            ctx.quadraticCurveTo(cp[0], cp[1], p[0], p[1]);
        else
            ctx.lineTo(p[0], p[1]);
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(255, 140, 0, 0.35)";
    ctx.fill();
}

function toggleDebugView() {
    debug = !debug;
    window.requestAnimationFrame(mainLoop);
}

function addguard() {

}