interface Showable<T> {
    update(value: T): void;
    root: THREE.Object3D; // should be in [-1, 1]x[-1, 1] square
}
interface ShowableCtor<T> {
    new (value: T): Showable<T>;
}

interface StoredShowable {
    s: Showable<any>,
    ttl: number,
}

export let enabled = true;
let shown = new Map<string, StoredShowable>();
let scene = new THREE.Scene();
let aspect = window.innerWidth / window.innerHeight;
let size = 10;
let camera = new THREE.OrthographicCamera(-1 * aspect, 1 * aspect, 1, -1, 100, -100);

export function update(deltaTime: number) {
    if (!enabled) return;
    let pos = { x: -size, y: size - 1 };
    for (let [id, s] of shown) {
        s.ttl -= deltaTime;
        if (s.ttl < 0) {
            scene.remove(s.s.root);
            shown.delete(id);
        } else {
            pos.x += 1;
            if (pos.x >= size) {
                pos.x = -size;
                pos.y -= 1;
            }
            s.s.root.scale.setScalar(0.5 / size);
            s.s.root.position.set((pos.x + 0.5) / size, (pos.y + 0.5) / size, 0);
        }
    }
}
export function render(renderer: THREE.Renderer) {
    if (enabled) {
        renderer.render(scene, camera);
    }
}

function add<T>(id: string, ctor: ShowableCtor<T>, value: T, ttl: number) {
    if (!enabled) return;
    let current = shown.get(id);
    let makeNew = true;
    if (current != null) {
        if (current.s instanceof ctor) {
            makeNew = false;
            current.s.update(value);
            current.ttl = ttl;
        } else {
            scene.remove(current.s.root);
        }
    }
    if (makeNew) {
        let s = new ctor(value);
        shown.set(id, { s, ttl });
        scene.add(s.root);
    }
}

export class Angle implements Showable<number> {
    static MATERIAL = new THREE.LineBasicMaterial({ color: "red" });
    root: THREE.LineSegments;
    geometry: THREE.Geometry;
    constructor(public angle: number) {
        this.geometry = new THREE.Geometry();
        this.geometry.vertices.push(new THREE.Vector3(), new THREE.Vector3());
        this.root = new THREE.LineSegments(this.geometry, Angle.MATERIAL);
        this.update(angle);
    }
    update(angle: number) {
        this.angle = angle;
        this.geometry.vertices[1].set(Math.cos(angle), Math.sin(angle), 0);
        this.geometry.verticesNeedUpdate = true;
    }
}

export function angle(id: string, value: number, ttl: number = 1) {
    add(id, Angle, value, ttl);
}

interface AnglesData { color: THREE.Color, angle: number }

export class Angles implements Showable<AnglesData[]> {
    static MATERIAL = new THREE.LineBasicMaterial({ vertexColors: THREE.VertexColors });
    root: THREE.LineSegments;
    geometry: THREE.Geometry;
    constructor(public angles: AnglesData[]) {
        this.geometry = new THREE.Geometry();
        for (let i = 0; i < angles.length; i++) {
            this.geometry.vertices.push(new THREE.Vector3(), new THREE.Vector3());
            this.geometry.colors.push(new THREE.Color(), new THREE.Color());
        }
        this.root = new THREE.LineSegments(this.geometry, Angles.MATERIAL);
        this.update(angles);
    }
    update(angles: AnglesData[]) {
        this.angles = angles;
        let index = 0;
        for (let angle of angles) {
            this.geometry.vertices[index + 1].set(Math.cos(angle.angle), Math.sin(angle.angle), 0);
            this.geometry.colors[index + 0].copy(angle.color);
            this.geometry.colors[index + 1].copy(angle.color);
            index += 2;
        }
        this.geometry.verticesNeedUpdate = true;
        this.geometry.colorsNeedUpdate = true;
    }
}

export function angles(id: string, value: AnglesData[], ttl: number = 1) {
    add(id, Angles, value, ttl);
}