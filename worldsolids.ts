export function splitConvexGeometryPoints(geo: THREE.Geometry, plane: THREE.Plane): THREE.Vector3[][] {
    let leftPoints = new Set<THREE.Vector3>();
    let rightPoints = new Set<THREE.Vector3>();
    for (let face of geo.faces) {
        let [va, vb, vc] = [face.a, face.b, face.c].map(i => geo.vertices[i]);
        for (let point of [va, vb, vc]) {
            let d = plane.distanceToPoint(point);
            if (d < 0) {
                leftPoints.add(point);
            } else if (d > 0) {
                rightPoints.add(point);
            } else {
                leftPoints.add(point);
                rightPoints.add(point);
            }
        }
        let lines = [
            new THREE.Line3(va, vb),
            new THREE.Line3(va, vc),
            new THREE.Line3(vb, vc),
        ];
        for (let line of lines) {
            let intersectPoint = plane.intersectLine(line);
            if (intersectPoint != null) {
                leftPoints.add(intersectPoint);
                rightPoints.add(intersectPoint);
            }
        }
    }
    let results = [];
    if (leftPoints.size >= 4) {
        results.push(Array.from(leftPoints));
    }
    if (rightPoints.size >= 4) {
        results.push(Array.from(rightPoints));
    }
    return results;
}

export function splitConvexGeometry(geo: THREE.Geometry, plane: THREE.Plane): THREE.Geometry[] {
    return splitConvexGeometryPoints(geo, plane).map(ps => convexHull3D(ps)).filter(p => p != null) as THREE.Geometry[];
}

function removeExtreme<T>(arr: T[], f: (a: T, b: T) => boolean): T|null {
    let v = arr.pop();
    if (v == null) return null;
    for (let i = 0; i < arr.length; i++) {
        if (f(arr[i], v)) {
            [arr[i], v] = [v, arr[i]];
        }
    }
    return v;
}

