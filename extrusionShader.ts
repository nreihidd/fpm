export let extrusionMaterial = new THREE.ShaderMaterial({
    uniforms: {
        uExtrusion: { value: null }
    },
    vertexShader: `
        // attribute vec3 position;
        attribute vec3 normalA;
        attribute vec3 normalB;
        
        // uniform mat4 projectionMatrix;
        // uniform mat4 modelViewMatrix;

        uniform vec3 uExtrusion; // View-space extrusion

        #define MINIMUM_EXTRUSION 0.1
        #define EXTRUSION_DISTANCE_RATIO 0.1

        void main() {
            vec3 mvPos = (modelViewMatrix * vec4(position, 1.0)).xyz;
            vec3 viewNormalA = normalMatrix * normalA;
            vec3 viewNormalB = normalMatrix * normalB;
            if (dot(viewNormalA, uExtrusion) < 0.0 && dot(viewNormalB, uExtrusion) >= 0.0) {
                // Extrude based on distance to camera, due to high fill-rate usage shadow volumes are only being used for contact shadows
                float extrudeDistance = max(MINIMUM_EXTRUSION, -mvPos.z * EXTRUSION_DISTANCE_RATIO);
                mvPos -= uExtrusion * extrudeDistance;
            }
            gl_Position = projectionMatrix * vec4(mvPos, 1.0);
        }
    `,
    fragmentShader: `
        void main() {
            gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
        }
    `,
});

function vectorArrayToBuffer(arr: THREE.Vector3[]): Float32Array {
    let buffer = new Float32Array(arr.length * 3);
    let i = 0;
    for (let v of arr) {
        buffer[i++] = v.x;
        buffer[i++] = v.y;
        buffer[i++] = v.z;
    }
    return buffer;
}

export function generateExtrudableGeometry(geometry: THREE.Geometry): THREE.BufferGeometry {
    interface Vertex {
        position: THREE.Vector3;
        normalA: THREE.Vector3;
        normalB: THREE.Vector3;
    }

    let vertices: Vertex[] = [];
    let faces: THREE.Face3[] = [];

    let edgeToNormal = new Map<number, THREE.Vector3>();
    function edgeKey(vIndexA: number, vIndexB: number): number {
        if (vIndexB < vIndexA) {
            [vIndexB, vIndexA] = [vIndexA, vIndexB];
        }
        return vIndexA * geometry.vertices.length + vIndexB;
    }

    function addSilhouetteEdge(ia: number, ib: number, na: THREE.Vector3, nb: THREE.Vector3) {
        let [va, vb] = [ia, ib].map(i => geometry.vertices[i]);
        let index = vertices.length;
        vertices.push(
            { position: va, normalA: nb, normalB: na },
            { position: vb, normalA: nb, normalB: na },
            { position: va, normalA: na, normalB: nb },
            { position: vb, normalA: na, normalB: nb },
        );
        faces.push(
            new THREE.Face3(index, index + 1, index + 2),
            new THREE.Face3(index + 2, index + 1, index + 3),
        );
    }
    function addFace(ia: number, ib: number, ic: number, normal: THREE.Vector3) {
        let [va, vb, vc] = [ia, ib, ic].map(i => geometry.vertices[i]);
        let index = vertices.length;
        let na = normal;
        let nb = normal.clone().negate();
        vertices.push(
            { position: va, normalA: na, normalB: nb },
            { position: vb, normalA: na, normalB: nb },
            { position: vc, normalA: na, normalB: nb },
        );
        faces.push(
            new THREE.Face3(index, index + 1, index + 2),
        );
    }

    for (let face of geometry.faces) {
        let normal = face.normal;
        for (let [v1, v2] of [[face.a, face.b], [face.b, face.c], [face.c, face.a]]) {
            let key = edgeKey(v1, v2);
            let otherNormal = edgeToNormal.get(key);
            if (otherNormal == null) {
                edgeToNormal.set(key, normal);
            } else {
                addSilhouetteEdge(v1, v2, normal, otherNormal);
            }
        }
        addFace(face.a, face.b, face.c, normal);
    }

    let bufferGeo = new THREE.BufferGeometry();
    bufferGeo.addAttribute("position", new THREE.BufferAttribute(vectorArrayToBuffer(vertices.map(v => v.position)), 3));
    bufferGeo.addAttribute("normalA", new THREE.BufferAttribute(vectorArrayToBuffer(vertices.map(v => v.normalA)), 3));
    bufferGeo.addAttribute("normalB", new THREE.BufferAttribute(vectorArrayToBuffer(vertices.map(v => v.normalB)), 3));
    let index: number[] = [];
    for (let f of faces) { index.push(f.a, f.b, f.c); }
    bufferGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(index), 1));
    return bufferGeo;
}