export function convexHull3D(points: THREE.Vector3[]): THREE.Geometry|null {
    // http://thomasdiewald.com/blog/?p=1888

    points = points.slice(); // Shallow copy

    // Find and remove colinear points (O(N^3))
    //     Given colinear points A,B,C where B is between A and C on the line they share, then B may be removed without affecting the convex hull.
    // If the colinear points aren't removed then degenerate triangles might be produced; degenerate triangles affect raycasting because their normals will be nonsense.
    // With colinear points removed, degenerate triangles cannot be produced, since every point used in the output geometry is one of the input points
    // This also happens to remove duplicate points, but those wouldn't have made it to the result anyway because of an epsilon in distributePoints.
    {
        let numDeleted = 0;
        for (let i = 0; i < points.length; i++) {
            let a = points[i];
            if (a == null) continue; // Checks if the slot has been emptied
            for (let j = i + 1; j < points.length; j++) {
                let b = points[j];
                if (b == null) continue;
                let dir = b.clone().sub(a);
                let [min, max] = [0, dir.length()];
                dir.normalize();
                for (let k = 0; k < points.length; k++) {
                    let c = points[k];
                    if (c == null) continue;
                    if (c === a || c === b) continue;
                    let cline = c.clone().sub(a).dot(dir);
                    if (cline < min || cline > max) continue; // No epsilons needed here, probably, since each combination of line segment vs point is tested. We don't want an epsilon removing an outer point.
                    let cproj = a.clone().addScaledVector(dir, cline);
                    if (cproj.distanceToSquared(c) < 0.0001) {
                        delete points[k]; // Empty the slot (the point is "removed" immediately so that duplicate points don't mutually annihilate each other)
                        numDeleted += 1;
                    }
                }
            }
        }
        points = points.filter(() => true); // Filter out the the detected colinear points (ie. construct a new array without the empty slots)
        if (numDeleted > 0) {
            console.log("Removed " + numDeleted + " colinear points");
        }
    }

    // Create initial simplex
    let extremes = [
        removeExtreme(points, (a, b) => a.x < b.x),
        removeExtreme(points, (a, b) => a.x > b.x),
        removeExtreme(points, (a, b) => a.y < b.y),
        removeExtreme(points, (a, b) => a.y > b.y),
        removeExtreme(points, (a, b) => a.z < b.z),
        removeExtreme(points, (a, b) => a.z > b.z),
    ].filter(p => p != null) as THREE.Vector3[];
    // Find furthest apart extremes to make the base line
    let mostDistantI: THREE.Vector3|null = null, mostDistantJ: THREE.Vector3|null = null;
    {
        let maxDistanceSquared = 0;
        for (let i = 0; i < extremes.length; i++) {
            for (let j = i + 1; j < extremes.length; j++) {
                let d = extremes[i].distanceToSquared(extremes[j]);
                if (d >= maxDistanceSquared) {
                    mostDistantI = extremes[i];
                    mostDistantJ = extremes[j];
                    maxDistanceSquared = d;
                }
            }
        }
        // Remove the furthest apart so they aren't reused
        extremes = extremes.filter(v => v !== mostDistantI && v !== mostDistantJ);
    }
    if (mostDistantI == null || mostDistantJ == null) return null;
    // Find the extreme furthest from the base line
    let mostDistantLine: THREE.Vector3|null = null;
    {
        let maxDistanceSquared = 0;
        let line = mostDistantJ.clone().sub(mostDistantI).normalize();
        for (let point of extremes) {
            let d = point.clone().sub(mostDistantI).projectOnVector(line).add(mostDistantI).distanceToSquared(point);
            if (d >= maxDistanceSquared) {
                mostDistantLine = point;
                maxDistanceSquared = d;
            }
        }
        extremes = extremes.filter(v => v !== mostDistantLine);
    }
    if (mostDistantLine == null) return null;
    // Add the remaining extremes back to the points pool
    while (extremes.length > 0) points.push(extremes.pop() as THREE.Vector3);
    // Now find the furthest point from the triangle formed by the 3 extremes selected
    let finalPoint = points.pop();
    if (finalPoint == null) return null;
    {
        let maxDistance = 0;
        let triangleNormal = mostDistantJ.clone().sub(mostDistantI).normalize().cross(mostDistantLine.clone().sub(mostDistantI).normalize()).normalize();
        for (let i = 0; i < points.length; i++) {
            let point = points[i];
            let d = Math.abs(point.clone().sub(mostDistantI).dot(triangleNormal));
            if (d > maxDistance) {
                [points[i], finalPoint] = [finalPoint, points[i]];
                maxDistance = d;
            }
        }
    }

    // Now we have the vertices of the starting pyramid (mostDistantI, mostDistantJ, mostDistantLine, finalPoint) and the remaining points, points.
    interface Face {
        points: THREE.Vector3[], // Will have correct winding order
        normal: THREE.Vector3, // Will point out of the hull
        adjacent: Set<Face>,
        canSee: THREE.Vector3[],
    }
    function makeFaceWithInside(p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, inside: THREE.Vector3): Face {
        let b1 = p2.clone().sub(p1);
        let b2 = p3.clone().sub(p1);
        let normal = b1.clone().cross(b2).normalize();
        if (inside.clone().sub(p1).dot(normal) > 0) {
            normal.multiplyScalar(-1);
            [p1, p2, p3] = [p1, p3, p2];
        }
        return {
            points: [p1, p2, p3],
            normal: normal,
            adjacent: new Set(),
            canSee: [],
        };
    }
    let faceStack = [
        makeFaceWithInside(mostDistantI, mostDistantJ, mostDistantLine, finalPoint),
        makeFaceWithInside(mostDistantI, mostDistantJ, finalPoint, mostDistantLine),
        makeFaceWithInside(mostDistantI, mostDistantLine, finalPoint, mostDistantJ),
        makeFaceWithInside(mostDistantJ, mostDistantLine, finalPoint, mostDistantI),
    ];
    for (let face of faceStack) {
        for (let neighbor of faceStack) {
            if (face !== neighbor) {
                face.adjacent.add(neighbor);
            }
        }
    }
    // Assign points to faces
    function distributePoints(points: THREE.Vector3[], faces: Face[]) {
        for (let point of points) {
            let bestFace = null;
            let bestDistance = 0.001; // Starting with epsilon
            for (let face of faces) {
                let distance = point.clone().sub(face.points[0]).dot(face.normal);
                if (distance > bestDistance) {
                    bestDistance = distance;
                    bestFace = face; 
                }
            }
            if (bestFace != null) {
                bestFace.canSee.push(point);
            }
        }
    }
    distributePoints(points, faceStack);

    // Now whatever remains in points is discarded and faceStack has 4 starting faces
    let resultFaces = new Set(faceStack);
    // Faces that have no vertices assigned to them do not need to be processed
    faceStack = faceStack.filter(face => face.canSee.length > 0);
    while (faceStack.length > 0) {
        let face = faceStack.pop() as Face;
        if (!resultFaces.has(face)) continue; // this face was already removed
        if (face.canSee.length === 0) continue; // This face is done, and shouldn't have been added
        let maxDistance = 0;
        let maxPoint = face.canSee.pop() as THREE.Vector3;
        for (let i = 0; i < face.canSee.length; i++) {
            let point = face.canSee[i];
            let d = point.clone().sub(face.points[0]).dot(face.normal);
            if (d > maxDistance) {
                [face.canSee[i], maxPoint] = [maxPoint, face.canSee[i]];
                maxDistance = d;
            }
        }
        // maxPoint is the new point to add to the hull
        // find all faces that maxPoint can see
        let lightFaces = new Set<Face>();
        function addLightFaces(face: Face) {
            if (lightFaces.has(face)) return;
            if (maxPoint.clone().sub(face.points[0]).dot(face.normal) < 0.001) return;
            lightFaces.add(face);
            face.adjacent.forEach(f => addLightFaces(f));
        }
        addLightFaces(face);
        // collect the canSee from the lightFaces to redistribute to the new faces
        let toRedistribute: THREE.Vector3[] = [];
        lightFaces.forEach(f => f.canSee.forEach(p => toRedistribute.push(p)));
        let pointToNewFace = new Map<THREE.Vector3, Face>();
        let newFaces: Face[] = [];
        // Now construct the new faces
        for (let lightFace of lightFaces) {
            resultFaces.delete(lightFace);
            for (let neighbor of lightFace.adjacent) {
                if (!lightFaces.has(neighbor)) {
                    // The edge shared with the neighbor is a horizon edge, construct a new face between it and the maxPoint
                    let sharedPoints = lightFace.points.filter(p => neighbor.points.indexOf(p) !== -1);
                    if (sharedPoints.length !== 2) {
                        // Something's gone wrong
                        console.error("Sharing " + sharedPoints.length + " points");
                    }
                    let insidePoint = lightFace.points.find(p => sharedPoints.indexOf(p) === -1) as THREE.Vector3; // sharedPoints.length === 2, lightFace.points.length === 3, if all 3 points are separate objects this can not be undefined.
                    let newFace = makeFaceWithInside(maxPoint, sharedPoints[0], sharedPoints[1], insidePoint);

                    // Set up new adjacencies (each edge of the horizon will add 1 triangle, each point of each edge will be part of 2 new triangles)
                    neighbor.adjacent.delete(lightFace);
                    neighbor.adjacent.add(newFace);
                    newFace.adjacent.add(neighbor);
                    for (let sharedPoint of sharedPoints) {
                        if (pointToNewFace.has(sharedPoint)) {
                            let other = pointToNewFace.get(sharedPoint) as Face;
                            other.adjacent.add(newFace);
                            newFace.adjacent.add(other);
                        } else {
                            pointToNewFace.set(sharedPoint, newFace);
                        }
                    }
                    resultFaces.add(newFace);
                    newFaces.push(newFace);
                }
            }
        }
        // Now redistribute the points to the new faces
        distributePoints(toRedistribute, newFaces);
        // And finally push the new faces onto the stack
        for (let newFace of newFaces) {
            if (newFace.canSee.length > 0) {
                faceStack.push(newFace);
            }
        }
    }

    // Sanity check, make sure every vertex is behind every face
    for (let face of resultFaces) {
        for (let otherFace of resultFaces) {
            for (let point of otherFace.points) {
                if (point.clone().sub(face.points[0]).dot(face.normal) > 0.01) {
                    console.warn("Failed sanity check in convexHull3D: point", point, "in front of face", face);
                    let [a, b, c] = face.points;
                    console.warn("Offending face's area:", b.clone().sub(a).cross(c.clone().sub(a)).length() / 2);
                }
            }
        }
    }

    // Now resultFaces holds our triangle mesh
    function facesToGeometry(faces: Iterable<Face>) {
        let vertexIndex = new Map<THREE.Vector3, number>();
        let geo = new THREE.Geometry();
        for (let face of faces) {
            let vertexIndices = face.points.map(p => {
                if (vertexIndex.has(p)) {
                    return vertexIndex.get(p) as number;
                } else {
                    let index = geo.vertices.length;
                    geo.vertices.push(p);
                    vertexIndex.set(p, index);
                    return index;
                }
            });
            geo.faces.push(new THREE.Face3(vertexIndices[0], vertexIndices[1], vertexIndices[2]));
        }
        return geo;
    }
    return facesToGeometry(resultFaces);
}

function convexHull2D(points: THREE.Vector2[]): THREE.Vector2[] {
    // https://en.wikipedia.org/wiki/Gift_wrapping_algorithm
    function rot90(v: THREE.Vector2) {
        return new THREE.Vector2(-v.y, v.x);
    }

    points = points.slice();
    let leftmost = points.reduce((a, x) => x.x < a.x ? x : a);
    let outputOrder = [leftmost];
    let dbgIterCountdown = points.length;
    while (true) {
        let prev = outputOrder[outputOrder.length - 1];
        let next = null;
        let normish = null;
        for (let i = 0; i < points.length; i++) {
            if (points[i].distanceToSquared(prev) < 0.00001) continue;
            let dir = points[i].clone().sub(prev);
            if (next == null || dir.dot(normish as THREE.Vector2) > 0.001) {
                next = points[i];
                normish = rot90(dir).normalize();
            }
        }
        if (next == null) break; // wtf?
        if (next.distanceToSquared(outputOrder[0]) < 0.00001) break;
        if (dbgIterCountdown-- < 0) return [];
        outputOrder.push(next);
    }
    return outputOrder;
}

// TODO: this has a duplicate definition in fpm.ts, should move it into a common utility file
function* range(n: number): IterableIterator<number> {
    for (let i = 0; i < n; i++) {
        yield i;
    }
}
function* combinations<T>(ts: T[], n: number): IterableIterator<T[]> {
    if (ts.length < n) return;
    let indices = Array.from(range(n));
    while (true) {
        yield indices.map(i => ts[i]);
        let index = indices.length - 1;
        while (index >= 0) {
            indices[index] += 1;
            if (indices[index] < ts.length - (n - 1 - index)) break;
            index -= 1;
        }
        index += 1;
        if (index === 0) return;
        while (index < indices.length) {
            indices[index] = indices[index - 1] + 1;
            index += 1;
        }
    }
}

function threePlaneVertex(a: THREE.Plane, b: THREE.Plane, c: THREE.Plane): THREE.Vector3|null {
    // https://stackoverflow.com/questions/6408670/line-of-intersection-between-two-planes/18092154#18092154
    let det = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeBasis(a.normal, b.normal, c.normal)).determinant();
    if (det === 0) return null;
    return b.normal.clone().cross(c.normal).multiplyScalar(-a.constant)
        .add(c.normal.clone().cross(a.normal).multiplyScalar(-b.constant))
        .add(a.normal.clone().cross(b.normal).multiplyScalar(-c.constant))
        .divideScalar(det);
}

export function planesToVertices(planes: THREE.Plane[]): THREE.Vector3[] {
    let verts: THREE.Vector3[] = [];

    for (let [a, b, c] of combinations(planes, 3)) {
        let mv = threePlaneVertex(a, b, c);
        if (mv != null) {
            let v = mv;
            if (planes.every(plane => plane.distanceToPoint(v) > -0.001)) {
                verts.push(v);
            }
        }
    }

    return verts;
}