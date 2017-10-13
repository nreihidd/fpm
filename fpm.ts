import * as worldsolids from "worldsolids";
import * as debug from "debug";
import * as cascade from "cascadedShadowMap";
import * as worldShader from "worldShader";
import * as ssaoShader from "ssaoShader";
import * as depthAwareBlur from "depthAwareBlur";
import * as extrusionShader from "extrusionShader";
import * as debugMenu from "debugMenu";

export let setEditor = debugMenu.setEditor;

let canvas = <HTMLCanvasElement>document.querySelector("#game");
canvas.focus();

function vec4(x: number, y: number, z: number, w: number): THREE.Vector4 {
    return new THREE.Vector4(x, y, z, w);
}
function vec3(x: number, y: number, z: number): THREE.Vector3 {
    return new THREE.Vector3(x, y, z);
}
function vec2(x: number, y: number): THREE.Vector2 {
    return new THREE.Vector2(x, y);
}
function randomColor(): THREE.Color {
    return new THREE.Color(Math.random() * (1 << 25));
}

const MAIN_LAYER = 0;
const MINIVIEW_LAYER = 1;

function xhrPromise(url: string, responseType: "text"): Promise<string>;
function xhrPromise(url: string, responseType: "json"): Promise<any>;
function xhrPromise(url: string, responseType: any): Promise<any> {
    return new Promise((resolve, reject) => {
        let xhr = new XMLHttpRequest();
        xhr.responseType = responseType;
        xhr.onload = () => {
            if (xhr.response != null) {
                resolve(xhr.response);
            } else {
                reject();
            }
        };
        xhr.onerror = () => reject();
        xhr.open("GET", url);
        xhr.send();
    });
}

export const cubeVertices = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
].map(([x, y, z]) => vec3(x, y, z));

let scene = new THREE.Scene();
function calcFovY(fovXInDegrees: number, aspect: number) {
    let fovXInRadians = fovXInDegrees * Math.PI / 180;
    // https://www.opengl.org/discussion_boards/showthread.php/159471-Horizontal-Vertical-angle-conversion
    // Easily solved for
    let fovYInRadians = 2 * Math.atan(Math.tan(fovXInRadians / 2) / aspect);
    return fovYInRadians * 180 / Math.PI;
}
export let camera = new THREE.PerspectiveCamera(calcFovY(90, canvas.width / canvas.height), canvas.width / canvas.height, 0.1, 10000);
export let renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    // antialias: true,
    // preserveDrawingBuffer: true,
});
renderer.autoClear = false;

// For post-processing, the non-hud scene is rendered first to this renderTarget
let depthTexture = new THREE.DepthTexture(128, 128);
depthTexture.minFilter = THREE.LinearFilter;
depthTexture.magFilter = THREE.LinearFilter;
function makeRenderTarget(size: {width: number, height: number}, stencilBuffer = false) {
    // https://github.com/mrdoob/three.js/blob/dev/examples/js/postprocessing/EffectComposer.js
    return new THREE.WebGLRenderTarget(size.width, size.height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        // stencilBuffer: stencilBuffer,
    });
}
export let depthTarget = makeRenderTarget(renderer.getSize(), true);
depthTarget.depthTexture = depthTexture;
let intermediateTarget1 = makeRenderTarget(renderer.getSize());
let intermediateTarget2 = makeRenderTarget(renderer.getSize());

export let cascadedShadowMaps = [
    new cascade.ShadowMap(
        new THREE.OrthographicCamera(-5, 5, 5, -5, -1000, 1000),
        1024, 1024,
        0.00001
    ),
    new cascade.ShadowMap(
        new THREE.OrthographicCamera(-20, 20, 20, -20, -1000, 1000),
        1024, 1024,
        0.0001
    ),
    new cascade.ShadowMap(
        new THREE.OrthographicCamera(-100, 100, 100, -100, -1000, 1000),
        1024, 1024,
        0.001
    ),
    new cascade.ShadowMap(
        new THREE.OrthographicCamera(-1000, 1000, 1000, -1000, -1000, 1000),
        1024, 1024,
        0.01
    ),
];

export function dbgToggleAO() {
    if ("AO_DISABLED" in worldMaterial.defines) {
        delete worldMaterial.defines.AO_DISABLED;
    } else {
        worldMaterial.defines.AO_DISABLED = "true";
    }
    (worldMaterial as any)._needsUpdate = true
}

export let baseMaterial = new THREE.ShaderMaterial(<any>{
    extensions: { derivatives: true },
    uniforms: {
        roughness: {value:0.5},
        metalness: {value:0.5},
        diffuse: {value:new THREE.Vector3(1.0, 1.0, 1.0)},

        ambientLightColor: {value: null},
        directionalLights: {value: null},
        spotLights: {value: null},
        rectAreaLights: {value: null},
        pointLights: {value: null},
        hemisphereLights: {value: null},

        directionalShadowMap: {value: null},
        directionalShadowMatrix: {value: null},
        spotShadowMap: {value: null},
        spotShadowMatrix: {value: null},
        pointShadowMap: {value: null},
        pointShadowMatrix: {value: null},

        uSSAOTexture: {value: null},
        uStencilShadowTexture: {value: null},
        depthMap: {value: null},
        viewportOffset: {value: null},
        size: {value: null},

        shadowCascadeMatrix: { value: null },
        shadowCascadeMatrixInv: { value: null },
        shadowCascadeMap: { value: null },
        shadowCascadeSize: { value: null },
        shadowCascadeBias: { value: null },
    },
    vertexShader: worldShader.worldVertexShader,
    fragmentShader: worldShader.worldFragmentShader,
    lights: true,
    defines: { "STANDARD": "true", "NUM_SHADOW_CASCADES": cascadedShadowMaps.length },
});

let isExtendedMaterial = new WeakSet();
isExtendedMaterial.add(baseMaterial);
function cloneBaseMaterial(): THREE.ShaderMaterial {
    let cloned = baseMaterial.clone();
    isExtendedMaterial.add(cloned);
    return cloned;
}
function makeExtendedMaterial(color: number, roughness: number = 0.5, metalness: number = 0.5): THREE.ShaderMaterial {
    let m = cloneBaseMaterial();
    m.uniforms.diffuse.value = new THREE.Color(color);
    m.uniforms.roughness.value = roughness;
    m.uniforms.metalness.value = metalness;
    return m;
}

function loadImage(path: string): HTMLImageElement {
    let image = new Image();
    image.src = path;
    return image;
}

let gameTime = 0;
export let resolutionScale = 1.0;

function updateRendererSize() {
    let w = Math.floor(window.innerWidth * resolutionScale);
    let h = Math.floor(window.innerHeight * resolutionScale);

    // Uncomment this line to use the full resolution of a phone screen instead of scaling the canvas
    // renderer.setPixelRatio(window.devicePixelRatio);

    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = calcFovY(90, camera.aspect);
    camera.updateProjectionMatrix();

    depthTarget.setSize(w, h);
    // depthRenderTarget.setSize(w, h);
    depthTexture = new THREE.DepthTexture(w, h);
    depthTexture.minFilter = THREE.LinearFilter;
    depthTexture.magFilter = THREE.LinearFilter;
    depthTexture.format = THREE.DepthStencilFormat;
    depthTexture.type = THREE.UnsignedInt248Type as any;
    depthTarget.depthTexture = depthTexture;

    intermediateTarget1.setSize(w, h);
    intermediateTarget2.setSize(w, h);
}
updateRendererSize();
window.onresize = updateRendererSize;

export let skyTime = 0.3;
debugMenu.defineOverrideEditor(exports, "skyTime", debugMenu.clampedEditor(0, 1));
export var dirLight = new THREE.DirectionalLight(0xffffff, 3.0);
export let dirLightDir = vec3(0, -0.5, 1).normalize();
dirLight.position.copy(dirLightDir);
dirLight.layers.enable(MINIVIEW_LAYER);
scene.add(dirLight);

let sunMesh = new THREE.Mesh(new THREE.SphereGeometry(1.0, 32, 32), new THREE.MeshBasicMaterial({color: "white", depthWrite: false }));
sunMesh.renderOrder = -10;
scene.add(sunMesh);

let ambientLight = new THREE.AmbientLight(0xffffff, 1.5);
ambientLight.layers.enable(MINIVIEW_LAYER);
scene.add(ambientLight);

let playerLight = new THREE.PointLight(0xffcc99, 5.0, 100, 2);
playerLight.layers.enable(MINIVIEW_LAYER);
playerLight.visible = false;
scene.add(playerLight);

let worldAxis = new THREE.AxisHelper(1);
worldAxis.position.z = 2;
scene.add(worldAxis);

camera.position.z = 2.2;
camera.up = new THREE.Vector3(0, 0, 1);
camera.position.y = -10;
camera.lookAt(new THREE.Vector3());

let audioListener = new THREE.AudioListener();
audioListener.up = vec3(0, 0, 1);
camera.add(audioListener);
let audioLoader = new THREE.AudioLoader();

let activeSounds: THREE.Audio[] = [];
let soundEnabled = false;
if (window.location.protocol === "file:" && window.navigator.userAgent.indexOf("Chrome") !== -1) {
    soundEnabled = false;
}

let audioCache = new Map<string, Promise<any>>();
function getSound(soundURL: string): Promise<any> {
    let promise = audioCache.get(soundURL);
    if (promise == null) {
        promise = new Promise((resolve, reject) => {
            audioLoader.load(soundURL, (buffer: any) => resolve(buffer), undefined as any, () => reject());
        });
        audioCache.set(soundURL, promise);
    }
    return promise;
}

function playSound(soundURL: string): THREE.PositionalAudio {
    let sound = new THREE.PositionalAudio(audioListener);
    if (soundEnabled) {
        getSound(soundURL).then(buffer => {
            sound.setBuffer(buffer);
            sound.setRefDistance(20);
            sound.play();
        });
    }
    activeSounds.push(sound);
    return sound;
}
function placeSoundAbsolute(sound: THREE.PositionalAudio, position: THREE.Vector3) {
    scene.add(sound);
    sound.position.copy(position);
}

export let widdershins = false;
let toolRoll = 0;
window.addEventListener("wheel", evt => {
    evt.stopPropagation();
    evt.preventDefault();
    let rotateAmount = (widdershins ? -1 : 1) * (evt.deltaY < 0 ? -1 : 1);
    let rotateFactor = Math.PI * 2 / 40;
    if (activeTool === weaponTool) {
        rotateFactor *= 2;
    }
    if (heldKeys.has(VK.LSHIFT) && activeTool !== weaponTool) {
        rotateFactor /= 10;
    }
    let newRoll = toolRoll + rotateAmount * rotateFactor;
    let snappedRoll = Math.round(newRoll / rotateFactor) * rotateFactor;
    toolRoll = snappedRoll;
});

var hFacing = Math.PI / 2;
var vFacing = 0;
function rotateView(angleH: number, angleV: number) {
    hFacing += angleH;
    vFacing += angleV;
    vFacing = clamp(vFacing, -Math.PI / 2, Math.PI / 2);
}
rotateView(0, 0);

function geometryPlaneIntersections(geo: THREE.Geometry, plane: THREE.Plane): THREE.Vector3[] {
    let intersectPoints: THREE.Vector3[] = [];
    for (let face of geo.faces) {
        let [va, vb, vc] = [face.a, face.b, face.c].map(i => geo.vertices[i]);
        let lines = [
            new THREE.Line3(va, vb),
            new THREE.Line3(va, vc),
            new THREE.Line3(vb, vc),
        ];
        for (let line of lines) {
            let intersectPoint = plane.intersectLine(line);
            if (intersectPoint != null) {
                intersectPoints.push(intersectPoint);
            }
        }
    }
    return intersectPoints;
}
function convexPolygonPointOrder(points: THREE.Vector2[]): THREE.Vector2[] {
    // https://www.gamedev.net/topic/623564-intersection-of-two-convex-polyhedrons/
    let average = points.reduce((acc, x) => acc.add(x), vec2(0, 0)).divideScalar(points.length);
    let angles = points.map(p => [Math.atan2(p.y - average.y, p.x - average.x), p]) as [number, THREE.Vector2][];
    return angles.slice().sort(([a, _pa], [b, _pb]) => a - b).map(([_, p]) => p);
}
function polygonArea(points: THREE.Vector2[]): number {
    // https://en.wikipedia.org/wiki/Centroid
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
        let a = points[i];
        let b = points[(i + 1) % points.length];
        sum += a.x * b.y - b.x * a.y;
    }
    return sum / 2;
}
function polygonCentroid(points: THREE.Vector2[]): THREE.Vector2 {
    // https://en.wikipedia.org/wiki/Centroid
    let centroid = vec2(0, 0);
    for (let i = 0; i < points.length; i++) {
        let a = points[i];
        let b = points[(i + 1) % points.length];
        let c = (a.x * b.y - b.x * a.y);
        centroid.add(a.clone().add(b).multiplyScalar(c));
    }
    return centroid.divideScalar(6 * polygonArea(points));
}

let drawSolidCaps: () => void;
{
    let dbgCapGeo = new THREE.Geometry();
    for (let i = 0; i < 100; i++) dbgCapGeo.vertices.push(vec3(0, 0, 0));
    for (let i = 0; i < 98; i++) dbgCapGeo.faces.push(new THREE.Face3(0, i + 1, i + 2, vec3(0, 0, 1)));
    let dbgCapMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
    let dbgCapMesh = new THREE.Mesh(dbgCapGeo, dbgCapMaterial);
    dbgCapMaterial.side = THREE.DoubleSide;
    let dbgCapScene = new THREE.Scene();
    dbgCapScene.add(dbgCapMesh);
    let dbgCapCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    dbgCapScene.add(dbgCapCamera);
    drawSolidCaps = function() {
        camera.updateMatrixWorld(false);
        // http://stackoverflow.com/questions/12018710/calculate-near-far-plane-vertices-using-three-frustum/12022005
        let hNear = 2 * Math.tan(camera.fov * Math.PI / 180 / 2) * camera.near; // height
        let wNear = hNear * camera.aspect; // width
        let verts = [
            vec3(-wNear / 2, -hNear / 2, -camera.near),
            vec3(-wNear / 2,  hNear / 2, -camera.near),
            vec3( wNear / 2, -hNear / 2, -camera.near),
            vec3( wNear / 2,  hNear / 2, -camera.near),
        ].map(v => v.applyMatrix4(camera.matrixWorld));
        let screenY = verts[3].clone().sub(verts[2]).normalize();
        let screenX = verts[2].clone().sub(verts[0]).normalize();
        let normal = camera.getWorldDirection();
        let plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, verts[0]);
        let center = verts[0].clone().lerp(verts[3], 0.5);
        let boundingSphere = new THREE.Sphere(center, verts[0].distanceTo(center));
        if (justPressedKeys.has(VK.Z)) {
            let geo = new THREE.Geometry();
            geo.vertices.push(verts[0], verts[1], verts[2], verts[3]);
            geo.faces.push(new THREE.Face3(0, 1, 2), new THREE.Face3(1, 2, 3));
            let mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xff00ff, side: THREE.DoubleSide }));
            //mesh.position.copy(boundingSphere.center); 
            scene.add(mesh);
        }
        // Modification of ConvexPolyhedron.overlaps
        function overlapsPlane(shape: ConvexPolyhedron) {
            const EPSILON = 0.001; // Err on the side of no contact
            let separatedByAxis = (axis: THREE.Vector3) => {
                let [minA, maxA] = verticesSpan(shape.vertices, axis);
                let [minB, maxB] = verticesSpan(verts, axis);
                return maxA <= minB + EPSILON || maxB <= minA + EPSILON;
            };

            for (let axis of shape.axes) {
                if (separatedByAxis(axis)) return false;
            }
            for (let axis of [normal]) {
                if (separatedByAxis(axis)) return false;
            }

            for (let edgeA of shape.edges) {
                for (let edgeB of [screenX, screenY]) {
                    let norm = vec3(0, 0, 0).crossVectors(edgeA, edgeB);
                    if (norm.lengthSq() < 0.0001) {
                        // Edges parallel, ignore
                    } else {
                        if (separatedByAxis(norm)) return false;
                    }
                }
            }

            return true;
        }
        let dbgFoundCap = false;
        for (let solid of world.solids.get(new THREE.Box3().setFromPoints(verts).expandByScalar(0.1), [])) {
            let shape = solid.shape;
            if (shape.geometry.boundingSphere.intersectsSphere(boundingSphere) && overlapsPlane(shape)) {
                if (!dbgFoundCap) {
                    dbgFoundCap = true;
                    renderer.clearDepth();
                }
                let intersectPoints = geometryPlaneIntersections(shape.geometry, plane);
                if (intersectPoints.length >= 3) {
                    let screenPoints = intersectPoints.map(p => {
                        let o = p.clone().sub(center);
                        return vec2(o.dot(screenX) / (wNear / 2), o.dot(screenY) / (hNear / 2));
                    });
                    screenPoints = convexPolygonPointOrder(screenPoints);
                    if (screenPoints.length >= 3) {
                        for (let i = 0; i < dbgCapGeo.vertices.length; i++) {
                            let p = screenPoints[Math.min(i, screenPoints.length - 1)];
                            dbgCapGeo.vertices[i].set(p.x, p.y, 0);
                        }
                        dbgCapGeo.verticesNeedUpdate = true;
                        dbgCapMaterial.color.copy(solid.color).multiplyScalar(0.1);
                        renderer.render(dbgCapScene, dbgCapCamera);
                    }
                }
            }
        }
    }
}

class MapView {
    camera: THREE.OrthographicCamera;
    scene: THREE.Scene;
    mesh: THREE.Mesh;
    constructor(x: number, y: number, w: number, h: number, texture: THREE.Texture) {
        // Setup a camera where the middle square of the screen is [-1,1]x[-1,1]
        let vw = canvas.width;
        let vh = canvas.height;
        let aw = Math.max(1, vw / vh);
        let ah = Math.max(1, vh / vw);
        this.camera = new THREE.OrthographicCamera(-aw, aw, ah, -ah, 100, -100);

        this.scene = new THREE.Scene();
        this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 1), new THREE.MeshBasicMaterial({ map: texture }));
        this.mesh.position.set(x, y, 0);
        this.mesh.scale.set(w, h, 1);
        this.scene.add(this.mesh);
    }
    render() {
        renderer.render(this.scene, this.camera);
    }
}
export let dbgCascadeMapsVisible = false;
let dbgCascadeMaps = cascadedShadowMaps.map((m, i) => {
    let size = 0.5;
    let x = -1 + size / 2 + size * i;
    let y = -1 + size / 2;
    return new MapView(x, y, size, size, m.shadowTarget.depthTexture);
});
export let dbgIntermediateMapsVisible = false;
let dbgIntermediateMaps = [
    new MapView(-0.25, 0.75, 0.5, 0.5, intermediateTarget1.texture),
    new MapView(0.25, 0.75, 0.5, 0.5, intermediateTarget2.texture)
];
export let dbgDepthTargetMapVisible = false;
let dbgDepthTargetMaps = [
    new MapView(-0.25, 0.25, 0.5, 0.5, depthTarget.texture),
    new MapView(0.25, 0.25, 0.5, 0.5, depthTarget.depthTexture),
];

function distanceConvexPolyhedronToPlane(points: THREE.Vector3[], plane: THREE.Plane): number {
    let minDistance = Infinity;
    for (let point of points) {
        let distance = plane.distanceToPoint(point);
        if (distance < minDistance) {
            if (distance < 0) return 0;
            minDistance = distance;
        }
    }
    return minDistance;
}

let frameNumber = 0;
function positionCascades() {
    frameNumber += 1;
    // Simplest initial setup: center on player's camera
    // Then, try to push the shadow camera's frustum to the player's view frustum
    let dir = dirLightDir;
    let playerNDCToWorld = new THREE.Matrix4().getInverse(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    let playerViewFrustumCorners: THREE.Vector3[] = [];
    for (let x of [-1, 1]) {
        for (let y of [-1, 1]) {
            for (let z of [-1, 1]) {
                playerViewFrustumCorners.push(vec3(x, y, z).applyProjection(playerNDCToWorld));
            }
        }
    }
    for (let [pattern, sm] of zip(["1111", "0101", "1000", "0010"], cascadedShadowMaps)) {
        sm.wantRenderThisFrame = pattern[frameNumber % pattern.length] === "1";
        if (!sm.wantRenderThisFrame) continue;
        sm.shadowCamera.position.copy(camera.getWorldPosition());
        sm.shadowCamera.lookAt(sm.shadowCamera.position.clone().sub(dir));
        sm.shadowCamera.updateMatrixWorld(true);
        let mwi = new THREE.Matrix4().getInverse(sm.shadowCamera.matrixWorld);
        let frustum = new THREE.Frustum().setFromMatrix(new THREE.Matrix4().multiplyMatrices(sm.shadowCamera.projectionMatrix, mwi));
        let planes = frustum.planes.filter(p => Math.abs(p.normal.dot(dir)) < 0.1);
        console.assert(planes.length === 4);
        for (let plane of planes) {
            sm.shadowCamera.position.addScaledVector(plane.normal, 0.9 * distanceConvexPolyhedronToPlane(playerViewFrustumCorners, plane));
        }

        // Snap shadow camera to texels
        // This makes world shadows not flicker/crawl when the shadow cameras move, but in exchange it makes the player's shadow do those things.
        // The difference is not super noticeable while the sun's angle is changing.
        let x = vec3(0, 0, 0);
        let y = vec3(0, 0, 0);
        let z = vec3(0, 0, 0);
        sm.shadowCamera.matrixWorld.extractBasis(x, y, z);
        x.normalize();
        y.normalize();
        z.normalize();

        let resolution = vec3(
            sm.shadowTarget.width / (sm.shadowCamera.right - sm.shadowCamera.left),
            sm.shadowTarget.height / (sm.shadowCamera.top - sm.shadowCamera.bottom),
            (2 ** 24) / (sm.shadowCamera.far - sm.shadowCamera.near),
        );

        let basisPosition = vec3(
            x.dot(sm.shadowCamera.position),
            y.dot(sm.shadowCamera.position),
            z.dot(sm.shadowCamera.position),
        );

        basisPosition.multiply(resolution).floor().divide(resolution);

        sm.shadowCamera.position.set(0, 0, 0)
            .addScaledVector(x, basisPosition.x)
            .addScaledVector(y, basisPosition.y)
            .addScaledVector(z, basisPosition.z);
    }
}

function setupExtendedUniforms(scene: THREE.Scene, camera: THREE.Camera, depthMap: {texture: THREE.Texture|null, width: number, height: number, left: number, bottom: number}, ssaoMap: THREE.Texture, stencilShadows: THREE.Texture) {
    let projview = camera.projectionMatrix.clone();
    let projviewInv = new THREE.Matrix4().getInverse(projview);
    let aoUniforms = {
        worldToView: projview,
        viewToWorld: projviewInv,
        depthMap: depthMap.texture,
        viewportOffset: new THREE.Vector2(depthMap.left, depthMap.bottom),
        size: new THREE.Vector2(depthMap.width, depthMap.height),
    };

    // Shadow matrix, NDC -> view -> world -> shadow view -> shadow ndc
    let shadowMatrices = cascadedShadowMaps.map(m =>
        m.shadowCamera.projectionMatrix.clone()
            .multiply(m.shadowCamera.matrixWorldInverse)
            .multiply(camera.matrixWorld)
            .multiply(projviewInv)
    );
    let shadowUniforms = {
        shadowCascadeMatrix: shadowMatrices,
        shadowCascadeMatrixInv: shadowMatrices.map(m => new THREE.Matrix4().getInverse(m)),
        shadowCascadeMap: cascadedShadowMaps.map(m => m.shadowTarget.depthTexture),
        shadowCascadeSize: cascadedShadowMaps.map(m => vec2(m.width, m.height)),
        shadowCascadeBias: cascadedShadowMaps.map(m => m.bias),
    };
    let allActiveExtendedMaterials = new Set<THREE.ShaderMaterial>();
    scene.traverseVisible(obj => {
        if ("material" in obj && isExtendedMaterial.has((obj as any).material)) {
            allActiveExtendedMaterials.add((obj as any).material);
        }
    });
    for (let m of allActiveExtendedMaterials) {
        m.uniforms.uSSAOTexture.value = ssaoMap;
        m.uniforms.uStencilShadowTexture.value = stencilShadows;
        m.uniforms.depthMap.value = aoUniforms.depthMap;
        m.uniforms.viewportOffset.value = aoUniforms.viewportOffset;
        m.uniforms.size.value = aoUniforms.size;
        m.uniforms.shadowCascadeMatrix.value = shadowUniforms.shadowCascadeMatrix;
        m.uniforms.shadowCascadeMatrixInv.value = shadowUniforms.shadowCascadeMatrixInv;
        m.uniforms.shadowCascadeMap.value = shadowUniforms.shadowCascadeMap;
        m.uniforms.shadowCascadeSize.value = shadowUniforms.shadowCascadeSize;
        m.uniforms.shadowCascadeBias.value = shadowUniforms.shadowCascadeBias;
    }
}

function* skip<T>(it: Iterable<T>, n: number): IterableIterator<T> {
    let i = it[Symbol.iterator]();
    for (let x = 0; x < n; x++) {
        i.next();
    }
    while (true) {
        let r = i.next();
        if (!r.done) {
            yield r.value;
        } else {
            return;
        }
    }
}

let frameTiming = new class FrameTimingDisplay {
    numFrames = 120;
    lastStart: number = 0;
    startTimes: number[] = [];
    frameTimes: number[] = [];
    nextUpdate = 0;
    frameStart() {
        this.lastStart = performance.now();
        this.startTimes.push(this.lastStart);
        if (this.startTimes.length > this.numFrames) {
            this.startTimes.shift();
        }
    }
    frameEnd() {
        let now = performance.now();
        this.frameTimes.push(now - this.lastStart);
        if (this.frameTimes.length > this.numFrames) {
            this.frameTimes.shift();
        }

        if (now > this.nextUpdate) {
            this.nextUpdate = now + 1000;
            let averageFrameTimes = this.frameTimes.reduce((acc, x) => acc + x, 0) / this.frameTimes.length;
            let startToStartTimes = Array.from(zip(this.startTimes, skip(this.startTimes, 1))).map(([x, y]) => y - x);
            let averageStartToStartTimes = startToStartTimes.reduce((acc, x) => acc + x, 0) / startToStartTimes.length;

            document.querySelector("#frameTimes")!.textContent = averageFrameTimes.toFixed(2) + "ms";
            document.querySelector("#fps")!.textContent = (1000 / averageStartToStartTimes).toFixed(2) + "fps";
        }
    }
};

let shadowVolumeMaterial = extrusionShader.extrusionMaterial.clone();
shadowVolumeMaterial.colorWrite = false;
shadowVolumeMaterial.depthWrite = false;
shadowVolumeMaterial.depthTest = true;
shadowVolumeMaterial.depthFunc = THREE.LessDepth; // Strange that three.js' default is THREE.LessEqualDepth considering OpenGL and WebGL default to GL_LESS
shadowVolumeMaterial.side = THREE.DoubleSide;
export let shadowVolumeScene = new THREE.Scene();

function mergeBufferGeometries(bufferGeometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
    function sumMap<T>(ts: T[], f: (t: T) => number): number {
        let s = 0;
        for (let t of ts) s += f(t);
        return s;
    }
    let indices = new Uint32Array(sumMap(bufferGeometries, b => b.getIndex().array.length));
    let attributes = Object.keys(bufferGeometries[0].attributes).map(name => {
        let sampleAttrib = bufferGeometries[0].getAttribute(name);
        let ctor: any = sampleAttrib.array.constructor;
        let itemSize = sampleAttrib.itemSize;
        let totalLength = sumMap(bufferGeometries, b => b.getAttribute(name).array.length);
        return {
            name: name,
            index: 0,
            array: new ctor(totalLength),
            itemSize: itemSize,
        }
    });
    let indicesIndex = 0;
    let previousTotalVertexCount = 0;
    for (let bufferGeometry of bufferGeometries) {
        for (let i of bufferGeometry.getIndex().array as Uint32Array) {
            indices[indicesIndex++] = i + previousTotalVertexCount;
        }
        for (let attr of attributes) {
            for (let v of bufferGeometry.getAttribute(attr.name).array as any) {
                attr.array[attr.index++] = v;
            }
        }
        previousTotalVertexCount += bufferGeometry.getAttribute("position").count;
    }

    let merged = new THREE.BufferGeometry();
    merged.setIndex(new THREE.BufferAttribute(indices, 1));
    for (let attr of attributes) {
        merged.addAttribute(attr.name, new THREE.BufferAttribute(attr.array, attr.itemSize));
    }
    return merged;
}

function generateWorldShadowVolume() {
    let allSolids = world.solids.getAll([]);
    let identityMatrix = new THREE.Matrix4();
    let bufferGeometries = allSolids.map(solid => extrusionShader.generateExtrudableGeometry(solid.shape.geometry));
    let allGeometry = mergeBufferGeometries(bufferGeometries);
    return new THREE.Mesh(allGeometry, shadowVolumeMaterial);
}
function updateShadowVolumeMatrixFromShadowParent(obj: THREE.Object3D) {
    let parent: THREE.Object3D|undefined = (obj as any).shadowVolumeParent;
    if (parent != null) {
        obj.visible = parent.visible;
        // It is necessary that the same exact model matrices are used in order to prevent depth differences between the original mesh and the shadow volume.
        obj.matrixAutoUpdate = false;
        obj.matrix.copy(parent.matrixWorld);
    }
}

let stencilNeutralValue = 127; // 8 bit stencil buffer
function renderShadowVolumes() {
    // https://en.wikipedia.org/wiki/Shadow_volume#Depth_pass
    // stencil buffer is unsigned, so it's cleared to a midway point
    let gl = renderer.context;
    gl.enable(gl.STENCIL_TEST);
    // Set up stencil ops so that entering shadow -= 1 and leaving shadow += 1
    gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.INCR, gl.KEEP);
    gl.stencilOpSeparate(gl.BACK, gl.KEEP, gl.DECR, gl.KEEP);
    
    // TODO: should probably use onBeforeRender for the individual meshes instead
    shadowVolumeScene.traverse(obj => {
        updateShadowVolumeMatrixFromShadowParent(obj);
    });
    shadowVolumeMaterial.uniforms.uExtrusion.value = dirLightDir.clone().transformDirection(camera.matrixWorldInverse);
    renderer.render(shadowVolumeScene, camera, depthTarget);

    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);

    // Set color to 1 where not in shadow (stencil buffer >= 127) and 0 otherwise
    transferStencilToColor(depthTarget);
    gl.disable(gl.STENCIL_TEST);
}

let transferStencilToColor = (() => {
    let transferMaterial = new THREE.ShaderMaterial(<any>{
        uniforms: { },
        vertexShader: `
            varying vec2 fragUV;
            void main() {
                fragUV = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
            }
        `,
        fragmentShader: `
            void main() {
                gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
            }
        `,
        depthTest: false,
        depthWrite: false,
    });

    let camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    let scene = new THREE.Scene();
    let quad = new THREE.Mesh(new THREE.PlaneBufferGeometry( 2, 2 ), transferMaterial);
    quad.frustumCulled = false;
    scene.add(quad);

    return function transferStencilToColor(target: THREE.WebGLRenderTarget) {
        let gl = renderer.context;
        // `ref` is the stencil value for all fragments generated, so the test is `ref` `op` `value in buffer`
        // in this case, it's 127 <= buffer
        // this will make the (initially cleared to black) color buffer white where not in shadow
        gl.stencilFunc(gl.LEQUAL, stencilNeutralValue, 0xffff);
        renderer.render(scene, camera, target);
        gl.stencilFunc(gl.ALWAYS, 0, 0xffff);
    }
})();

function transformDirectionNoNormalize(v: THREE.Vector3, m: THREE.Matrix4): THREE.Vector3 {
    let h = new THREE.Vector4(v.x, v.y, v.z, 0).applyMatrix4(m);
    return v.set(h.x, h.y, h.z);
}

export let dbgExtrudedGeometry = extrusionShader.generateExtrudableGeometry(makeConvexGeo(cubeVertices.map(v => vec3(-0.5, -0.5, -0.5).add(v))));
export let dbgExtrudeMaterial = extrusionShader.extrusionMaterial.clone();
export let dbgExtrudedMesh = new THREE.Mesh(dbgExtrudedGeometry, dbgExtrudeMaterial);
dbgExtrudedMesh.position.z = 3;
scene.add(dbgExtrudedMesh);
export function dbgSetExtrude(dir: THREE.Vector3, amount: number) {
    dbgExtrudeMaterial.uniforms.uExtrusion.value = dir.clone().transformDirection(camera.matrixWorldInverse);
}
dbgSetExtrude(vec3(1, 0, 1).normalize(), 5);

export let dbgSSAOBlur = true;

let depthTargetDepthMaterial = new THREE.MeshDepthMaterial({ colorWrite: false });

export let dbgTimeScale = 1.0;
let lastFrameTime = window.performance.now();
function tick() {
    frameTiming.frameStart();
    let now = window.performance.now();
    let deltaTime = Math.min(now - lastFrameTime, 50) / 1000 * dbgTimeScale;
    lastFrameTime = now;
    var e = new Event('dbgframe');
    (e as any).deltaTime = deltaTime;
    window.dispatchEvent(e);
    tickGame(deltaTime);
    renderer.clear();

    // Render scene depth map to be used later for ambient occlusion
    renderer.setClearColor(0);
    renderer.context.clearStencil(stencilNeutralValue);
    renderer.clearTarget(depthTarget, true, true, true);
    scene.overrideMaterial = depthTargetDepthMaterial;
    renderer.render(scene, camera, depthTarget);
    scene.overrideMaterial = null as any;

    // Set up cascaded shadow map views
    positionCascades();
    // Render shadow maps
    sunMesh.visible = false;
    // worldMesh.visible = false;
    cascade.renderShadowMaps(renderer, scene, cascadedShadowMaps);
    sunMesh.visible = true;
    // worldMesh.visible = true;

    // Calculate SSAO
    ssaoShader.generateSSAO(renderer, depthTarget.depthTexture, new THREE.Vector2(depthTarget.width, depthTarget.height), 
        camera.projectionMatrix, new THREE.Matrix4().getInverse(camera.projectionMatrix), intermediateTarget1);
    // Blur the SSAO
    if (dbgSSAOBlur) {
        depthAwareBlur.blurHorizontal(renderer, new THREE.Vector2(intermediateTarget1.width, intermediateTarget1.height), intermediateTarget1.texture, depthTarget.depthTexture, intermediateTarget2);
        depthAwareBlur.blurVertical(renderer, new THREE.Vector2(intermediateTarget2.width, intermediateTarget2.height), intermediateTarget2.texture, depthTarget.depthTexture, intermediateTarget1);
    }
    
    // Render shadow volumes in depthTarget using its stencil buffer then transferring to its color attachment
    renderShadowVolumes();

    // Render scene, providing extra uniforms related to shadow mapping and ambient occlusion
    setupExtendedUniforms(scene, camera, {texture: depthTarget.depthTexture, width: depthTarget.width, height: depthTarget.height, left: 0, bottom: 0}, intermediateTarget1.texture, depthTarget.texture);
    renderer.render(scene, camera);

    if (!worldMaterial.wireframe) {
        drawSolidCaps();
    }
    miniview.render();
    hudview.render(deltaTime);
    debug.update(deltaTime);
    debug.render(renderer);
    if (dbgCascadeMapsVisible) dbgCascadeMaps.forEach(d => d.render());
    if (dbgIntermediateMapsVisible) dbgIntermediateMaps.forEach(d => d.render());
    if (dbgDepthTargetMapVisible) dbgDepthTargetMaps.forEach(d => d.render());
    justPressedKeys.clear();
    justReleasedKeys.clear();
    window.requestAnimationFrame(tick);
    frameTiming.frameEnd();
}
window.requestAnimationFrame(tick);

class HitIndicator {
    static GEOMETRY = (() => {
        let geometry = new THREE.Geometry();
        let angle = Math.PI / 30;
        let width = 0.1;
        let segments = 20;
        for (let i = 0; i < segments; i++) {
            let a = -angle / 2 + angle * i / (segments - 1);
            let p = vec3(Math.cos(a), Math.sin(a), 0);
            geometry.vertices.push(p);
            geometry.vertices.push(p.clone().multiplyScalar(1.0 - width));
        }
        for (let i = 0; i < segments - 1; i++) {
            let base = i * 2;
            geometry.faces.push(new THREE.Face3(base + 0, base + 2, base + 1));
            geometry.faces.push(new THREE.Face3(base + 1, base + 2, base + 3));
        }
        return geometry;
    })();
    static MATERIAL = new THREE.MeshBasicMaterial({ color: "red", transparent: true, opacity: 1 });
    mesh: THREE.Mesh;
    material: THREE.MeshBasicMaterial;
    totalTtl: number;
    constructor(public ttl: number, public position: THREE.Vector3) {
        this.totalTtl = ttl;
        this.material = HitIndicator.MATERIAL.clone();
        this.mesh = new THREE.Mesh(HitIndicator.GEOMETRY, this.material);
        this.mesh.scale.setScalar(0.7);
        hudview.scene.add(this.mesh);
        hudview.hitIndicators.push(this); // mmm
    }
    update(deltaTime: number) {
        this.ttl -= deltaTime;

        let dir = this.position.clone().sub(dbgPlayer.position);
        let angle = Math.atan2(dir.y, dir.x);

        this.mesh.rotation.z = angle - dbgPlayer.hFacing + Math.PI / 2; // extra pi/2 is to go from 0 being right to 0 being up
        this.material.opacity = this.ttl / this.totalTtl;
        if (this.ttl > 0) {
            return true;
        } else {
            hudview.scene.remove(this.mesh);
            return false;
        }
    }
}

class HudView {
    mesh: THREE.LineSegments;
    scene: THREE.Scene;
    camera: THREE.OrthographicCamera;
    hitIndicators: HitIndicator[] = [];
    constructor() {
        let aspect = canvas.width / canvas.height;
        this.camera = new THREE.OrthographicCamera(-1 * aspect, 1 * aspect, 1, -1, 100, -100);
        this.scene = new THREE.Scene();
        let crosshairGeo = new THREE.Geometry();
        crosshairGeo.vertices.push(vec3(0.0, 0.0, 0.0), vec3(0.0, 0.1, 0.0));
        crosshairGeo.vertices.push(vec3(-0.05, 0.0, 0.0), vec3(0.05, 0.0, 0.0));
        crosshairGeo.vertices.push(vec3(0.0, -0.05, 0.0), vec3(0.0, 0.0, 0.0));
        crosshairGeo.colors.push(new THREE.Color(0xffffff), new THREE.Color(0xffffff));
        crosshairGeo.colors.push(new THREE.Color(0xffffff), new THREE.Color(0xffffff));
        crosshairGeo.colors.push(new THREE.Color(0xffffff), new THREE.Color(0xffffff));
        let crosshairMaterial = new THREE.LineBasicMaterial({vertexColors: THREE.VertexColors});
        crosshairMaterial.opacity = 0.5;
        crosshairMaterial.transparent = true;
        crosshairMaterial.depthTest = false;
        crosshairMaterial.depthWrite = false;
        this.mesh = new THREE.LineSegments(crosshairGeo, crosshairMaterial);
        this.scene.add(this.mesh);
    }
    render(deltaTime: number) {
        this.hitIndicators = this.hitIndicators.filter(h => h.update(deltaTime));
        this.mesh.rotation.z = -toolRoll;
        renderer.render(this.scene, this.camera);
    }
}
let hudview = new HudView();

function mix(x: number, y: number, a: number) {
    return x * (1 - a) + y * a;
}
function colorCurve(points: [number, THREE.Color][]): (t: number) => THREE.Color {
    return function(t: number) {
        if (t < points[0][0]) {
            return points[0][1];
        }
        let prevPoint = points[0];
        for (let p of points) {
            if (t < p[0]) {
                return prevPoint[1].clone().lerp(p[1], (t - prevPoint[0]) / (p[0] - prevPoint[0]));
            }
            prevPoint = p;
        }
        return points[points.length - 1][1];
    };
}
let skyColors = colorCurve([
    [-0.3, new THREE.Color(0x111122)],
    [-0.05, new THREE.Color(0x551133)],
    [0.05, new THREE.Color(0x551133)],
    [0.1, new THREE.Color(0x2266cc)],
    [0.2, new THREE.Color(0x2277ff)],
]);
let sunColors = colorCurve([
    [-0.3, new THREE.Color(0x111122)],
    [-0.05, new THREE.Color(0xff9900)],
    [0.05, new THREE.Color(0xff9900)],
    [0.2, new THREE.Color(0xffffff)],
]);
interface SunAndSky {
    sunDir: THREE.Vector3;
    skyColor: THREE.Color;
    sunEnabled: boolean;
    sunColor: THREE.Color;
}

declare var exports: any;
export let planetTilt = 23.4 * Math.PI / 180; // [-PI, PI]
debugMenu.defineOverrideEditor(exports, "planetTilt", debugMenu.clampedEditor(-Math.PI, Math.PI));
export let timeOfYear = 0.0; // [0, 1], 0.0 => winter solstice, 0.25 => equinox, 0.5 => summer solstice, 0.75 => equinox
debugMenu.defineOverrideEditor(exports, "timeOfYear", debugMenu.clampedEditor(0, 1));
export let latitude = 35.0 * Math.PI / 180; // [-PI/2, PI/2]
debugMenu.defineOverrideEditor(exports, "latitude", debugMenu.clampedEditor(-Math.PI / 2, Math.PI / 2));

export let dbgEarth = new THREE.Mesh(new THREE.SphereGeometry(0.25), new THREE.MeshStandardMaterial({ color: 0x009900 }));
dbgEarth.position.set(-2, 0, 1);
dbgEarth.add(new THREE.AxisHelper());
scene.add(dbgEarth);
export let dbgSun = new THREE.Mesh(new THREE.SphereGeometry(0.25), new THREE.MeshStandardMaterial({ color: 0xffff00 }));
dbgSun.position.set(-2, 0, 1);
scene.add(dbgSun);

function getSunDir(timeOfDay: number /* [0, 1], 0.0 => midnight, 0.5 => noon */) {
    let surfaceOrientation = new THREE.Quaternion();

    // TODO: This was written through complete trial and error, so maybe try to figure out wtf
    surfaceOrientation.multiply(new THREE.Quaternion().setFromAxisAngle(vec3(0, 1, 0), -planetTilt));
    surfaceOrientation.multiply(new THREE.Quaternion().setFromAxisAngle(vec3(0, 0, 1), -(timeOfDay + timeOfYear) * Math.PI * 2 + Math.PI));
    surfaceOrientation.multiply(new THREE.Quaternion().setFromAxisAngle(vec3(0, 1, 0), -latitude));
    
    let sunPosition = vec3(1, 0, 0).applyAxisAngle(vec3(0, 0, 1), -timeOfYear * Math.PI * 2);
    dbgSun.position.copy(dbgEarth.position).add(sunPosition);
    dbgEarth.quaternion.copy(surfaceOrientation);

    sunPosition.applyQuaternion(surfaceOrientation.clone().inverse());

    return vec3(-sunPosition.y, sunPosition.z, sunPosition.x);
}

function sunAndSky(timeOfDay: number): SunAndSky {
    timeOfDay = timeOfDay - Math.floor(timeOfDay / 1.0);
    let sunDir = getSunDir(timeOfDay);
    let skyColor = skyColors(sunDir.z);
    let sunEnabled = true;
    let sunColor = sunColors(sunDir.z);
    return { sunDir, skyColor, sunEnabled, sunColor };
}

canvas.onmousemove = evt => {
    if (document.pointerLockElement === canvas) {
        let movementFactor = 1/500;
        if (heldKeys.has(VK.LSHIFT) && activeTool !== weaponTool) {
            movementFactor /= 10;
        }
        rotateView(-evt.movementX * movementFactor, -evt.movementY * movementFactor);
    }
}
canvas.onclick = evt => {
    if (document.pointerLockElement !== canvas) {
        canvas.requestPointerLock();
        canvas.focus();
    }
}

var VK = <{[index: string]: number|Symbol}> "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890".split("").reduce((o, c) => {
    o[c] = o[c.toLowerCase()] = c.charCodeAt(0); 
    return o;
}, {} as any);
VK.LSHIFT = 16;
VK.SPACE = 0x20;
VK.LEFT_MOUSE = Symbol("LEFT_MOUSE");
VK.RIGHT_MOUSE = Symbol("RIGHT_MOUSE");
VK.MIDDLE_MOUSE = Symbol("MIDDLE_MOUSE");
let mouseButtonToVK: {[index: number]: number|Symbol} = {0: VK.LEFT_MOUSE, 1: VK.MIDDLE_MOUSE, 2: VK.RIGHT_MOUSE};

var heldKeys = new Set();
let justPressedKeys = new Set();
let justReleasedKeys = new Set();
function keyDown(id: any) {
    if (!heldKeys.has(id)) {
        heldKeys.add(id);
        var e = new Event('actualkeydown');
        (e as any).which = id;
        canvas.dispatchEvent(e);
        justPressedKeys.add(id);
    }
}
function keyUp(id: any) {
    if (heldKeys.delete(id)) {
        var e = new Event('actualkeyup');
        (e as any).which = id;
        canvas.dispatchEvent(e);
        justReleasedKeys.add(id);
    }
}

canvas.addEventListener("keydown", evt => {
    keyDown(evt.which);
});
canvas.addEventListener("keyup", evt => {
    keyUp(evt.which);
});
canvas.onmousedown = evt => {
    if (document.pointerLockElement === canvas) {
        keyDown(mouseButtonToVK[evt.button]);
    }
}
canvas.onmouseup = evt => {
    if (document.pointerLockElement === canvas) {
        keyUp(mouseButtonToVK[evt.button]);
    }
}

function keyboardVel(): THREE.Vector2 {
    let velocity = new THREE.Vector2(0, 0);
    if (heldKeys.has(VK.W)) velocity.x += 1;
    if (heldKeys.has(VK.S)) velocity.x -= 1;
    if (heldKeys.has(VK.A)) velocity.y += 1;
    if (heldKeys.has(VK.D)) velocity.y -= 1;
    return velocity;
}

// If p is the probability that an event happens at least once within an interval t
// Then (1 - (1 - p)**(u / t)) is the probability that an event happens at least once within an interval u
/// p is the probability of an event occurring at least once in 1 interval, t is then a real number of intervals  
function probInterval(p: number, t: number) {
    return 1 - Math.pow(1 - p, t);
}

function testProb() {
    let n = 0;
    for (let t = 0; t < 100.0;) {
        let deltaTime = Math.random() * 0.016 + 0.008;
        // if (Math.random() > Math.pow(0.9, deltaTime)) {
        if (Math.random() < probInterval(0.1, deltaTime)) {
            n += 1;
        }
        t += deltaTime;
    }
    console.log(n); // Should be ~10 for maxT of 100 and p of 0.1
}

// export let worldMaterial = new THREE.MeshStandardMaterial({vertexColors: THREE.FaceColors, roughness: 0.8, metalness: 0.2});
export let worldMaterial = cloneBaseMaterial();
worldMaterial.vertexColors = THREE.FaceColors;
worldMaterial.uniforms.roughness.value = 0.8;
worldMaterial.uniforms.metalness.value = 0.2;

function collidesWorld(world: World, shape: ConvexShape): boolean {
    let s = new ConvexPolyhedron(shape.getWorldVertices());
    for (let solid of world.solids.get(s.boundingBox().expandByScalar(0.1), [])) {
        if (solid.shape.overlaps(s)) return true;
    }
    return false;
}

function raycastWorld(world: World, ray: THREE.Ray, depth: number): [WorldSolid, RaycastIntersection]|null {
    let te = Infinity;
    let result: [WorldSolid, RaycastIntersection]|null = null;
    for (let solid of world.solids.raycast(ray, depth, [])) {
        let r = solid.shape.raycast(ray, depth);
        if (r != null && r.enterT < te) {
            te = r.enterT;
            result = [solid, r];
        }
    }
    return result;
}
function selectSolid(world: World, ray: THREE.Ray, depth: number): WorldSolid|null {
    let r = raycastWorld(world, ray, depth);
    if (r == null) return null;
    return r[0];
}
function selectVertex(world: World, ray: THREE.Ray, depth: number, distanceToRay: number): THREE.Vector3|null {
    let s = selectSolid(world, ray, depth);
    if (s == null) return null;
    let closest = s.shape.vertices
        .map(vertex => ({ distance: ray.distanceSqToPoint(vertex), vertex }))
        .reduce((a, b) => a.distance < b.distance ? a : b);
    if (closest.distance > distanceToRay * distanceToRay) return null;
    return closest.vertex;
}

function* graphIterator<T>(t: T, neighbors: (t: T) => Iterable<T>): IterableIterator<T> {
    let seen = new Set<T>();
    function* processNode(t: T): IterableIterator<T> {
        if (seen.has(t)) return;
        yield t;
        seen.add(t);
        for (let neighbor of neighbors(t)) {
            yield* processNode(neighbor);
        }
    }
    yield* processNode(t);
}

function cloneSolidWithDependents(solid: WorldSolid): WorldSolid {
    let solidClone = new WorldSolid();
    solidClone.isRoot = solid.isRoot;
    solidClone.shape = solid.shape; // new ConvexPolyhedron(solid.shape.vertices);
    solidClone.color = solid.color.clone();
    solidClone.attached = <any>undefined; // To be filled in below
    
    let clones = new Map<WorldSolid, WorldSolid>();
    clones.set(solid, solidClone);
    outer: for (let neighbor of solid.attached) {
        let toClone = [];
        for (let reached of graphIterator(neighbor, t => t.attached.filter(s => s !== solid))) {
            if (reached.isRoot) {
                continue outer;
            }
            toClone.push(reached);
        }
        for (let reached of toClone) {
            if (!clones.has(reached)) {
                let reachedClone = new WorldSolid();
                reachedClone.isRoot = reached.isRoot;
                reachedClone.color = reached.color.clone();
                reachedClone.shape = reached.shape; // new ConvexPolyhedron(reached.shape.vertices);
                reachedClone.attached = <any>undefined; // To be filled in below
                clones.set(reached, reachedClone);
            }
        }
    }
    // clones now maps all solids in the subgraph we want to a clone
    for (let [original, clone] of clones) {
        clone.attached = original.attached.map(s => <WorldSolid>clones.get(s)).filter(s => s != null);
    }
    return solidClone;
}

class ConvexPolyhedron {
    readonly vertices: THREE.Vector3[];
    readonly axes: THREE.Vector3[]; // For collision
    readonly edges: THREE.Vector3[]; // For collision
    readonly geometry: THREE.Geometry;

    static make(points: THREE.Vector3[]): ConvexPolyhedron|null {
        try {
            return new ConvexPolyhedron(points);
        } catch(e) {
            return null;
        }
    }

    constructor(points: THREE.Vector3[]) {
        let geometry = worldsolids.convexHull3D(points);
        if (geometry == null) throw { message: "Failed to create convex hull from points", points };
        this.geometry = geometry;
        this.geometry.computeFaceNormals();
        this.geometry.computeBoundingSphere();
        this.axes = [];
        this.vertices = [];
        outer: for (let face of this.geometry.faces) {
            let normal = face.normal;
            for (let axis of this.axes) {
                if (Math.abs(axis.dot(normal)) > 0.9999) {
                    continue outer;
                }
            }
            this.axes.push(normal);
        }
        outer: for (let vertex of this.geometry.vertices) {
            for (let v of this.vertices) {
                if (v.distanceToSquared(vertex) < 0.0001) {
                    continue outer;
                }
            }
            this.vertices.push(vertex);
        }
        this.edges = getUniqueEdges(this.geometry);
    }

    containsPoint(point: THREE.Vector3): boolean {
        for (let face of this.geometry.faces) {
            let v = this.geometry.vertices[face.a];
            if (point.clone().sub(v).dot(face.normal) > 0) return false;
        }
        return true;
    }

    raycast(ray: THREE.Ray, depth: number): RaycastIntersection|null {
        if (!ray.intersectSphere(this.geometry.boundingSphere)) return null;
        // Implementation of http://geomalgorithms.com/a13-_intersect-4.html
        let enterT = 0; // Max time of entering
        let leaveT = depth; // Min time of leaving
        let enterNormal = null;
        let leaveNormal = null;
        let rayOffset = ray.direction;
        for (let face of this.geometry.faces) {
            let d = rayOffset.dot(face.normal);
            let n = this.geometry.vertices[face.a].clone().sub(ray.origin).dot(face.normal);
            if (Math.abs(d) < 0.01) {
                // Ray parallel to face
                if (n < 0) {
                    // No collision, ray outside face and parallel.
                    return null;
                } else {
                    // No collision with this face, but ray is inside.
                    continue;
                }
            } 
            let t = n / d;
            if (d < 0) {
                if (t > enterT) {
                    enterT = t;
                    enterNormal = face.normal;
                }
            } else {
                if (t < leaveT) {
                    leaveT = t;
                    leaveNormal = face.normal;
                }
            }
            if (enterT > leaveT) {
                // No collision
                return null;
            }
        }
        return { enterT, leaveT, enterNormal, leaveNormal };
    }

    /** Returns the shortest vector to displace `other` out of `this` or null if there is no overlap */
    getPenetration(other: ConvexPolyhedron): PenetrationResult|null {
        if (!this.geometry.boundingSphere.intersectsSphere(other.geometry.boundingSphere)) return null;
        const EPSILON = 0.001;
        let penetrationAxis: THREE.Vector3|null = null;
        let penetrationDistance = Infinity;
        let overlapRegion: [number, number]|null = null;
        let separatedByAxis = (axis: THREE.Vector3) => {
            let [minA, maxA] = verticesSpan(this.vertices, axis);
            let [minB, maxB] = verticesSpan(other.vertices, axis);
            if (maxA <= minB + EPSILON || maxB <= minA + EPSILON) {
                return true;
            }
            let d1 = maxA - minB;
            let d2 = minA - maxB;
            let d = Math.abs(d1) < Math.abs(d2) ? d1 : d2;
            if (Math.abs(d) < Math.abs(penetrationDistance)) {
                penetrationAxis = axis;
                penetrationDistance = d;
                overlapRegion = [Math.max(minA, minB), Math.min(maxA, maxB)];
            }
            return false;
        };

        for (let axis of this.axes) {
            if (separatedByAxis(axis)) return null;
        }
        for (let axis of other.axes) {
            if (separatedByAxis(axis)) return null;
        }

        for (let edgeA of this.edges) {
            for (let edgeB of other.edges) {
                let norm = vec3(0, 0, 0).crossVectors(edgeA, edgeB);
                if (norm.lengthSq() < 0.0001) {
                    // Edges parallel, ignore
                } else {
                    // Must be normalized here for the dot products' differences to be comparable across axes
                    if (separatedByAxis(norm.normalize())) return null;
                }
            }
        }

        return {
            axis: (penetrationAxis as any).clone(),
            displacement: penetrationDistance,
            overlap: overlapRegion as any,
        };
    }

    overlaps(other: ConvexPolyhedron): boolean {
        if (!this.geometry.boundingSphere.intersectsSphere(other.geometry.boundingSphere)) return false;
        const EPSILON = 0.01; // Err on the side of no contact
        let separatedByAxis = (axis: THREE.Vector3) => {
            let [minA, maxA] = verticesSpan(this.vertices, axis);
            let [minB, maxB] = verticesSpan(other.vertices, axis);
            return maxA <= minB + EPSILON || maxB <= minA + EPSILON;
        };

        for (let axis of this.axes) {
            if (separatedByAxis(axis)) return false;
        }
        for (let axis of other.axes) {
            if (separatedByAxis(axis)) return false;
        }

        // This needs to consider axes made by cross product of edges.
        //       https://www.geometrictools.com/Documentation/MethodOfSeparatingAxes.pdf
        //       https://en.wikipedia.org/wiki/Separating_axis_theorem
        //       "If the cross products were not used, certain edge-on-edge non-colliding cases would be treated as colliding."
        //       https://gamedev.stackexchange.com/questions/44500/how-many-and-which-axes-to-use-for-3d-obb-collision-with-sat
        for (let edgeA of this.edges) {
            for (let edgeB of other.edges) {
                let norm = vec3(0, 0, 0).crossVectors(edgeA, edgeB);
                if (norm.lengthSq() < 0.0001) {
                    // Edges parallel, ignore
                } else {
                    if (separatedByAxis(norm)) return false;
                }
            }
        }

        return true;
    }

    hasFaceContact(other: ConvexPolyhedron): boolean {
        const EPSILON = 0.001; // Err on the side of no contact
        for (let face of this.geometry.faces) {
            outer: for (let otherFace of other.geometry.faces) {
                // Check that normals are opposing
                if (face.normal.dot(otherFace.normal) > -0.98) continue;
                // Check that the two triangles are coplanar
                let normal = face.normal;
                if (Math.abs(this.geometry.vertices[face.a].dot(normal) - other.geometry.vertices[otherFace.a].dot(normal)) > 0.01) continue;
                // Check that the triangles overlap
                let selfVertices = [face.a, face.b, face.c].map(index => this.geometry.vertices[index]);
                let otherVertices = [otherFace.a, otherFace.b, otherFace.c].map(index => other.geometry.vertices[index]);
                // Using 2D separating axis test, the axes to test are `normal x (b - a)` for every same-triangle pair of vertices a and b.
                let axes: THREE.Vector3[] = [];
                function pushTrianglePlanarNormals(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
                    // `b - a` vs `a - b` doesn't matter here
                    axes.push(b.clone().sub(a).normalize().cross(normal));
                    axes.push(c.clone().sub(b).normalize().cross(normal));
                    axes.push(a.clone().sub(c).normalize().cross(normal));
                }
                pushTrianglePlanarNormals(selfVertices[0], selfVertices[1], selfVertices[2]);
                pushTrianglePlanarNormals(otherVertices[0], otherVertices[1], otherVertices[2]);
                for (let axis of axes) {
                    let [minA, maxA] = verticesSpan(selfVertices, axis);
                    let [minB, maxB] = verticesSpan(otherVertices, axis);
                    if (maxA <= minB + EPSILON || maxB <= minA + EPSILON) continue outer;
                }
                return true;
            }
        }
        return false;
    }

    volume(): number {
        // https://stackoverflow.com/questions/14186837/calculation-of-centroid-volume-of-a-polyhedron-when-the-vertices-are-given
        // http://wwwf.imperial.ac.uk/~rn/centroid.pdf
        // https://en.wikipedia.org/wiki/Polyhedron#Volume
        let sum = 0;
        for (let face of this.geometry.faces) {
            let [a, b, c] = [face.a, face.b, face.c].map(i => this.geometry.vertices[i]);
            sum += b.clone().sub(a).cross(c.clone().sub(a)).dot(a);
        }
        return sum / 6;
    }

    centroid(): THREE.Vector3 {
        // http://wwwf.imperial.ac.uk/~rn/centroid.pdf
        function multSelf(v: THREE.Vector3) {
            return v.multiply(v);
        }
        let sum = vec3(0, 0, 0);
        for (let face of this.geometry.faces) {
            let [a, b, c] = [face.a, face.b, face.c].map(i => this.geometry.vertices[i]);
            let n = b.clone().sub(a).cross(c.clone().sub(a));
            sum.add(n.divideScalar(24).multiply(
                multSelf(a.clone().add(b))
                .add(multSelf(b.clone().add(c)))
                .add(multSelf(c.clone().add(a)))
            ));
        }
        return sum.divideScalar(2 * this.volume());
    }

    boundingBox(): THREE.Box3 {
        return new THREE.Box3().setFromPoints(this.vertices);
    }
}

interface Projectile {
    update(deltaTime: number): boolean;
}
let projectiles: Projectile[] = [];
let dbgGrapplingHook: GrapplingHook|null = null;

let solidTrailMaterial = new THREE.MeshBasicMaterial({
    color: 0xffff00, transparent: true, opacity: 1.0 /*, blending: THREE.AdditiveBlending */
});
class SolidTrail {
    source: THREE.Mesh;
    segments: THREE.Mesh[];
    enabled: boolean = true;
    constructor(source: THREE.Mesh, numSegments: number, public alpha: number) {
        this.source = source;
        this.segments = [];
        for (let i = 0; i < numSegments; i += 1) {
            let mesh = new THREE.Mesh(this.source.geometry as THREE.Geometry, solidTrailMaterial.clone());
            solidTrailMaterial.color.copy((this.source.material as any).uniforms.diffuse.value.clone());
            scene.add(mesh);
            mesh.matrixAutoUpdate = false;
            mesh.layers.enable(MINIVIEW_LAYER);
            this.segments.push(mesh);
        }
    }
    remove() {
        for (let m of this.segments) {
            scene.remove(m);
        }
    }
    update() {
        let toGenerate = <THREE.Mesh>this.segments.shift();
        this.segments.push(toGenerate);
        for (let i = 0; i < this.segments.length; i++) {
            this.segments[i].material.opacity = this.alpha * (i + 1) / this.segments.length;
        }

        toGenerate.matrix.copy(this.source.matrixWorld);
        toGenerate.visible = this.enabled;
    }
}

let tooltip = new class {
    dom = document.querySelector("#tooltip")!;
    set(s: string) {
        let m = s.match(/\n */);
        let c: number;
        if (m == null) c = 0;
        else c = m[0].length - 1;
        this.dom.textContent = s.split("\n").slice(1).map(line => line.substr(c)).join("\n");
    }
};

interface Tool {
    update(deltaTime: number, cameraRay: THREE.Ray): void;
    enter(): void;
    exit(): void;
}

class PlaneIndicator {
    mesh: THREE.Mesh;
    static GEOMETRY = (() => {
        let geo = new THREE.Geometry();
        let identity = new THREE.Matrix4();
        let arrowGeo = new THREE.Geometry();
        arrowGeo.merge(new THREE.CubeGeometry(1, 1, 1).translate(0, 0, 0.5).scale(0.1, 0.1, 0.8), identity);
        arrowGeo.merge((worldsolids.convexHull3D(
            Array.from(range(4))
                .map(i => {
                    let angle = (i + 0.5) * Math.PI * 2 / 4;
                    return vec3(Math.cos(angle), Math.sin(angle), 0);
                })
            .concat(vec3(0, 0, 1))
        ) as THREE.Geometry).scale(0.2, 0.2, 0.2).translate(0, 0, 0.8), identity);
        arrowGeo.faces.forEach(face => face.color = new THREE.Color(0x00ffff));
        geo.merge(arrowGeo, identity);
        arrowGeo.rotateX(Math.PI);
        arrowGeo.faces.forEach(face => face.color = new THREE.Color(0xff9900));
        geo.merge(arrowGeo, identity);

        geo.computeBoundingSphere();
        geo.computeFlatVertexNormals();
        return geo;
    })();
    static MATERIAL = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: THREE.VertexColors });
    constructor(point: THREE.Vector3, normal: THREE.Vector3) {
        this.mesh = new THREE.Mesh(PlaneIndicator.GEOMETRY, PlaneIndicator.MATERIAL);
        this.mesh.position.copy(point);
        this.mesh.scale.setScalar(0.5);
        this.mesh.quaternion.setFromUnitVectors(vec3(0, 0, 1), normal);
        this.mesh.castShadow = this.mesh.receiveShadow = true;
        scene.add(this.mesh);
    }
    remove() {
        scene.remove(this.mesh);
    }
}

let planeTool = new class implements Tool {
    planes: { plane: THREE.Plane, indicator: PlaneIndicator }[] = [];
    mesh: THREE.Mesh;
    material: THREE.MeshStandardMaterial;
    constructor() {
        this.material = new THREE.MeshStandardMaterial({ color: 0x00ffff });
        this.mesh = new THREE.Mesh(new THREE.CubeGeometry(0.3, 0.3, 0.03, 1, 1, 1), this.material);
        this.mesh.castShadow = this.mesh.receiveShadow = true;
        this.mesh.position.set(0.5, 0, 0.15);
    }
    update(deltaTime: number, cameraRay: THREE.Ray) {
        this.mesh.rotation.x = toolRoll;
        if (justPressedKeys.has(VK.LEFT_MOUSE) || justPressedKeys.has(VK.RIGHT_MOUSE)) {
            let inverted = justPressedKeys.has(VK.RIGHT_MOUSE);
            let cast = raycastWorld(world, cameraRay, 10);
            if (cast != null) {
                let normal = cast[1].enterNormal;
                if (normal != null) {
                    if (inverted) {
                        normal = normal.clone().negate()
                    }
                    let point = cameraRay.at(cast[1].enterT);
                    this.planes.push({ plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point), indicator: new PlaneIndicator(point, normal) });
                }
            }
        }
        if (justPressedKeys.has(VK.Q)) {
            for (let p of this.planes) { p.indicator.remove(); }
            this.planes = [];
        }
        if (justPressedKeys.has(VK.E)) {
            let points = worldsolids.planesToVertices(this.planes.map(p => p.plane));
            dbgPoints.clear();
            for (let point of points) {
                dbgPoints.add(point);
            }
            let shape = ConvexPolyhedron.make(points);
            if (shape != null) {
                let solid = new WorldSolid();
                solid.attached = [];
                solid.isRoot = true;
                solid.color = randomColor();
                solid.shape = shape;
                world.add(solid);
                updateWorldMesh();
            }
        }
    }
    enter() {
        dbgPlayer.setToolMesh(this.mesh);
        tooltip.set(`
            Plane Tool
            Left click - add target plane
            Right click - add target plane * -1
            Q - clear planes
            E - conjure polyhedron from planes
        `);
    }
    exit() {
        dbgPlayer.setToolMesh(null);
    }
};

let sliceTool = new class implements Tool {
    mesh: THREE.Mesh;
    material: THREE.MeshStandardMaterial;
    storedPlane: THREE.Plane|null = null;
    constructor() {
        this.material = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
        this.mesh = new THREE.Mesh(new THREE.CubeGeometry(0.3, 0.015, 0.3, 1, 1, 1), this.material);
        this.mesh.castShadow = this.mesh.receiveShadow = true;
        this.mesh.position.set(0.5, 0, 0.15);
    }
    update(deltaTime: number, cameraRay: THREE.Ray) {
        this.mesh.rotation.x = toolRoll;
        this.mesh.rotation.y = gameTime * Math.PI * 2;
        if (justPressedKeys.has(VK.LEFT_MOUSE)) {
            let cameraPlaneNormal = vec3(1, 0, 0).transformDirection(camera.matrixWorld).normalize();
            cameraPlaneNormal.applyAxisAngle(camera.getWorldDirection(), toolRoll);
            let cuttingPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(cameraPlaneNormal, cameraRay.origin);
            let toCut = raycastWorld(world, cameraRay, 10);
            if (toCut != null) {
                world.slice(toCut[0], cuttingPlane);
                updateWorldMesh();
            }
        }
        if (justPressedKeys.has(VK.RIGHT_MOUSE)) {
            let toCut = raycastWorld(world, cameraRay, 10);
            if (toCut != null && toCut[1].enterNormal != null) {
                let cutPoint = cameraRay.at(toCut[1].enterT);
                let cutFaceNormal = toCut[1].enterNormal as THREE.Vector3; // Already checked that it's non-null
                let cuttingPlaneNormal = vec3(1, 0, 0).transformDirection(camera.matrixWorld).normalize();
                cuttingPlaneNormal.applyAxisAngle(camera.getWorldDirection(), toolRoll);
                cuttingPlaneNormal.addScaledVector(cutFaceNormal, -cutFaceNormal.dot(cuttingPlaneNormal)).normalize(); // Make cuttingPlaneNormal perpendicular to cutFaceNormal
                let cuttingPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(cuttingPlaneNormal, cutPoint);
                world.slice(toCut[0], cuttingPlane);
                updateWorldMesh();
            }
        }
        if (justPressedKeys.has(VK.Q)) {
            let cast = raycastWorld(world, cameraRay, 10);
            if (cast != null && cast[1].enterNormal != null) {
                this.storedPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(cast[1].enterNormal as THREE.Vector3, cameraRay.at(cast[1].enterT));
            }
        }
        if (justPressedKeys.has(VK.E)) {
            let toCut = raycastWorld(world, cameraRay, 10);
            if (toCut != null && this.storedPlane != null) {
                world.slice(toCut[0], this.storedPlane);
                updateWorldMesh();
            }
        }
    }
    enter() {
        dbgPlayer.setToolMesh(this.mesh);
        tooltip.set(`
            Slice Tool
            Left click - slice along view + roll
            Right click - slice along view + roll aligned to target face normal
            Q - store targeted plane
            E - slice with stored plane
        `);
    }
    exit() {
        dbgPlayer.setToolMesh(null);
    }
};

let weaponTool = new class implements Tool {
    update(deltaTime: number, cameraRay: THREE.Ray) {
        if (justPressedKeys.has(VK.LEFT_MOUSE) || justPressedKeys.has(VK.RIGHT_MOUSE) || justPressedKeys.has(VK.MIDDLE_MOUSE)) {
            if (!dbgPlayer.isAttacking && !dbgPlayer.isDodging) {
                dbgPlayer.isAttacking = true;
                dbgPlayer.attackT = 0;
                dbgPlayer.attackFacing = hFacing;
                // TODO: Maybe solve for attackVFacing where the animation's final hand offset would be in the center of the screen.
                //       That might not be what you'd want though, especially if there was a turn-around attack.
                dbgPlayer.attackVFacing = vFacing;
                placeSoundAbsolute(playSound("sounds/whiff.ogg"), dbgPlayer.weapon.mesh.getWorldPosition());
                if (justPressedKeys.has(VK.LEFT_MOUSE)) {
                    dbgPlayer.attackAnimation = rollableAttackAnimation(toolRoll); // overheadAttackAnimation;
                    dbgPlayer.attackDuration = 0.6;
                } else if (justPressedKeys.has(VK.RIGHT_MOUSE)) {
                    dbgPlayer.attackAnimation = rollableSidewaysAttackAnimation(toolRoll); // sidewaysAttackAnimation;
                    dbgPlayer.attackDuration = 0.75;
                } else {
                    dbgPlayer.attackAnimation = rollableStabAnimation(toolRoll);
                    dbgPlayer.attackDuration = 0.5;
                }
            }
        }
        if (!dbgPlayer.isAttacking && !dbgPlayer.isDodging) {
            dbgPlayer.isParrying = heldKeys.has(VK.LSHIFT);
        }
    }
    enter() {
        tooltip.set(`
            Weapon Tool
            Left click - Vertical
            Right click - Horizontal
            Middle click - Stab
            Shift - Block
        `);
    }
    exit() {}
};

let mergeTool = new class implements Tool {
    a: WorldSolid|null = null;
    b: WorldSolid|null = null;
    group: THREE.Group;
    meshA: THREE.Mesh;
    meshB: THREE.Mesh;
    material: THREE.MeshStandardMaterial;

    highlightMeshA: THREE.LineSegments|null;
    highlightMeshB: THREE.LineSegments|null;

    highlightMaterialA = new THREE.LineBasicMaterial({ color: "red", linewidth: 5 });
    highlightMaterialB = new THREE.LineBasicMaterial({ color: "blue", linewidth: 5 });
    constructor() {
        this.material = new THREE.MeshStandardMaterial({ color: 0x9900ff });
        this.group = new THREE.Group();
        this.group.position.set(0.5, 0, 0.15);
        this.meshA = new THREE.Mesh(new THREE.CubeGeometry(0.15, 0.08, 0.15, 1, 1, 1).translate(0, 0.04, 0), this.material);
        this.meshA.castShadow = this.meshA.receiveShadow = true;
        this.meshB = new THREE.Mesh(new THREE.CubeGeometry(0.15, 0.08, 0.15, 1, 1, 1).translate(0, -0.04, 0), this.material);
        this.meshB.castShadow = this.meshB.receiveShadow = true;
        this.group.add(this.meshA);
        this.group.add(this.meshB);
    }
    update(deltaTime: number, cameraRay: THREE.Ray) {
        this.group.rotation.x = toolRoll;
        this.meshA.position.y = Math.max(0, Math.cos(gameTime * Math.PI * 2) * 0.04);
        this.meshB.position.y = -this.meshA.position.y;
        if (justPressedKeys.has(VK.LEFT_MOUSE)) {
            if (this.highlightMeshA != null) { scene.remove(this.highlightMeshA); this.highlightMeshA = null; }
            this.a = selectSolid(world, cameraRay, 10);
            if (this.a != null) {
                this.highlightMeshA = new THREE.LineSegments(new THREE.EdgesGeometry(<any>this.a.shape.geometry, 1), this.highlightMaterialA);
                scene.add(this.highlightMeshA);
            }
        }
        if (justPressedKeys.has(VK.RIGHT_MOUSE)) {
            if (this.highlightMeshB != null) { scene.remove(this.highlightMeshB); this.highlightMeshB = null; }
            this.b = selectSolid(world, cameraRay, 10);
            if (this.b != null) {
                this.highlightMeshB = new THREE.LineSegments(new THREE.EdgesGeometry(<any>this.b.shape.geometry, 1), this.highlightMaterialB);
                scene.add(this.highlightMeshB);
            }
        }
        if (justPressedKeys.has(VK.MIDDLE_MOUSE)) {
            let v = selectVertex(world, cameraRay, 10, 0.5);
            if (v != null && this.a != null && worldOctreeHas(world.solids, this.a)) {
                if (world.addVertex(this.a, v)) {
                    this.a = null;
                    if (this.highlightMeshA != null) { scene.remove(this.highlightMeshA); this.highlightMeshA = null; }
                    updateWorldMesh();
                }
            }
        }
        if (justPressedKeys.has(VK.E)) {
            if (this.a != null
                && this.b != null
                && worldOctreeHas(world.solids, this.a)
                && worldOctreeHas(world.solids, this.b)
            ) {
                if (world.merge(this.a, this.b)) {
                    this.a = null;
                    this.b = null;
                    if (this.highlightMeshA != null) { scene.remove(this.highlightMeshA); this.highlightMeshA = null; }
                    if (this.highlightMeshB != null) { scene.remove(this.highlightMeshB); this.highlightMeshB = null; }
                    updateWorldMesh();
                }
            }
        }
    }
    enter() {
        if (this.highlightMeshA != null) { this.highlightMeshA.visible = true; }
        if (this.highlightMeshB != null) { this.highlightMeshB.visible = true; }
        dbgPlayer.setToolMesh(this.group);
        tooltip.set(`
            Merge Tool
            Left click - set solid A
            Right click - set solid B
            E - merge A & B
        `);
    }
    exit() {
        if (this.highlightMeshA != null) this.highlightMeshA.visible = false;
        if (this.highlightMeshB != null) this.highlightMeshB.visible = false;
        dbgPlayer.setToolMesh(null);
    }
};

let placeTool = new class implements Tool {
    clipboard: WorldSolid|null = null;
    attachSolid: WorldSolid|null = null;
    attachPoint: THREE.Vector3 = vec3(0, 0, 0);
    attachNormal: THREE.Vector3 = vec3(0, 0, 1);

    clipboardMesh: THREE.Mesh;
    clipboardRoot: THREE.Group;

    mesh: THREE.Mesh;

    highlightMesh: THREE.LineSegments;
    highlightMaterial = new THREE.LineBasicMaterial({ color: "white", linewidth: 5 });
    constructor() {
        let material = new THREE.MeshStandardMaterial({ color: 0x0000ff });
        this.mesh = new THREE.Mesh(new THREE.CubeGeometry(0.15, 0.15, 0.015, 1, 1, 1), material);
        this.mesh.castShadow = this.mesh.receiveShadow = true;
        this.mesh.position.set(0.5, 0, 0.15);
        this.clipboardMesh = new THREE.Mesh(new THREE.CubeGeometry(0.15, 0.15, 0.15), new THREE.MeshStandardMaterial({vertexColors: THREE.FaceColors}));
        this.clipboardRoot = new THREE.Group();
        this.mesh.add(this.clipboardRoot);
        this.clipboardRoot.add(this.clipboardMesh);
        this.clipboardRoot.position.set(0, 0, 0.15);
        this.clipboardMesh.visible = false;

        this.highlightMesh = new THREE.LineSegments(new THREE.EdgesGeometry(<any>this.clipboardMesh.geometry, 1), this.highlightMaterial);
        this.highlightMesh.visible = false;
        scene.add(this.highlightMesh);
    }
    update(deltaTime: number, cameraRay: THREE.Ray) {
        this.clipboardRoot.rotation.x = toolRoll;
        if (justPressedKeys.has(VK.Q)) {
            let s = selectSolid(world, cameraRay, 10);
            if (s != null) {
                this.clipboard = cloneSolidWithDependents(s);
                this.attachSolid = this.clipboard;

                this.clipboardMesh.geometry = makeGeometryFromSolid(this.clipboard);
                this.clipboardMesh.geometry.computeBoundingBox();
                let bbox = this.clipboardMesh.geometry.boundingBox;
                let bboxSize = bbox.max.clone().sub(bbox.min);
                let scale = 0.15 / Math.max(bboxSize.x, bboxSize. y, bboxSize.z);
                let bboxCenter = bbox.min.clone().lerp(bbox.max, 0.5);
                this.clipboardMesh.scale.setScalar(scale);
                this.clipboardMesh.position.copy(bboxCenter.clone().multiplyScalar(-scale));
                
                this.highlightMesh.geometry = new THREE.EdgesGeometry(<any>this.clipboardMesh.geometry, 1);
                this.highlightMesh.visible = true;
            }
        }
        if (heldKeys.has(VK.RIGHT_MOUSE) && this.clipboard != null) {
            let ray = cameraRay;
            let bestEnterTime = Infinity;
            for (let attachable of graphIterator(this.clipboard, t => t.attached)) {
                let attachIntersect = attachable.shape.raycast(ray, 10);
                if (attachIntersect != null && attachIntersect.enterNormal != null && attachIntersect.enterT < bestEnterTime) {
                    bestEnterTime = attachIntersect.enterT;
                    this.attachPoint = ray.at(attachIntersect.enterT);
                    this.attachNormal = attachIntersect.enterNormal;
                    this.attachSolid = attachable;
                    dbgPoints.clear();
                    dbgPoints.add(this.attachPoint);
                }
            }
        }
        if (this.attachSolid != null) {
            if (heldKeys.has(VK.LEFT_MOUSE)) {
                world.attachWith(this.attachSolid, this.attachPoint, this.attachNormal, cameraRay, toolRoll, true);
            }
            if (justReleasedKeys.has(VK.LEFT_MOUSE)) {
                world.attachWith(this.attachSolid, this.attachPoint, this.attachNormal, cameraRay, toolRoll, false);
                updateWorldMesh();
            }
        }
    }
    enter() {
        this.clipboardMesh.visible = true;
        this.highlightMesh.visible = true;
        dbgAttachMesh.visible = true;
        dbgPlayer.setToolMesh(this.mesh);
        tooltip.set(`
            Place Tool
            Left click - place solid
            Right click - pick clipboard solid's attach point
            Q - set clipboard solid
        `);
    }
    exit() {
        this.clipboardMesh.visible = false;
        this.highlightMesh.visible = false;
        dbgAttachMesh.visible = false;
        dbgPlayer.setToolMesh(null);
    }
};

let grapplingTool = new class implements Tool {
    mesh: THREE.Mesh;
    constructor() {
        let material = new THREE.MeshStandardMaterial({ color: 0xff9900 });
        this.mesh = new THREE.Mesh(new THREE.CubeGeometry(0.075, 0.075, 0.3, 1, 1, 1), material);
        this.mesh.castShadow = this.mesh.receiveShadow = true;
        this.mesh.position.set(0.5, 0, 0.15);
    }
    update(deltaTime: number, cameraRay: THREE.Ray) {
        this.mesh.rotation.x = toolRoll;
        if (justPressedKeys.has(VK.LEFT_MOUSE)) {
            if (dbgGrapplingHook != null) {
                dbgGrapplingHook.remove();
            }
            dbgGrapplingHook = new GrapplingHook(cameraRay.origin, cameraRay.direction.clone().multiplyScalar(100));
            dbgGrapplingHook.arrow.mesh.add(playSound("sounds/thoomp.ogg"));
        }
        if (dbgGrapplingHook != null) {
            let ropeFactor = heldKeys.has(VK.LSHIFT) ? 2 : 30;
            if (heldKeys.has(VK.E)) {
                dbgGrapplingHook.extend(-ropeFactor * deltaTime, dbgPlayer.position);
            }
            if (heldKeys.has(VK.Q)) {
                dbgGrapplingHook.extend(ropeFactor * deltaTime, dbgPlayer.position);
            }
            if (justPressedKeys.has(VK.RIGHT_MOUSE)) {
                dbgGrapplingHook.remove();
                dbgGrapplingHook = null;
            }
        }
    }
    enter() {
        dbgPlayer.setToolMesh(this.mesh);
        tooltip.set(`
            Grapple Tool
            Left click - fire hook
            Right click - release hook
            Q - slack
            E - pull in
        `);
    }
    exit() {
        dbgPlayer.setToolMesh(null);
    }
};

let deleteTool = new class implements Tool {
    material: THREE.MeshStandardMaterial;
    mesh: THREE.Mesh;
    constructor() {
        this.material = new THREE.MeshStandardMaterial({ color: 0xff0000 });
        this.mesh = new THREE.Mesh(new THREE.CubeGeometry(0.15, 0.15, 0.15, 1, 1, 1), this.material);
        this.mesh.castShadow = this.mesh.receiveShadow = true;
        this.mesh.position.set(0.5, 0, 0.15);
        this.material.transparent = true;
        this.material.opacity = 0.5;
    }
    update(deltaTime: number, cameraRay: THREE.Ray) {
        this.mesh.rotation.x = toolRoll;
        this.material.opacity = (Math.cos(gameTime * Math.PI * 2) + 1) / 2;
        if (justPressedKeys.has(VK.LEFT_MOUSE)) {
            let s = selectSolid(world, cameraRay, 10);
            console.log("Removing", s);
            if (s != null) {
                world.remove(s);
                updateWorldMesh();
            }
        }
        if (justPressedKeys.has(VK.MIDDLE_MOUSE)) {
            let s = selectSolid(world, cameraRay, 10);
            let v = selectVertex(world, cameraRay, 10, 0.5);
            if (s != null && v != null) {
                world.deleteVertex(s, v);
                updateWorldMesh();
            }
        }
    }
    enter() {
        dbgPlayer.setToolMesh(this.mesh);
        tooltip.set(`
            Delete Tool
            Left click - delete solid
            Middle click - delete vertex
        `);
    }
    exit() {
        dbgPlayer.setToolMesh(null);
    }
};

let paintTool = new class implements Tool {
    clipboard: THREE.Color = new THREE.Color(0xff0000);
    mesh: THREE.Mesh;
    material: THREE.MeshStandardMaterial;
    constructor() {
        this.material = new THREE.MeshStandardMaterial({ color: 0 });
        this.mesh = new THREE.Mesh(new THREE.CubeGeometry(0.15, 0.15, 0.15, 1, 1, 1), this.material);
        this.mesh.castShadow = this.mesh.receiveShadow = true;
        this.mesh.position.set(0.5, 0, 0.15);
    }
    update(deltaTime: number, cameraRay: THREE.Ray) {
        this.mesh.rotation.x = toolRoll;
        if (justPressedKeys.has(VK.RIGHT_MOUSE)) {
            let s = selectSolid(world, cameraRay, 10);
            if (s != null) {
                this.clipboard = s.color;
                this.material.color.copy(this.clipboard);
            }
        }
        if (justPressedKeys.has(VK.LEFT_MOUSE)) {
            let s = selectSolid(world, cameraRay, 10);
            if (s != null) {
                s.color = this.clipboard;
                updateWorldMesh();
            }
        }
    }
    enter() {
        dbgPlayer.setToolMesh(this.mesh);
        tooltip.set(`
            Paint Tool
            Left click - set color
            Right click - pick color from solid
        `);
    }
    exit() {
        dbgPlayer.setToolMesh(null);
    }
};

function cyclicPermutations<T>(ts: T[]): T[][] {
    let r: T[][] = [];
    for (let start = 0; start < ts.length; start++) {
        r.push(ts.slice(start).concat(ts.slice(0, start)));
    }
    return r;
}
function flatten<T>(tss: T[][]): T[] {
    let r: T[] = [];
    for (let ts of tss) {
        for (let t of ts) {
            r.push(t);
        }
    }
    return r;
}
let icosahedronVertices: THREE.Vector3[];
{
    let p = (1 + Math.sqrt(5)) / 2;
    icosahedronVertices = flatten([[0, 1, p], [0, 1, -p], [0, -1, p], [0, -1, -p]].map(cyclicPermutations)).map(([a, b, c]) => vec3(a, b, c));
}

type Curve = (t: number) => THREE.Vector3;
function lerp(a: THREE.Vector3, b: THREE.Vector3): Curve {
    return (t: number) => a.clone().lerp(b, t);
}
function quadraticBezier(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): Curve {
    return (t: number) => {
        let ab = a.clone().lerp(b, t);
        let bc = b.clone().lerp(c, t);
        return ab.lerp(bc, t);
    };
}
function cubicBezier(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): Curve {
    let c1 = quadraticBezier(a, b, c);
    let c2 = quadraticBezier(b, c, d);
    return (t: number) => c1(t).lerp(c2(t), t);
}
function spedUp(curve: Curve): Curve {
    return (t: number) => curve(t * t);
}

function shatterPolyhedron(polyhedron: ConvexPolyhedron, point: THREE.Vector3): ConvexPolyhedron[] {
    let pieces: ConvexPolyhedron[] = [];
    for (let f of polyhedron.geometry.faces) {
        let [a, b, c] = [f.a, f.b, f.c].map(i => polyhedron.geometry.vertices[i]);
        pieces.push(new ConvexPolyhedron([point, a, b, c]));
    }
    return pieces;
}

function randomRange(low: number, high: number) {
    return low + Math.random() * (high - low);
}

function makeDeathParticlesFromVertices(convexHull: THREE.Vector3[], material: THREE.Material, velocity: THREE.Vector3, repulsionCenter: THREE.Vector3) {
    let cp = new ConvexPolyhedron(convexHull);
    let centroid = cp.centroid();
    let parts = shatterPolyhedron(cp, centroid);
    for (let part of parts) {
        let partCentroid = part.centroid();
        let repulsion = partCentroid.clone().sub(repulsionCenter);
        let partVelocity = partCentroid.clone().sub(centroid).normalize().multiplyScalar(1.0)
            .addScaledVector(repulsion, 1 / repulsion.lengthSq())
            .addScaledVector(randomUnitVector(), 0.1)
            .add(velocity);
        // let partVelocity = velocity.clone();
        let mesh = new THREE.Mesh(part.geometry.clone().translate(-partCentroid.x, -partCentroid.y, -partCentroid.z), material);
        mesh.position.copy(partCentroid);
        scene.add(mesh);
        particles.push(new MeshParticle(mesh, partVelocity, randomUnitVector().multiplyScalar(randomRange(1.0, 3.0)), randomRange(2, 4)));
        // particles.push(new MeshParticle(mesh, partVelocity, vec3(0, 0, 0), 4));
    }
}
function makeDeathParticle(convexHull: THREE.Vector3[], material: THREE.Material, velocity: THREE.Vector3, repulsionCenter: THREE.Vector3) {
    let cp = new ConvexPolyhedron(convexHull);
    let centroid = cp.centroid();
    let mesh = new THREE.Mesh(cp.geometry.clone().translate(-centroid.x, -centroid.y, -centroid.z), material);
    mesh.position.copy(centroid);
    let repulsion = centroid.clone().sub(repulsionCenter);
    let partVelocity = vec3(0, 0, 0)
        .addScaledVector(repulsion, 1 / repulsion.lengthSq())
        .addScaledVector(randomUnitVector(), 0.1)
        .add(velocity);
    scene.add(mesh);
    particles.push(new MeshParticle(mesh, velocity.clone(), randomUnitVector().multiplyScalar(randomRange(1.0, 3.0)), randomRange(2, 4)));
}

export function makeDeathParticles(combatant: Combatant, shatter: THREE.Mesh, velocity: THREE.Vector3, repulsionCenter: THREE.Vector3) {
    for (let root of [combatant.torso.mesh, combatant.head.mesh]) {
        root.traverseVisible((obj: any) => {
            if (obj.isMesh) {
                let mesh = obj as THREE.Mesh;
                if (mesh.geometry instanceof THREE.Geometry) {
                    if (mesh === shatter) {
                        let points = mesh.geometry.vertices.map(v => v.clone().applyMatrix4(mesh.matrixWorld));
                        makeDeathParticlesFromVertices(points, mesh.material, velocity, repulsionCenter);
                    } else {
                        let points = mesh.geometry.vertices.map(v => v.clone().applyMatrix4(mesh.matrixWorld));
                        makeDeathParticle(points, mesh.material, velocity, repulsionCenter);
                    }
                }
            }
        });
    }
}

interface FireballPiece {
    mesh: THREE.Mesh;
    restingPosition: THREE.Vector3;
    animOffset: number;
}
class FireballEffect {
    static COLOR = 0xff3300;
    static MATERIAL = new THREE.MeshStandardMaterial({ color: FireballEffect.COLOR, emissive: new THREE.Color(FireballEffect.COLOR), emissiveIntensity: 0.5 });
    static COLLISION = new ConvexPolyhedron(icosahedronVertices.map(p => p.clone().multiplyScalar(0.06)));
    group: THREE.Group = new THREE.Group();
    meshes: FireballPiece[] = [];
    centroid: THREE.Vector3;
    constructor() {
        let polyhedron = FireballEffect.COLLISION;
        let centroid = polyhedron.centroid();
        this.centroid = centroid;
        for (let piece of shatterPolyhedron(polyhedron, centroid)) {
            let pieceCentroid = piece.centroid();
            let pieceMesh = new THREE.Mesh(piece.geometry.clone().translate(-pieceCentroid.x, -pieceCentroid.y, -pieceCentroid.z), FireballEffect.MATERIAL);
            pieceMesh.position.copy(pieceCentroid);
            this.group.add(pieceMesh);
            this.meshes.push({
                mesh: pieceMesh,
                restingPosition: pieceCentroid,
                animOffset: Math.random() * Math.PI * 2,
            });
        }
    }
    setExploded(t: number) {
        for (let piece of this.meshes) {
            let offset = piece.restingPosition.clone().sub(this.centroid);
            piece.mesh.position.copy(piece.restingPosition.clone().add(offset.multiplyScalar(t)));
            let scale = 1 - t;
            //let scale = (1 - t) * 0.9;
            //piece.mesh.scale.setScalar(scale * (1 - (Math.cos(piece.animOffset + gameTime * Math.PI) * 0.5 + 0.5) * 0.3));
            piece.mesh.scale.setScalar(scale);
        }
    }
    shedPiece(vel: THREE.Vector3) {
        if (this.meshes.length === 0) return;
        let {mesh, restingPosition} = this.meshes.splice(Math.floor(Math.random() * this.meshes.length), 1)[0];
        let pos = mesh.getWorldPosition();
        let rot = mesh.getWorldQuaternion();
        scene.add(mesh);
        mesh.position.copy(pos);
        mesh.quaternion.copy(rot);
        particles.push(new MeshParticle(
            mesh,
            restingPosition.clone().normalize().multiplyScalar(5).addScaledVector(randomUnitVector(), 2).add(vel),
            randomUnitVector().multiplyScalar(Math.random() * 2 + 1),
            1 + Math.random()
        ));
    }
}
function unlerp(a: number, b: number, v: number): number {
    return (v - a) / (b - a);
}
class MeshParticle implements Particle {
    ttl: number;
    constructor(public mesh: THREE.Mesh, public velocity: THREE.Vector3, public angularVelocity: THREE.Vector3, public startTtl: number) {
        this.ttl = startTtl;
    }
    update(deltaTime: number): boolean {
        this.ttl -= deltaTime;
        let start = this.mesh.position.clone();
        let end = start.clone().addScaledVector(this.velocity, deltaTime);
        let ray = new THREE.Ray(start.clone(), end.clone().sub(start).normalize());
        let raycast = raycastWorld(world, ray, end.clone().sub(start).length());
        if (raycast != null && raycast[1].enterNormal != null) {
            end = ray.at(raycast[1].enterT);
            this.velocity.reflect(raycast[1].enterNormal! /* Already checked for null */).multiplyScalar(0.5);
        }
        this.mesh.rotateOnAxis(this.angularVelocity.clone().normalize(), this.angularVelocity.length() * deltaTime);
        this.mesh.position.addScaledVector(this.velocity, deltaTime);
        this.mesh.scale.setScalar(this.ttl / this.startTtl);
        this.velocity.addScaledVector(vec3(0, 0, -3), deltaTime);
        if (this.ttl <= 0) {
            this.mesh.parent.remove(this.mesh);
            return false;
        }
        return true;
    }
}
class FireballProjectile implements Projectile {
    root: THREE.Group;
    effect: FireballEffect;
    hitbox: ConvexShape;
    path: Curve;
    duration: number = 1;
    t: number = 0;
    constructor(orientation: THREE.Quaternion, path: Curve) {
        this.path = path;
        this.effect = new FireballEffect();
        this.hitbox = new ConvexShape(new THREE.Mesh(FireballEffect.COLLISION.geometry, new THREE.MeshBasicMaterial()));
        this.hitbox.mesh.visible = false;
        this.root = new THREE.Group();
        this.root.add(this.effect.group);
        this.root.add(this.hitbox.mesh);
        this.root.quaternion.copy(orientation);
        this.root.position.copy(this.path(0));
        this.root.updateMatrixWorld(true);
        scene.add(this.root);
    }
    private explode(vel: THREE.Vector3) {
        scene.remove(this.root);
        while (this.effect.meshes.length > 0) {
            this.effect.shedPiece(vel);
        }
    }
    update(deltaTime: number): boolean {
        this.t += deltaTime / this.duration;

        if (Math.random() < probInterval(0.5, deltaTime * 10)) {
            this.effect.shedPiece(this.path(this.t).sub(this.path(this.t - 0.01)).divideScalar(0.01));
        }

        if (this.t > 1) {
            this.explode(this.path(1).sub(this.path(0.99)).divideScalar(0.01));
            return false;
        }

        if (collidesWorld(world, this.hitbox)) {
            this.explode(this.path(this.t).sub(this.path(this.t - 0.01)).divideScalar(0.01));
            return false;
        }

        let contact: [Combatant, ConvexShape, THREE.Vector3]|null = null;
        for (let targetHitbox of getAllHitboxes()) {
            let pc = targetHitbox.shape;
            if (this.hitbox.overlaps(pc)) {
                let p = this.hitbox.worldContactPoint(pc);
                if (p != null) {
                    contact = [targetHitbox.combatant, pc, p];
                    break;
                }
            }
        }
        if (contact != null) {
            let [contactCombatant, contactShape, contactPoint] = contact;
            let dir = contactCombatant.position.clone().sub(contactPoint).setZ(0).normalize();
            contactCombatant.velocity.add(dir.clone().multiplyScalar(10));
            this.explode(dir.clone().multiplyScalar(-2));
            return false;
        }

        this.effect.setExploded(0);
        this.root.position.copy(this.path(this.t));
        this.root.rotation.x += Math.PI * 5 * deltaTime;
        return true;
    }
}

let dbgPlayerSpeedModifier = 1;
let fireballTool = new class implements Tool {
    mesh: THREE.Group;
    holdTime: number;
    fireball: FireballEffect;
    constructor() {
        this.mesh = new THREE.Group();
        this.mesh.position.set(0.5, 0, 0.15);
        this.fireball = new FireballEffect();
        this.mesh.add(this.fireball.group);
    }
    update(deltaTime: number, cameraRay: THREE.Ray) {
        this.mesh.rotation.x = toolRoll;
        if (heldKeys.has(VK.LEFT_MOUSE)) {
            this.holdTime += deltaTime * 2;
            dbgPlayerSpeedModifier = 0.2;
        } else {
            dbgPlayerSpeedModifier = 1;
        }
        if (this.holdTime > 1) {
            this.holdTime = 0;
            let endPoint = cameraRay.at(10);
            let startPoint = this.fireball.group.getWorldPosition();
            let dir = endPoint.clone().sub(startPoint).normalize();
            let midPoint = startPoint.clone().lerp(endPoint, 0.5);
            // let bendPoint = midPoint.clone().add(dir.clone().cross(randomUnitVector()).normalize().multiplyScalar(5));
            let cameraPlaneNormal = vec3(0, 1, 0).transformDirection(camera.matrixWorld).normalize();
            cameraPlaneNormal.applyAxisAngle(camera.getWorldDirection(), toolRoll);
            let bendPoint = midPoint.clone().addScaledVector(cameraPlaneNormal, 1.5);
            projectiles.push(new FireballProjectile(this.fireball.group.getWorldQuaternion(), spedUp(quadraticBezier(startPoint, bendPoint, endPoint))));
        }
        if (justReleasedKeys.has(VK.LEFT_MOUSE) && this.holdTime > 1) {
            // projectiles.push(new Arrow(cameraRay.origin, cameraRay.direction.clone().multiplyScalar(100 * this.holdTime), 20));
        }
        if (!heldKeys.has(VK.LEFT_MOUSE)) {
            this.holdTime = 0;
        }
        let animT = 1 - clamp(this.holdTime, 0, 1);
        if (animT === 1) {
            this.fireball.group.visible = false;
        } else {
            this.fireball.setExploded(animT);
            this.fireball.group.visible = true;
        }
        this.mesh.position.copy(vec3(0.6, 0, 0.3).applyAxisAngle(vec3(0, 1, 0), -dbgPlayer.vFacing));
        this.mesh.rotation.z = (Math.cos(animT * Math.PI) * 0.5 + 0.5) * Math.PI + this.holdTime;
    }
    enter() {
        dbgPlayer.setToolMesh(this.mesh);
        tooltip.set(`
            Fireball Tool
            Left click - channel fireball
        `);
    }
    exit() {
        dbgPlayer.setToolMesh(null);
    }
};

let activeTool: Tool = weaponTool;

let toolMap: {[index: number]: Tool} = {
    1: weaponTool,
    2: sliceTool,
    3: mergeTool,
    4: placeTool,
    5: grapplingTool,
    6: deleteTool,
    7: paintTool,
    8: planeTool,
    9: fireballTool,
};

function randomUnitVector(): THREE.Vector3 {
    let z = Math.random() * 2 - 1;
    let a = Math.random() * Math.PI * 2;
    let s = Math.sqrt(1 - z * z);
    let x = Math.cos(a) * s;
    let y = Math.sin(a) * s;
    return vec3(x, y, z);
}

let particles: Particle[] = [];
interface Particle {
    update(deltaTime: number): boolean;
}

class PlayerHitIndicatorParticle {
    mesh: THREE.Mesh;
    material: THREE.Material;
    ttl: number = 1;
    constructor(position: THREE.Vector3) {
        this.material = new THREE.MeshBasicMaterial({ color: "red", transparent: true, opacity: 1 });
        this.mesh = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 10), this.material);
        scene.add(this.mesh);
        this.mesh.layers.disable(MAIN_LAYER);
        this.mesh.layers.enable(MINIVIEW_LAYER);
        this.mesh.position.copy(position);
    }
    update(deltaTime: number): boolean {
        this.material.opacity = this.ttl;
        this.ttl -= deltaTime;
        if (this.ttl <= 0) {
            scene.remove(this.mesh);
            return false;
        }
        return true;
    }
}

class TetrahedronParticle implements Particle {
    mesh: THREE.Mesh;
    velocity: THREE.Vector3;
    angularVelocity: THREE.Vector3;
    startTtl: number;
    constructor(public ttl: number, public radius: number, position: THREE.Vector3, material: THREE.Material, velocity: THREE.Vector3, enableShadows: boolean) {
        let geo = new THREE.TetrahedronGeometry(1.0);
        this.startTtl = ttl;
        geo.computeBoundingSphere();
        geo.computeFlatVertexNormals();
        this.mesh = new THREE.Mesh(geo, material);
        this.mesh.castShadow = this.mesh.receiveShadow = enableShadows;
        this.mesh.scale.setScalar(radius);
        this.mesh.rotation.set(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2);
        this.mesh.position.copy(position);
        this.velocity = velocity.clone();
        this.angularVelocity = randomUnitVector().multiplyScalar(Math.random() * 2 + 1);
        scene.add(this.mesh);
    }
    update(deltaTime: number): boolean {
        this.ttl -= deltaTime;
        let start = this.mesh.position.clone();
        let end = start.clone().addScaledVector(this.velocity, deltaTime);
        let ray = new THREE.Ray(start.clone(), end.clone().sub(start).normalize());
        let raycast = raycastWorld(world, ray, end.clone().sub(start).length());
        if (raycast != null && raycast[1].enterNormal != null) {
            end = ray.at(raycast[1].enterT);
            this.velocity.reflect(raycast[1].enterNormal! /* Already checked for null */).multiplyScalar(0.5);
        }
        this.mesh.scale.setScalar(this.ttl / this.startTtl * this.radius);
        this.mesh.position.copy(end);
        this.mesh.rotateOnAxis(this.angularVelocity.clone().normalize(), this.angularVelocity.length() * deltaTime);
        this.velocity.addScaledVector(vec3(0, 0, -3), deltaTime);
        if (this.ttl <= 0) {
            scene.remove(this.mesh);
            return false;
        }
        return true;
    }
}

let bloodParticleMaterial = new THREE.MeshStandardMaterial({ color: 0xff0000, metalness: 0.2, roughness: 0.0 });
let clashParticleMaterial = new THREE.MeshStandardMaterial({ color: 0xffff00, metalness: 0.6, roughness: 0.0, emissive: new THREE.Color(0xffff00), emissiveIntensity: 0.5 });

function* range(n: number): IterableIterator<number> {
    for (let i = 0; i < n; i++) {
        yield i;
    }
}
function zip<T,U>(t: Iterable<T>, u: Iterable<U>): IterableIterator<[T,U]>;
function* zip<T>(...ts: Iterable<T>[]): IterableIterator<T[]> {
    let iters = ts.map(t => t[Symbol.iterator]());
    while (true) {
        let rs = iters.map(iter => iter.next());
        if (rs.some(r => r.done)) return;
        yield rs.map(r => r.value);
    }
}
function* enumerate<T>(t: Iterable<T>): IterableIterator<[number,T]> {
    yield* zip(range(Infinity), t);
}
function* reverse<T>(t: Iterable<T>): IterableIterator<T> {
    yield* Array.from(t).reverse();
}

let digitFont = `
### ##  ### ### # # ### ### ### ### ###        
# #  #    #   # # # #   #     # # # # #        
# #  #  ### ### ### ### ###   # ### ###     ###
# #  #  #     #   #   # # #   # # #   #        
### ### ### ###   # ### ###   # ###   #  #     
`.trim();
let digitChars = "0123456789.-";
let digitGeo = new Map<string, THREE.Geometry>();

{
    let lines = digitFont.split("\n");
    function getDigitGeo(i: number) {
        let rows = lines.map(line => line.substr(i * 4, 3));
        let boxes: THREE.Geometry[] = [];
        for (let row = 0; row < 5; row++) {
            for (let col = 0; col < 3; col++) {
                if (rows[row][col] === "#") {
                    boxes.push(new THREE.CubeGeometry(1, 1, 1).translate(col, 4 -row, 0));
                }
            }
        }
        let charGeometry = new THREE.Geometry();
        let identity = new THREE.Matrix4();
        for (let box of boxes) {
            charGeometry.merge(box, identity);
        }
        return charGeometry;
    }
    for (let [i, c] of enumerate(digitChars)) {
        digitGeo.set(c, getDigitGeo(i));
    }
    digitGeo.set(" ", new THREE.Geometry());
}

function lpad(s: string, padChar: string, length: number) {
    while (s.length < length) {
        s = padChar + s;
    }
    return s;
}

let dbgRuler = new class Ruler {
    start = vec3(0, 0, 0);
    end = vec3(0, 0, 0);
    mesh: THREE.Mesh;

    textMesh: THREE.Group;
    textChars: THREE.Mesh[];
    constructor() {
        this.mesh = new THREE.Mesh(new THREE.CubeGeometry(1, 1, 1).translate(0, 0, 0.5), new THREE.MeshStandardMaterial({ color: 0x0000ff }));
        this.mesh.castShadow = this.mesh.receiveShadow = true;
        scene.add(this.mesh);

        this.textMesh = new THREE.Group();
        scene.add(this.textMesh);
        this.textMesh.scale.setScalar(0.02);
        let charMaterial = new THREE.MeshStandardMaterial({color: 0x0000ff});
        this.textChars = Array.from("0000.00").map((c, i) => {
            let mesh = new THREE.Mesh(digitGeo.get(c), charMaterial);
            mesh.position.set(4 * i + 0.5 - 7 * 4, 0.5 + 2.5, 0.5);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            this.textMesh.add(mesh);
            return mesh;
        });
    }
    updateLength(normal: THREE.Vector3) {
        let start = this.start;
        let end = this.end;
        let dir = end.clone().sub(start);
        let d = dir.length();

        this.mesh.position.copy(start);
        this.mesh.scale.set(0.04, 0.04, d);
        this.mesh.lookAt(this.end);
        
        let txt = lpad(d.toFixed(2), " ", this.textChars.length);
        for (let [c, m] of zip(reverse(txt), reverse(this.textChars))) {
            m.geometry = digitGeo.get(c) as THREE.Geometry;
        }
        this.textMesh.position.copy(end);

        this.textMesh.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(vec3(0, 0, 1), normal));
        let dirN = dir.clone().normalize();
        let xAxis = vec3(1, 0, 0).applyQuaternion(this.textMesh.quaternion);
        function removeComponent(v: THREE.Vector3, axis: THREE.Vector3): THREE.Vector3 {
            return v.clone().addScaledVector(axis, -v.dot(axis));
        }
        dirN = removeComponent(dirN, normal).normalize();
        xAxis = removeComponent(xAxis, normal).normalize();
        let angle = Math.acos(dirN.dot(xAxis));
        let sign = dirN.clone().cross(xAxis).dot(normal) > 0 ? -1 : 1;
        angle *= sign;
        this.textMesh.rotateZ(angle);

        if (vec3(0, 1, 0).applyQuaternion(this.textMesh.quaternion).z < 0) {
            this.textMesh.rotateZ(Math.PI);
        }
    }
    setStart(p: THREE.Vector3) {
        this.start = p;
        this.updateLength(vec3(0, 0, 1));
    }
    setEnd(p: THREE.Vector3, normal: THREE.Vector3) {
        this.end = p;
        this.updateLength(normal);
    }
};

let combatants: Combatant[] = [];
function* getAllHitboxes() {
    for (let c of combatants) {
        if (c.isParrying || c.isAttacking) {
            yield { shape: c.weapon, combatant: c };
        }
        yield { shape: c.head, combatant: c };
        yield { shape: c.torso, combatant: c };
    }
}

function* pairs<T>(ts: T[]): IterableIterator<[T, T]> {
    for (let i = 0; i < ts.length; i++) {
        for (let j = i + 1; j < ts.length; j++) {
            yield [ts[i], ts[j]];
        }
    }
}

interface OrientationTransition {
    from: THREE.Quaternion,
    to: THREE.Quaternion,
    t: number,
}
let orientationTransition: OrientationTransition|null = null;

function setCameraRotation(camera: THREE.Camera, hFacing: number, vFacing: number) {
    camera.rotation.set(0, 0, 0);
    camera.rotateOnAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    camera.rotateOnAxis(new THREE.Vector3(0, 1, 0), hFacing - Math.PI / 2);
    camera.rotateOnAxis(new THREE.Vector3(1, 0, 0), vFacing);
}

export let secondsPerInGameDay = 60 * 30;
function tickGame(deltaTime: number) {
    gameTime += deltaTime;
    for (let c of combatants) {
        c.torso.recordTransform();
        c.head.recordTransform();
        c.weapon.recordTransform();
    }

    // Update camera rotation from mouse movement
    setCameraRotation(camera, hFacing, vFacing);
    camera.updateMatrixWorld(true);
    
    if (justPressedKeys.has(VK.F)) {
        let oldForward = vec3(0, 0, -1).transformDirection(camera.matrixWorld);
        orientationTransition = {
            from: dbgPlayer.root.quaternion.clone(),
            to: new THREE.Quaternion().setFromUnitVectors(vec3(0, 0, -1), oldForward),
            t: 0,
        };
    }
    if (justPressedKeys.has(VK.H)) {
        orientationTransition = {
            from: dbgPlayer.root.quaternion.clone(),
            to: new THREE.Quaternion(),
            t: 0,
        };
    }
    if (orientationTransition != null) {
        let oldUp = vec3(0, 1, 0).transformDirection(camera.matrixWorld);
        let oldForward = vec3(0, 0, -1).transformDirection(camera.matrixWorld);

        orientationTransition.t = Math.min(1, orientationTransition.t + deltaTime);
        dbgPlayer.root.quaternion.copy(orientationTransition.from).slerp(orientationTransition.to, orientationTransition.t);
        for (let c of combatants) {
            if (c !== dbgPlayer) c.root.quaternion.copy(dbgPlayer.root.quaternion);
        }

        // Make the camera face the same direction as before
        // For every direction and orientation there exists at least one hFacing/vFacing combination to point in that direction
        let playerUp = vec3(0, 0, 1).applyQuaternion(dbgPlayer.root.quaternion);
        vFacing = Math.PI / 2 - Math.acos(playerUp.dot(oldForward));
        // Update camera rotation with new vFacing
        setCameraRotation(camera, hFacing, vFacing);
        camera.updateMatrixWorld(true);

        if (orientationTransition.t >= 1) {
            orientationTransition = null;
        }
    }

    activeSounds = activeSounds.filter(audio => {
        if (!audio.isPlaying) {
            audio.parent.remove(audio);
            return false;
        }
        return true;
    });

    let cameraRay = new THREE.Ray(camera.getWorldPosition(), camera.getWorldDirection());
    dbgPlayer.isParrying = false;

    let nextActiveTool: Tool|null = null;
    for (let key in toolMap) {
        if (justPressedKeys.has(VK[key])) {
            nextActiveTool = toolMap[key];
        }
    }

    if (nextActiveTool != null && nextActiveTool != activeTool) {
        activeTool.exit();
        activeTool = nextActiveTool;
        activeTool.enter();
    }
    activeTool.update(deltaTime, cameraRay);

    if (justPressedKeys.has(VK.N)) {
        if (dbgNormals != null) {
            scene.remove(dbgNormals);
            dbgNormals = null;
        } else {
            dbgNormals = new THREE.FaceNormalsHelper(worldMesh);
            scene.add(dbgNormals);
        }
    }

    if (heldKeys.has(VK.R)) {
        let r = raycastWorld(world, cameraRay, 10);
        if (r != null) {
            let p = cameraRay.at(r[1].enterT);
            if (justPressedKeys.has(VK.R)) {
                dbgRuler.setStart(p);
            } else  {
                dbgRuler.setEnd(p, r[1].enterNormal || vec3(0, 0, 1));
            }
        }
    }

    if (justPressedKeys.has(VK.V)) {
        // dbgDebugMesh.geometry = new THREE.FaceNormalsHelper(<any>worldMesh.geometry, Math.PI * 2 / 360);
        worldMaterial.wireframe = !worldMaterial.wireframe;
        worldMaterial.wireframeLinewidth = 4;
    }

    if (justPressedKeys.has(VK.K)) {
        let s = selectSolid(world, cameraRay, 10);
        if (s != null) {
            s.isRoot = !s.isRoot;
            updateWorldMesh();
        }
    }

    if (justPressedKeys.has(VK.L)) {
        updateWorldMesh();
    }

    let playerForward = vec3(0, 1, 0).transformDirection(dbgPlayer.root.matrixWorld);
    let playerRight = vec3(1, 0, 0).transformDirection(dbgPlayer.root.matrixWorld);
    let playerUp = vec3(0, 0, 1).transformDirection(dbgPlayer.root.matrixWorld);
    let kbd = keyboardVel().rotateAround(new THREE.Vector2(), hFacing);
    let velocity = vec3(0, 0, 0).addScaledVector(playerForward, kbd.y).addScaledVector(playerRight, kbd.x).normalize().multiplyScalar(dbgPlayerSpeedModifier * 3 * deltaTime);
    if (heldKeys.has(VK.LSHIFT) && activeTool !== weaponTool) {
        velocity.divideScalar(10);
    } else if (heldKeys.has(VK.LSHIFT) && activeTool === weaponTool) {
        velocity.divideScalar(2);
    }
    if (dbgPlayer.isAttacking === false && dbgPlayer.isDodging === false) {
        dbgPlayer.position.add(velocity);
    }

    for (let [a, b] of pairs(combatants)) {
        let offset = a.position.clone().sub(b.position);
        if (offset.length() < 0.6) {
            let force = offset.clone().normalize().multiplyScalar(1000 * (0.6 - offset.length()) / 2 * deltaTime);
            a.velocity.add(force);
            b.velocity.addScaledVector(force, -1);
        }
    }

    if (dbgGrapplingHook != null) {
        let v = dbgGrapplingHook.update(deltaTime, dbgPlayer.position);
        dbgPlayer.velocity.add(v);
    }

    if (dbgPlayer.isParrying) {
        dbgPlayer.idleWeaponPose = parryPose(toolRoll);
    } else {
        dbgPlayer.idleWeaponPose = rollableAttackAnimation(toolRoll)(0);
    }

    dbgPlayer.hFacing = hFacing;
    dbgPlayer.vFacing = vFacing;
    
    dbgPoints.clear();
    for (let c of combatants) {
        c.update(deltaTime);
    }

    if (dbgGrapplingHook != null) {
        dbgGrapplingHook.updatePosition(dbgPlayer.position);
    }

    let attackSideEffects: ((() => void)|undefined)[] = [];
    for (let attacker of combatants) {
        if (attacker.isAttacking) {
            for (let target of combatants) {
                if (attacker !== target) {
                    let sideEffect = processAttack(attacker, target, deltaTime);
                    attackSideEffects.push(sideEffect);
                }
            }
        }
    }
    for (let sideEffect of attackSideEffects) {
        if (sideEffect != null) {
            sideEffect();
        }
    }

    if (justPressedKeys.has(VK.G)) {
        projectiles.push(new Arrow(cameraRay.origin, cameraRay.direction.clone().multiplyScalar(100), 20));
    }
    projectiles = projectiles.filter(p => p.update(deltaTime));

    dbgPlayer.root.add(camera);
    camera.position.x = 0;
    camera.position.y = 0;
    camera.position.z = 1.05 + 0.03;
    camera.position.add(neckCrane(hFacing, vFacing).multiplyScalar(0.3));
    
    if (justPressedKeys.has(VK.T)) {
        playerLight.visible = !playerLight.visible;
    }

    playerLight.position.copy(camera.getWorldPosition());
    // camera.position.add(vec3(0, 1, 0).applyAxisAngle(vec3(0, 0, 1), dbgPlayer.hFacing).multiplyScalar(Math.cos(gameTime * Math.PI * 2 / 0.2) * 0.1));

    if (dirLightDir.z < 0) {
        skyTime += deltaTime / secondsPerInGameDay * 100;
    } else {
        skyTime += deltaTime / secondsPerInGameDay;
    }
    skyTime = skyTime - Math.floor(skyTime / 1.0);
    let {sunDir, skyColor, sunEnabled, sunColor} = sunAndSky(skyTime);
    dirLightDir.copy(sunDir);
    dirLight.intensity = sunEnabled ? 3.0 : 0.0;
    ambientLight.color.copy(skyColor);
    renderer.setClearColor(skyColor);

    sunMesh.position.copy(camera.getWorldPosition().add(sunDir.clone().multiplyScalar(1000)));
    sunMesh.scale.set(20, 20, 20);
    (sunMesh.material as THREE.MeshBasicMaterial).color.copy(sunColor);
    dirLight.color.copy(sunColor);
    
    dirLight.position.copy(dirLightDir);
    // dirLightDir.applyAxisAngle(vec3(0, 1, 0), Math.PI * 2 / 60 * deltaTime);

    particles = particles.filter(p => p.update(deltaTime));

    // dbgSetExtrude(vec3(Math.cos(gameTime), Math.sin(gameTime), -1), 5);
    dbgSetExtrude(vec3(1, 0, -1).normalize(), 5);
    dbgExtrudedMesh.rotation.z = gameTime;
    dbgExtrudedMesh.rotation.y = gameTime / 3;
    dbgExtrudedMesh.rotation.x = gameTime / 7;
    dbgExtrudedMesh.scale.x = Math.cos(gameTime) * 2 + 0.5;
}

class SerializedShape {
    readonly points: number[][]; // really [number, number, number][]
    readonly attachedIndices: number[];
    readonly isRoot: boolean;
    readonly color: number;
}
type SerializedWorld = SerializedShape[];

interface RaycastIntersection {
    enterT: number,
    leaveT: number,
    enterNormal: THREE.Vector3 | null,
    leaveNormal: THREE.Vector3 | null,
}
interface PenetrationResult {
    axis: THREE.Vector3,
    displacement: number,
    overlap: [number, number],
}

class WorldSolid {
    attached: WorldSolid[];
    isRoot: boolean;
    color: THREE.Color;
    shape: ConvexPolyhedron;
}

let dbgDenyMaterial = new THREE.MeshStandardMaterial({
    color: 0,
    transparent: true,
    opacity: 0.5,
    emissive: new THREE.Color(0xff0000),
    emissiveIntensity: 0.5,
    depthWrite: false,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -4,
});
let dbgDenyMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), dbgDenyMaterial);
let dbgDenySet = new Set<WorldSolid>();
scene.add(dbgDenyMesh);

function setDenySet(s: Set<WorldSolid>) {
    if (s.size === 0) {
        dbgDenyMesh.visible = false;
        dbgDenySet = s;
        return;
    }
    function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
        if (a.size !== b.size) return false;
        for (let t of a) {
            if (!b.has(t)) return false;
        }
        return true;
    }
    if (!setsEqual(s, dbgDenySet)) {
        dbgDenyMesh.geometry = new THREE.Geometry();
        let identity = new THREE.Matrix4().identity();
        for (let solid of s) {
            dbgDenyMesh.geometry.merge(solid.shape.geometry, identity);
        }
        dbgDenySet = s;
        dbgDenyMesh.geometry.computeBoundingSphere();
    }
    dbgDenyMesh.visible = true;
}

let dbgAttachMaterial = new THREE.MeshStandardMaterial({ color: 0x00ffff, transparent: true, opacity: 0.5 });
let dbgAttachMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), dbgAttachMaterial);
scene.add(dbgAttachMesh);

let dbgPointGeo = new THREE.CubeGeometry(0.1, 0.1, 0.1);
let dbgPointMaterial = new THREE.MeshBasicMaterial({color: 0xff00ff});

class DbgPoints {
    root: THREE.Object3D;
    constructor() {
        this.root = new THREE.Object3D();
        scene.add(this.root);
    }
    clear() {
        while (this.root.children.length > 0) {
            this.root.remove(this.root.children[this.root.children.length - 1]);
        }
    }
    add(v: THREE.Vector3, color?: THREE.Color) {
        let material;
        if (color == null) {
            material = dbgPointMaterial;
        } else {
            material = dbgPointMaterial.clone();
            material.color = color;
        }
        let mesh = new THREE.Mesh(dbgPointGeo, material);
        mesh.position.copy(v);
        this.root.add(mesh);
    }
}
export let dbgPoints = new DbgPoints();

const box3Normals = [
    vec3( 1,  0,  0),
    vec3(-1,  0,  0),
    vec3( 0,  1,  0),
    vec3( 0, -1,  0),
    vec3( 0,  0,  1),
    vec3( 0,  0, -1),
];
function raycastBox(ray: THREE.Ray, depth: number, box: THREE.Box3): number|null {
    let enterT = 0; // Max time of entering
    let leaveT = depth; // Min time of leaving
    let rayOffset = ray.direction;
    let boxHalfSize = box.max.clone().sub(box.min).multiplyScalar(0.5);
    let boxCenter = box.min.clone().add(boxHalfSize);
    for (let faceNormal of box3Normals) {
        let d = rayOffset.dot(faceNormal);
        let n = (faceNormal.clone().multiply(boxHalfSize).add(boxCenter)).sub(ray.origin).dot(faceNormal);
        if (Math.abs(d) < 0.01) {
            // Ray parallel to face
            if (n < 0) {
                // No collision, ray outside face and parallel.
                return null;
            } else {
                // No collision with this face, but ray is inside.
                continue;
            }
        } 
        let t = n / d;
        if (d < 0) {
            if (t > enterT) {
                enterT = t;
            }
        } else {
            if (t < leaveT) {
                leaveT = t;
            }
        }
        if (enterT > leaveT) {
            // No collision
            return null;
        }
    }
    return enterT;
}

class Octree<T> {
    children: Octree<T>[] | null = null;
    entries: {bounds: THREE.Box3, value: T}[] = [];
    constructor(private bounds: THREE.Box3, private maxDepth: number) {}
    private makeChildren() {
        let min = this.bounds.min;
        let max = this.bounds.max;
        let halfSize = max.clone().sub(min).divideScalar(2);
        this.children = [];
        for (let x = 0 ; x < 2; x += 1) {
            for (let y = 0 ; y < 2; y += 1) {
                for (let z = 0 ; z < 2; z += 1) {
                    let v = new THREE.Vector3(x, y, z).multiply(halfSize).add(min);
                    this.children.push(new Octree<T>(new THREE.Box3(v, v.clone().add(halfSize)), this.maxDepth - 1));
                }
            }
        }
    }
    add(bounds: THREE.Box3, value: T) {
        let addToSelf = true;
        if (this.children == null && this.maxDepth > 0) {
            this.makeChildren();
        }
        if (this.children != null) {
            let toAddTo = this.children.filter(child => child.bounds.intersectsBox(bounds));
            if (toAddTo.length === 1) {
                toAddTo[0].add(bounds, value);
                addToSelf = false;
            }
        }
        if (addToSelf) {
            this.entries.push({ bounds, value });
        }
    }
    remove(bounds: THREE.Box3, value: T) {
        // TODO: The check for the correct child to remove from could potentially be wrong due to rounding errors?
        //       Could remove from all intersecting nodes, but very large bounds might then visit a ton of nodes.  
        let removeFromSelf = true;
        if (this.children != null) {
            let toRemoveFrom = this.children.filter(child => child.bounds.intersectsBox(bounds));
            if (toRemoveFrom.length === 1) {
                toRemoveFrom[0].remove(bounds, value);
                removeFromSelf = false;
                if (this.children.every(child => child.children === null && child.entries.length === 0)) {
                    this.children = null;
                }
            }
        }
        if (removeFromSelf) {
            this.entries = this.entries.filter(entry => entry.value !== value);
        }
    }
    raycast(ray: THREE.Ray, t: number, results: T[]): T[] {
        for (let entry of this.entries) {
            if (raycastBox(ray, t, entry.bounds) != null) {
                results.push(entry.value);
            }
        }
        if (this.children != null) {
            for (let child of this.children) {
                if (raycastBox(ray, t, child.bounds) != null) {
                    child.raycast(ray, t, results);
                }
            }
        }
        return results;
    }
    get(bounds: THREE.Box3, results: T[]): T[] {
        for (let entry of this.entries) {
            if (entry.bounds.intersectsBox(bounds)) {
                results.push(entry.value);
            }
        }
        if (this.children != null) {
            for (let child of this.children) {
                if (child.bounds.intersectsBox(bounds)) {
                    child.get(bounds, results);
                }
            }
        }
        return results;
    }
    getAll(results: T[]): T[] {
        for (let entry of this.entries) {
            results.push(entry.value);
        }
        if (this.children != null) {
            for (let child of this.children) {
                child.getAll(results);
            }
        }
        return results;
    }
}

function worldOctreeHas(octree: Octree<WorldSolid>, solid: WorldSolid): boolean {
    return octree.get(solid.shape.boundingBox(), []).indexOf(solid) !== -1;
}

class World {
    /*
        Invariants:
            every solid that is part of the world is reachable from a root
            no two solids in the world overlap (within some epsilon)
            two solids that are attached must be "touching" along the contact plane normal,
                and the attached faces must 1) share the contact plane, 2) overlap in 2D on that plane

        Modification:
            No world solids are manipulated directly (no translation/rotation, no vertex/face manipulation).
            Instead, attachments (edges in the world graph) may be removed and if a subgraph becomes orphaned
            it is removed from the world and may only then be directly manipulated and subsequently reattached.
            The merge operation could theoretically be multiple detachments + merge + reattach,
            but to preserve the existing attachments it should be more easily done here.
            The same goes for slicing.
            In lieu of a weld operation to attach two existing solids to each other, right now I think it could
            be done without additional tools by slicing the ends of each solid and then merging them.

        Notes:
            Solids in the world do not have transformation matrices, they can be described solely by the the points
            that will reconstruct their convex hull and the solids they are attached to.
            Slicing can thus be very simple, however it needs to know edges to intersect with the plane, so
            at some point a mesh must be generated and the edges stored.
            Solids do not need individual meshes, the geometry can be generated and combined (and hopefully optimized, removing hidden faces etc),
            so long as enough information is kept to generate new geometry if solids are removed through detachment.

            Grabbed solids, though, should probably have transforms associated so they can be quickly moved/rotated and
            tested for collision in their new positions for preview purposes without having to generate new geometry every frame.
            Solids then should probably know their extents along their own axes, and under translation/rotation can just transform the axes
            into the other solid's space for overlap.
    */

    solids: Octree<WorldSolid>;

    static fromSerialized(serialized: SerializedWorld): World {
        let solids = serialized.map(s => {
            let solid = new WorldSolid();
            solid.isRoot = s.isRoot;
            solid.attached = undefined as any;
            solid.color = new THREE.Color(s.color);
            solid.shape = new ConvexPolyhedron(s.points.map(([x, y, z]) => vec3(x, y, z)));
            return solid;
        });
        for (let i = 0; i < solids.length; i++) {
            solids[i].attached = serialized[i].attachedIndices.map(index => solids[index]);
        }
        // TODO: validate attachments, validate that every solid can reach a root
        let world = new World();
        let octreeSize = 2 << 12;
        world.solids = new Octree<WorldSolid>(new THREE.Box3(new THREE.Vector3(-octreeSize, -octreeSize, -octreeSize), new THREE.Vector3(octreeSize, octreeSize, octreeSize)), 6);
        for (let solid of solids) {
            world.solids.add(solid.shape.boundingBox(), solid);
        }
        return world;
    }
    serialize(): SerializedWorld {
        let allSolids: WorldSolid[] = [];
        this.solids.getAll(allSolids);
        return allSolids.map(solid => ({
            points: solid.shape.vertices.map(vertex => [vertex.x, vertex.y, vertex.z]),
            attachedIndices: solid.attached.map(other => allSolids.indexOf(other)),
            isRoot: solid.isRoot,
            color: solid.color.getHex(),
        }));
    }

    // Attaches a WorldSolid not currently part of the world (held by player) to the world, or fails.
    // This works by using the ray to intersect with the world to choose a face to attach to.
    // The face on the solid provided that attaches is provided as a point and normal
    // The new solid is reoriented so that those two faces share the plane of the face of the solid already in the world.
    //     The ray is like a nail, attaches the exit point of the held solid to the entry point of the world solid. 
    // If the new solid does not overlap the target face, returns false.
    // If the new solid overlaps any other solid, returns false.
    // Otherwise the solid is added to the world, the new attachment is made, and this returns true.
    attachWith(solidToAttach: WorldSolid, attachPoint: THREE.Vector3, attachNormal: THREE.Vector3, ray: THREE.Ray, roll: number, preview: boolean): boolean {
        dbgPoints.clear();
        // Get target point (cast ray into world) and normal.
        let targetIntersect: RaycastIntersection|null = null;
        let targetSolid: WorldSolid = null as any;
        for (let solid of this.solids.get(new THREE.Box3().setFromPoints([ray.origin, ray.at(10)]).expandByScalar(0.1), [])) {
            let r = solid.shape.raycast(ray, 10);
            if (r != null && (targetIntersect == null || r.enterT < targetIntersect.enterT )) {
                targetIntersect = r;
                targetSolid = solid;
            }
        }
        if (targetIntersect == null) return false;
        if (targetIntersect.enterNormal == null) return false;
        let targetPoint = ray.at(targetIntersect.enterT);
        dbgPoints.add(targetPoint);
        let targetNormal = targetIntersect.enterNormal;

        // Need to transform held object so that the points align and the normals oppose.
        // So, translate the point onto the target point.
        // Next, rotate around that point to align the normals by the shortest rotation possible.
            // normal_held x normal_desired to get axis of rotation
            // Math.acos(normal_held dot normal_desired) to get angle of rotation
        let desiredNormal = targetNormal.clone().negate();
        let dot = attachNormal.dot(desiredNormal);
        let axis: THREE.Vector3;
        let angle: number;
        if (dot >= 0.999999) {
            // Normals align, needs no rotation
            axis = vec3(0, 0, 1);
            angle = 0;
        } else if (dot <= -0.999999) {
            // Normals oppose, rotate PI around any perpendicular vector
            axis = [
                vec3(-desiredNormal.y, desiredNormal.x, 0),
                vec3(-desiredNormal.z, 0, desiredNormal.x),
                vec3(0, -desiredNormal.z, desiredNormal.y),
            ].reduce((a, b) => a.lengthSq() > b.lengthSq() ? a : b).normalize();
            angle = Math.PI;
        } else {
            axis = attachNormal.clone().cross(desiredNormal).normalize();
            angle = Math.acos(dot);
        }

        // Translate to origin, rotate, translate to target
        let matrix = new THREE.Matrix4();
        matrix.makeTranslation(-attachPoint.x, -attachPoint.y, -attachPoint.z);
        let temp = new THREE.Matrix4();
        matrix.premultiply(temp.makeRotationAxis(axis, angle));
        matrix.premultiply(temp.makeRotationAxis(desiredNormal, roll));
        matrix.premultiply(temp.makeTranslation(targetPoint.x, targetPoint.y, targetPoint.z));

        let solidsToAdd = new Map<WorldSolid, WorldSolid>();
        for (let reached of graphIterator(solidToAttach, t => t.attached)) {
            let solidToAdd = new WorldSolid();
            solidToAdd.shape = new ConvexPolyhedron(reached.shape.vertices.map(v => v.clone().applyMatrix4(matrix)));
            solidToAdd.attached = undefined as any;
            solidToAdd.color = reached.color.clone();
            solidToAdd.isRoot = reached.isRoot;
            solidsToAdd.set(reached, solidToAdd);
        }
        for (let [original, clone] of solidsToAdd) {
            clone.attached = original.attached.map(s => solidsToAdd.get(s) as WorldSolid);
        }

        dbgAttachMesh.geometry = makeGeometryFromSolid(solidsToAdd.get(solidToAttach) as WorldSolid);

        let intersectingSolids = new Set<WorldSolid>();
        for (let solidToAdd of solidsToAdd.values()) {
            for (let solid of this.solids.get(solidToAdd.shape.boundingBox().expandByScalar(0.1), [])) {
                if (solid.shape.overlaps(solidToAdd.shape)) {
                    intersectingSolids.add(solid);
                }
            }
        }

        setDenySet(intersectingSolids);
        dbgAttachMaterial.opacity = 0.5;
        if (intersectingSolids.size > 0) {
            dbgAttachMaterial.color = new THREE.Color(0xff0000);
            return false;
        } else {
            dbgAttachMaterial.color = new THREE.Color(0x00ffff);
        }

        if (preview) return false;

        if (!(solidsToAdd.get(solidToAttach) as WorldSolid).shape.hasFaceContact(targetSolid.shape)) {
            console.warn("Attachment failed, no face contact somehow");
            return false;
        }

        // All good
        (solidsToAdd.get(solidToAttach) as WorldSolid).attached.push(targetSolid);
        targetSolid.attached.push(solidsToAdd.get(solidToAttach) as WorldSolid);
        for (let solidToAdd of solidsToAdd.values()) {
            this.solids.add(solidToAdd.shape.boundingBox(), solidToAdd);
        }
        return true;
    }

    // Slices the specified solid with the cuttingPlane, every attachment from the original solid will be inherited by one or both of the new solids. In addition, both new solids will be attached to each other.
    slice(solid: WorldSolid, cuttingPlane: THREE.Plane) {
        let solidsToAdd: WorldSolid[] = [];
        console.log("Slicing");
        let splitPoints = worldsolids.splitConvexGeometryPoints(solid.shape.geometry, cuttingPlane);
        let newSolids = splitPoints.map(points => {
            let newSolid = new WorldSolid();
            newSolid.color = randomColor();
            newSolid.isRoot = solid.isRoot; // ?????? Probably shouldn't be able to slice roots
            newSolid.shape = new ConvexPolyhedron(points);
            newSolid.attached = [];
            // Inherit attachments
            for (let attachment of solid.attached) {
                if (newSolid.shape.hasFaceContact(attachment.shape)) {
                    newSolid.attached.push(attachment);
                    attachment.attached.push(newSolid);
                }
            }
            solidsToAdd.push(newSolid);
            return newSolid;
        });
        if (newSolids.length === 2) {
            newSolids[0].attached.push(newSolids[1]);
            newSolids[1].attached.push(newSolids[0]);
        } else {
            console.warn("Sliced solid into " + newSolids.length + " pieces??");
        }
        // Detach from all
        for (let attachment of solid.attached) {
            attachment.attached = attachment.attached.filter(s => s !== solid);
            if (!attachment.attached.some(s => newSolids.indexOf(s) !== -1)) {
                console.warn("No sliced solid inherited attachment to", attachment);
            }
        }
        this.solids.remove(solid.shape.boundingBox(), solid);
        for (let solid of solidsToAdd) {
            this.solids.add(solid.shape.boundingBox(), solid);
        }
    }
    // Not sure if this should be kept over detach, but while detach is unimplemented this can stay.
    remove(solid: WorldSolid) {
        if (!worldOctreeHas(this.solids, solid)) { console.warn("Cannot remove solid not in world:", solid); return false; }
        function getReachable(solid: WorldSolid): Set<WorldSolid> {
            let visited = new Set<WorldSolid>();
            function visit(solid: WorldSolid) {
                if (visited.has(solid)) return;
                visited.add(solid);
                for (let attachment of solid.attached) {
                    visit(attachment);
                }
            }
            visit(solid);
            return visited;
        }
        for (let attachment of solid.attached) {
            attachment.attached = attachment.attached.filter(s => s !== solid);
        }
        this.solids.remove(solid.shape.boundingBox(), solid);
        for (let attachment of solid.attached) {
            let reachable = getReachable(attachment);
            if (!Array.from(reachable).some(s => s.isRoot)) {
                for (let r of reachable) {
                    this.solids.remove(r.shape.boundingBox(), r);
                }
            }
        }
        return true;
    }
    // Detaches attached solids in the world, if a detachment results in orphaned solids (not connected to a root), then return those so the player can hold them
    detach(ray: THREE.Ray, angle: number, depth: number): WorldSolid|null {
        return null; // unimplemented
    }

    deleteVertex(solid: WorldSolid, vertex: THREE.Vector3) {
        if (!worldOctreeHas(this.solids, solid)) { console.warn("Cannot delete vertex from solid not in world:", solid); return; }
        let combinedVertices = solid.shape.vertices.filter(v => v.distanceTo(vertex) > 0.001);
        if (combinedVertices.length < 4) {
            this.remove(solid);
            return true;
        }

        this.solids.remove(solid.shape.boundingBox(), solid);

        let combinedShape = new ConvexPolyhedron(combinedVertices);
        let combinedSolid = new WorldSolid();
        combinedSolid.shape = combinedShape;
        combinedSolid.color = solid.color;
        combinedSolid.isRoot = solid.isRoot;
        combinedSolid.attached = [];

        let detached = [];
        for (let attachment of solid.attached) {
            attachment.attached = attachment.attached.filter(s => s !== solid);
            if (!combinedShape.hasFaceContact(attachment.shape)) {
                detached.push(attachment);
            } else {
                attachment.attached.push(combinedSolid);
                combinedSolid.attached.push(attachment);
            }
        }

        this.solids.add(combinedSolid.shape.boundingBox(), combinedSolid);

        let toRemove = [];
        outer: for (let s of detached) {
            for (let other of graphIterator(s, t => t.attached)) {
                if (other.isRoot) {
                    continue outer;
                }
            }
            toRemove.push(s);
        }
        for (let s of toRemove) {
            if (worldOctreeHas(this.solids, s)) {
                this.remove(s);
            }
        }
    }

    addVertex(solid: WorldSolid, vertex: THREE.Vector3): boolean {
        if (!worldOctreeHas(this.solids, solid)) { console.warn("Cannot add vertex to solid not in world:", solid); return false; }
        let combinedShape = new ConvexPolyhedron(solid.shape.vertices.concat([vertex]));
        let intersectingSolids = new Set<WorldSolid>();
        for (let s of this.solids.get(combinedShape.boundingBox().expandByScalar(0.1), [])) {
            if (s === solid) continue;
            if (combinedShape.overlaps(s.shape)) {
                intersectingSolids.add(s);
            }
        }
        setDenySet(intersectingSolids);
        if (intersectingSolids.size > 0) {
            dbgAttachMaterial.color = new THREE.Color(0xff0000);
            dbgAttachMaterial.opacity = 0.2;
            dbgAttachMesh.geometry = combinedShape.geometry;
            dbgAttachMesh.visible = true;
            return false;
        }
        this.solids.remove(solid.shape.boundingBox(), solid);

        let combinedSolid = new WorldSolid();
        combinedSolid.shape = combinedShape;
        combinedSolid.color = randomColor();
        combinedSolid.isRoot = solid.isRoot;
        combinedSolid.attached = solid.attached.slice();

        for (let attachment of combinedSolid.attached) {
            attachment.attached = attachment.attached.filter(s => s !== solid);
            attachment.attached.push(combinedSolid);
        }

        this.solids.add(combinedSolid.shape.boundingBox(), combinedSolid);
        return true;
    }

    // Attempts to merge two solids in the world into a single solid, inheriting all attachments from both. Or, if the merged solid would collide with another world solid, fails and changes nothing.
    merge(solidA: WorldSolid, solidB: WorldSolid): boolean {
        if (!worldOctreeHas(this.solids, solidA)) { console.warn("Cannot merge solid not in world:", solidA); return false; }
        if (!worldOctreeHas(this.solids, solidB)) { console.warn("Cannot merge solid not in world:", solidB); return false; }
        let combinedShape = new ConvexPolyhedron(solidA.shape.vertices.concat(solidB.shape.vertices));
        let intersectingSolids = new Set<WorldSolid>();
        for (let solid of this.solids.get(solidA.shape.boundingBox().union(solidB.shape.boundingBox()).expandByScalar(0.1), [])) {
            if (solid === solidA || solid === solidB) continue;
            if (combinedShape.overlaps(solid.shape)) {
                intersectingSolids.add(solid);
            }
        }
        setDenySet(intersectingSolids);
        if (intersectingSolids.size > 0) {
            dbgAttachMaterial.color = new THREE.Color(0xff0000);
            dbgAttachMaterial.opacity = 0.2;
            dbgAttachMesh.geometry = combinedShape.geometry;
            dbgAttachMesh.visible = true;
            return false;
        }
        let toAttach = new Set<WorldSolid>(solidA.attached.concat(solidB.attached));
        toAttach.delete(solidA);
        toAttach.delete(solidB);
        this.solids.remove(solidA.shape.boundingBox(), solidA);
        this.solids.remove(solidB.shape.boundingBox(), solidB);
        for (let attachment of solidA.attached) {
            attachment.attached = attachment.attached.filter(s => s !== solidA);
        }
        for (let attachment of solidB.attached) {
            attachment.attached = attachment.attached.filter(s => s !== solidB);
        }
        let combinedSolid = new WorldSolid();
        combinedSolid.shape = combinedShape;
        combinedSolid.color = randomColor();
        combinedSolid.isRoot = solidA.isRoot || solidB.isRoot;
        combinedSolid.attached = [];
        for (let attachment of toAttach) {
            if (combinedShape.hasFaceContact(attachment.shape)) {
                combinedSolid.attached.push(attachment);
                attachment.attached.push(combinedSolid);
            } else {
                console.warn("Merge detached solid", attachment, "from", combinedSolid);
            }
        }
        this.solids.add(combinedSolid.shape.boundingBox(), combinedSolid);
        return true;
    }

    // Adds a solid if it does not collide with any others, and comes with a root.
    add(solidToAdd: WorldSolid): boolean {
        let seen = new Set<WorldSolid>();
        let toVisit = [solidToAdd];
        seen.add(solidToAdd);
        let rootAttached = false;
        while (toVisit.length > 0) {
            let solid = toVisit.pop() as WorldSolid;
            for (let attachment of solid.attached) {
                if (!seen.has(attachment)) {
                    seen.add(attachment);
                    toVisit.push(attachment);
                }
            }
            if (solid.isRoot) rootAttached = true;
            for (let other of this.solids.get(solidToAdd.shape.boundingBox().expandByScalar(0.1), [])) {
                if (solid.shape.overlaps(other.shape)) {
                    return false;
                }
            }
        }
        if (!rootAttached) return false;
        for (let solid of seen) {
            this.solids.add(solid.shape.boundingBox(), solid);
        }
        return true;
    }
}

export function dbgAddWorldSolid(points: THREE.Vector3[]): boolean {
    return world.add({
        attached: [],
        isRoot: true,
        color: new THREE.Color(0xff0000),
        shape: new ConvexPolyhedron(points)
    });
}

function getUniqueEdges(geometry: THREE.Geometry): THREE.Vector3[] {
    // To precompute the edges:
    //     An edge shared by two triangles that have the same normal should be discarded (it's an interior edge, arbitrary based on triangulation)
    //     Otherwise, deduplicate in the same way that it's done for normals.
    function edgeId(a: number, b: number) {
        if (a < b) {
            [a, b] = [b, a];
        }
        return geometry.vertices.length * b + a;
    }
    let edgeNormal: Map<number, THREE.Vector3> = new Map();
    let uniqueEdges: THREE.Vector3[] = [];
    function addEdge(a: number, b: number, normal: THREE.Vector3) {
        let edgeid = edgeId(a, b);
        if (edgeNormal.has(edgeid)) {
            let otherNormal = edgeNormal.get(edgeid) as THREE.Vector3;
            if (Math.abs(otherNormal.dot(normal)) > 0.98) {
                return; // Interior edge, ignore
            }
            let edge = geometry.vertices[b].clone().sub(geometry.vertices[a]).normalize();
            for (let otherEdge of uniqueEdges) {
                if (Math.abs(otherEdge.dot(edge)) > 0.98) {
                    return; // Edge not unique
                }
            }
            uniqueEdges.push(edge);
        } else {
            edgeNormal.set(edgeid, normal);
        }
    }
    for (let face of geometry.faces) {
        addEdge(face.a, face.b, face.normal);
        addEdge(face.b, face.c, face.normal);
        addEdge(face.a, face.c, face.normal);
    }
    return uniqueEdges;
}

class ConvexShape {
    mesh: THREE.Mesh;
    uniqueAxes: THREE.Vector3[];
    uniqueVertices: THREE.Vector3[];
    uniqueEdges: THREE.Vector3[];

    previousFrameTransform = new THREE.Matrix4().identity();
    recordTransform() {
        this.previousFrameTransform.copy(this.mesh.matrixWorld);
    }

    constructor(mesh: THREE.Mesh) {
        this.mesh = mesh;
        this.mesh.castShadow = true;
        this.mesh.receiveShadow = true;
        this.uniqueAxes = [];
        this.uniqueVertices = [];
        // this.mesh.geometry.computeFaceNormals();
        outer: for (let face of (<THREE.Geometry>mesh.geometry).faces) {
            let normal = face.normal;
            for (let axis of this.uniqueAxes) {
                if (Math.abs(axis.dot(normal)) > 0.98) {
                    continue outer;
                }
            }
            this.uniqueAxes.push(normal);
        }
        outer: for (let vertex of (<THREE.Geometry>mesh.geometry).vertices) {
            for (let v of this.uniqueVertices) {
                if (v.distanceToSquared(vertex) < 0.0001) {
                    continue outer;
                }
            }
            this.uniqueVertices.push(vertex);
        }
        this.uniqueEdges = getUniqueEdges(<THREE.Geometry>this.mesh.geometry);
    }

    getWorldEdges(): THREE.Vector3[] {
        return this.uniqueEdges.map(axis => axis.clone().transformDirection(this.mesh.matrixWorld));
    }
    getWorldAxes(): THREE.Vector3[] {
        return this.uniqueAxes.map(axis => axis.clone().transformDirection(this.mesh.matrixWorld));
    }
    getWorldVertices(): THREE.Vector3[] {
        return this.uniqueVertices.map(v => v.clone().applyMatrix4(this.mesh.matrixWorld));
    }

    worldContactPoint(otherShape: ConvexShape): THREE.Vector3|null {
        let self = new ConvexPolyhedron(this.getWorldVertices());
        let other = new ConvexPolyhedron(otherShape.getWorldVertices());
        let p = self.getPenetration(other);
        if (p == null) return null;
        let axisComponent = (p.overlap[0] + p.overlap[1]) / 2;
        let contactPlane = new THREE.Plane(p.axis.clone(), -axisComponent);
        let polygonPoints3D = geometryPlaneIntersections(self.geometry, contactPlane);

        // https://stackoverflow.com/questions/9181646/how-do-i-compute-a-new-basis-transformation-matrix-from-a-3d-plane-and-known-o#9182772
        let planeBasisU = vec3(0, 0, 1);
        if (planeBasisU.dot(p.axis) > 0.7) {
            planeBasisU = vec3(1, 0, 0);
        }
        let planeBasisV = p.axis.clone().cross(planeBasisU).normalize();
        planeBasisU = p.axis.clone().cross(planeBasisV).normalize();

        let polygonPoints2D = convexPolygonPointOrder(polygonPoints3D.map(p => vec2(planeBasisU.dot(p), planeBasisV.dot(p))));
        let centroid2D = polygonCentroid(polygonPoints2D);
        let centroid3D = vec3(0, 0, 0)
            .addScaledVector(planeBasisU, centroid2D.x)
            .addScaledVector(planeBasisV, centroid2D.y)
            .addScaledVector(p.axis, axisComponent);
        return centroid3D;
    }

    overlaps(other: ConvexShape): boolean {
        let selfVertices = this.getWorldVertices();
        let otherVertices = other.getWorldVertices();

        function separatedByAxis(axis: THREE.Vector3) {
            let [minA, maxA] = verticesSpan(selfVertices, axis);
            let [minB, maxB] = verticesSpan(otherVertices, axis);
            return maxA <= minB || maxB <= minA;
        }

        for (let axis of this.getWorldAxes()) {
            if (separatedByAxis(axis)) return false;
        }
        for (let axis of other.getWorldAxes()) {
            if (separatedByAxis(axis)) return false;
        }

        // This needs to consider axes made by cross product of edges.
        //       https://www.geometrictools.com/Documentation/MethodOfSeparatingAxes.pdf
        //       https://en.wikipedia.org/wiki/Separating_axis_theorem
        //       "If the cross products were not used, certain edge-on-edge non-colliding cases would be treated as colliding."
        //       https://gamedev.stackexchange.com/questions/44500/how-many-and-which-axes-to-use-for-3d-obb-collision-with-sat
        let selfEdges = this.getWorldEdges();
        let otherEdges = other.getWorldEdges();
        for (let edgeA of selfEdges) {
            for (let edgeB of otherEdges) {
                let norm = vec3(0, 0, 0).crossVectors(edgeA, edgeB);
                if (norm.lengthSq() < 0.0001) {
                    // Edges parallel, ignore
                } else {
                    if (separatedByAxis(norm)) return false;
                }
            }
        }

        return true;
    }
}

function verticesSpan(vertices: THREE.Vector3[], axis: THREE.Vector3): [number, number] {
    let min = Infinity;
    let max = -Infinity;
    for (let vertex of vertices) {
        let d = vertex.dot(axis);
        min = Math.min(min, d);
        max = Math.max(max, d);
    }
    return [min, max];
}

function normalizedAngle(a: number) {
    a = a % (Math.PI * 2);
    if (a < -Math.PI) return a + Math.PI * 2;
    if (a > Math.PI) return a - Math.PI * 2;
    return a;
}
function mod(a: number, b: number): number {
    return a - Math.floor(a / b) * b;
}
function clamp(val: number, min: number, max: number) {
    return Math.min(Math.max(val, min), max);
}

canvas.addEventListener("actualkeydown", (evt: any) => {
    // if (evt.which === 16) { // Left shift firefox ubuntu
    if (evt.which === VK.SPACE) {
        if (!dbgPlayer.isAttacking && !dbgPlayer.isDodging) {
            let dodgeVel = keyboardVel();
            if (dodgeVel.lengthSq() > 0) {
                dbgPlayer.isDodging = true;
                dbgPlayer.dodgeT = 0.2;
                dodgeVel.normalize().rotateAround(new THREE.Vector2(), hFacing).multiplyScalar(10);
                dbgPlayer.dodgeDir = vec3(dodgeVel.x, dodgeVel.y, 0);
            }
        }
    }
});

function parryPose(roll: number): [THREE.Vector3, THREE.Euler] {
    let v = vec3(0.6, -0.24, -0.3);
    let n = vec3(0, 0, 1);
    v.applyAxisAngle(vec3(1, 0, 0), roll);
    n.applyAxisAngle(vec3(1, 0, 0), roll);
    return [v.clone().add(vec3(0, 0, 0.6)), new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(vec3(0, 0, 1), n))];
}
function rollableAttackAnimation(roll: number): (t: number) => [THREE.Vector3, THREE.Euler] {
    return (t: number): [THREE.Vector3, THREE.Euler] => {
        let v = vec3(0.9, 0, 0);
        let a = (0.25 + Math.pow(t, 1.5)) * Math.PI;
        v.applyAxisAngle(vec3(0, 1, 0), Math.PI + a);
        v.applyAxisAngle(vec3(1, 0, 0), roll);
        return [v.clone().add(vec3(0, 0, 0.5)), new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(vec3(0, 0, 1), v.clone().normalize()))];
    }
}
function rollableSidewaysAttackAnimation(roll: number): (t: number) => [THREE.Vector3, THREE.Euler] {
    return (t: number): [THREE.Vector3, THREE.Euler] => {
        let v = vec3(0.9, 0, 0);
        let a = (0.25 + t) * Math.PI;
        v.applyAxisAngle(vec3(0, 1, 0), Math.PI + a);
        v.applyAxisAngle(vec3(1, 0, 0), roll + (1 - Math.pow(1 - t, 2)) * Math.PI / 2);
        return [v.clone().add(vec3(0, 0, 0.5)), new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(vec3(0, 0, 1), v.clone().normalize()))];
    }
}
function rollableStabAnimation(roll: number): (t: number) => [THREE.Vector3, THREE.Euler] {
    return (t: number): [THREE.Vector3, THREE.Euler] => {
        let linearStart = rollableAttackAnimation(roll)(0)[0];
        let linearEnd = vec3(0.9, 0, 0.3);
        let angleStart = new THREE.Quaternion().setFromEuler(rollableAttackAnimation(roll)(0)[1]);
        let angleEnd = new THREE.Quaternion().setFromUnitVectors(vec3(0, 0, 1), linearEnd.clone().sub(linearStart).normalize());
        return [rollableAttackAnimation(roll)(t)[0], new THREE.Euler().setFromQuaternion(angleStart.clone().slerp(angleEnd, Math.min(1, t * 2)))];
    }
}

let arrowGeometry = new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
arrowGeometry.translate(0, 0, 0.5);
let arrowMaterial = new THREE.MeshStandardMaterial({ color: 0xff00ff });
class Arrow {
    lead: THREE.Vector3;
    follow: THREE.Vector3;
    velocity: THREE.Vector3;
    gravity: THREE.Vector3;
    arrowLength: number;
    stuck: boolean;
    ttl: number;
    mesh: THREE.Mesh;

    constructor(spawn: THREE.Vector3, velocity: THREE.Vector3, ttl: number) {
        this.lead = spawn.clone();
        this.follow = this.lead.clone().sub(vec3(0, 0, 1));
        this.ttl = ttl;
        this.velocity = velocity.clone();
        this.gravity = vec3(0, 0, -30);
        this.stuck = false;
        this.arrowLength = 1;
        this.mesh = new THREE.Mesh(arrowGeometry, arrowMaterial);
        this.mesh.castShadow = true;
        this.mesh.receiveShadow = true;
        this.mesh.layers.enable(MINIVIEW_LAYER);
        scene.add(this.mesh);
    }

    update(deltaTime: number): boolean {
        this.ttl -= deltaTime;
        if (this.ttl <= 0) {
            scene.remove(this.mesh);
            return false;
        }
        if (!this.stuck) {
            this.velocity.addScaledVector(this.gravity, deltaTime);

            let ray = new THREE.Ray(this.lead, this.velocity.clone().normalize());
            let rayLength = deltaTime * this.velocity.length();
            let r = raycastWorld(world, ray, rayLength);
            if (r == null) {
                this.lead = ray.at(rayLength);
            } else {
                let [_, d] = r;
                this.lead = ray.at(d.enterT + this.arrowLength / 3); // Move an extra 1/3 of the length to embed in the surface
                this.stuck = true;
            }
            this.follow.sub(this.lead).normalize().multiplyScalar(this.arrowLength).add(this.lead);

            this.mesh.position.copy(this.follow);
            let dir = this.lead.clone().sub(this.follow);
            this.mesh.scale.set(0.1, 0.1, Math.max(0.1, dir.length()));
            this.mesh.setRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(vec3(0, 0, 1), dir.normalize()));
        }
        return true;
    }
}

let grapplingHookGeometry = new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
grapplingHookGeometry.translate(0, 0, 0.5);
let grapplingHookMaterial = new THREE.MeshStandardMaterial({ color: 0x00ff00, metalness: 0.1, roughness: 0.9 })
class GrapplingHook {
    arrow: Arrow;
    length: number|null;
    mesh: THREE.Mesh;
    material: THREE.MeshStandardMaterial;
    constructor(position: THREE.Vector3, velocity: THREE.Vector3) {
        this.length = null;
        this.arrow = new Arrow(position, velocity, 1e6);
        this.material = grapplingHookMaterial.clone();
        this.mesh = new THREE.Mesh(grapplingHookGeometry, this.material);
        this.mesh.castShadow = true;
        this.mesh.receiveShadow = true;
        scene.add(this.mesh);
    }
    extend(amount: number, point: THREE.Vector3) {
        if (this.length != null) {
            let currentDistance = this.arrow.follow.clone().sub(point).length();
            if (amount < 0) {
                this.length = Math.min(currentDistance, this.length) + amount;
            } else {
                this.length = Math.max(currentDistance, this.length);
            }
            this.length = Math.max(1, this.length);
        }
    }
    remove() {
        scene.remove(this.mesh);
        scene.remove(this.arrow.mesh);
    }
    update(deltaTime: number, point: THREE.Vector3): THREE.Vector3 {
        this.arrow.update(deltaTime);
        if (this.length == null && this.arrow.stuck) {
            this.length = this.arrow.follow.distanceTo(point);
        }
        if (this.length != null) {
            let v = this.arrow.follow.clone().sub(point);
            let d = v.length();
            let a = d - this.length;
            let c = new THREE.Color(0x00ff00).lerp(new THREE.Color(0xff0000), clamp(a, 0, 1));
            this.material.color.copy(c);
            if (d > this.length) {
                return v.normalize().multiplyScalar(a);
            }
        }
        return vec3(0, 0, 0);
    }
    updatePosition(point: THREE.Vector3) {
        this.mesh.position.copy(point);
        let dir = this.arrow.follow.clone().sub(point);
        this.mesh.scale.set(0.1, 0.1, Math.max(0.1, dir.length()));
        this.mesh.setRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(vec3(0, 0, 1), dir.normalize()));
    }
}

interface IKLimb {
    updateMesh(p: THREE.Vector3, q: THREE.Quaternion): void;
    update(p: THREE.Vector3, q: THREE.Quaternion, target: THREE.Vector3, deltaTime: number): THREE.Vector3;
    setEndOrientation(q: THREE.Quaternion): void;
}

class EndLimb {
    static MATERIAL = makeExtendedMaterial(0xff0000);
    static GEOMETRY = (() => {
        let geo = new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
        geo.translate(0, 0, 0.5);
        return geo;
    })();
    mesh: THREE.Mesh;
    constructor(meshParent: THREE.Object3D) {
        this.mesh = new THREE.Mesh(TranslateLimb.GEOMETRY, TranslateLimb.MATERIAL);
        this.mesh.castShadow = this.mesh.receiveShadow = true;
        this.mesh.layers.enable(MINIVIEW_LAYER);
        meshParent.add(this.mesh);
    }

    setEndOrientation(q: THREE.Quaternion) {
        this.mesh.setRotationFromQuaternion(q);
    }

    update(p: THREE.Vector3, q: THREE.Quaternion, target: THREE.Vector3, deltaTime: number): THREE.Vector3 {
        return p;
    }

    updateMesh(p: THREE.Vector3, q: THREE.Quaternion) {
        this.mesh.position.copy(p);
        this.mesh.scale.set(0.1, 0.1, 0.03);
    }
}

class TranslateLimb {
    static MATERIAL = makeExtendedMaterial(0xff0000);
    static GEOMETRY = (() => {
        let geo = new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
        geo.translate(0.0, 0, 0.5);
        return geo;
    })();
    offset: number;
    mesh: THREE.Mesh;
    child: IKLimb;

    helper: THREE.AxisHelper;

    constructor(offset: number, meshParent: THREE.Object3D, child: IKLimb) {
        this.offset = offset;
        this.child = child;
        this.mesh = new THREE.Mesh(TranslateLimb.GEOMETRY, TranslateLimb.MATERIAL);
        this.mesh.castShadow = this.mesh.receiveShadow = true;
        this.mesh.layers.enable(MINIVIEW_LAYER);
        meshParent.add(this.mesh);
        this.helper = new THREE.AxisHelper(0.25);
        meshParent.add(this.helper);
    }

    setEndOrientation(q: THREE.Quaternion) {
        this.child.setEndOrientation(q);
    }

    updateMesh(p: THREE.Vector3, q: THREE.Quaternion) {
        let np = p.clone().add(vec3(0, 0, this.offset).applyQuaternion(q));
        this.child.updateMesh(np, q);

        this.mesh.position.copy(p);
        this.mesh.scale.set(0.1, 0.1, Math.max(0.03, this.offset - 0.1));
        this.mesh.setRotationFromQuaternion(q);

        this.helper.position.copy(p);
        this.helper.setRotationFromQuaternion(q);
    }

    update(p: THREE.Vector3, q: THREE.Quaternion, target: THREE.Vector3, deltaTime: number): THREE.Vector3 {
        let np = p.clone().add(vec3(0, 0, this.offset).applyQuaternion(q));
        return this.child.update(np, q, target, deltaTime);
    }
}

class RotateLimb {
    axis: THREE.Vector3;
    angle: number;
    minAngle: number;
    maxAngle: number;
    rotateSpeed = Math.PI * 2;
    child: IKLimb;

    debugID = "Rotate: " + Math.random();

    constructor(axis: THREE.Vector3, minAngle: number, maxAngle: number, child: IKLimb) {
        this.axis = axis;
        this.minAngle = minAngle;
        this.maxAngle = maxAngle;
        this.angle = (this.minAngle + this.maxAngle) / 2;
        this.child = child;
    }

    setEndOrientation(q: THREE.Quaternion) {
        this.child.setEndOrientation(q);
    }

    updateMesh(p: THREE.Vector3, q: THREE.Quaternion) {
        let nq = q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(this.axis, this.angle));
        this.child.updateMesh(p, nq);
    }

    update(p: THREE.Vector3, q: THREE.Quaternion, target: THREE.Vector3, deltaTime: number): THREE.Vector3 {
        let nq = q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(this.axis, this.angle));
        let end = this.child.update(p, nq, target, deltaTime);

        let axis = this.axis.clone().applyQuaternion(q);

        let targetLocal = target.clone().sub(p);
        let endLocal = end.clone().sub(p);

        let targetProjectedToPlane = targetLocal.clone().addScaledVector(axis, -targetLocal.dot(axis));
        let endProjectedToPlane = endLocal.clone().addScaledVector(axis, -endLocal.dot(axis));

        if (targetProjectedToPlane.length() < 0.001) { return end; }
        if (endProjectedToPlane.length() < 0.001) { return end; }
        targetProjectedToPlane.normalize();
        endProjectedToPlane.normalize();
        let dir = targetProjectedToPlane.clone().cross(endProjectedToPlane).dot(axis) < 0 ? -1 : 1;
        let angle = -dir * Math.acos(targetProjectedToPlane.dot(endProjectedToPlane));
        if (isNaN(angle)) { return end; }

        let newAngle = this.angle + angle;
        let desiredAngleOffset = mod(newAngle - this.minAngle, Math.PI * 2);
        if (desiredAngleOffset > this.maxAngle - this.minAngle) {
            let fromMin = normalizedAngle(newAngle - this.minAngle);
            let fromMax = normalizedAngle(newAngle - this.maxAngle);
            if (Math.abs(fromMin) < Math.abs(fromMax)) {
                desiredAngleOffset = 0;
            } else {
                desiredAngleOffset = this.maxAngle - this.minAngle;
            }
        }
        
        let currentAngleOffset = this.angle - this.minAngle;
        let angleDiff = desiredAngleOffset - currentAngleOffset;

        angleDiff = clamp(angleDiff, -this.rotateSpeed * deltaTime, this.rotateSpeed * deltaTime);
        
        let previousAngle = this.angle;
        this.angle = clamp(this.angle + angleDiff, this.minAngle, this.maxAngle);
        angleDiff = this.angle - previousAngle;

        debug.angles(this.debugID, [
            { color: new THREE.Color(0xff0000), angle: this.minAngle },
            { color: new THREE.Color(0xff0000), angle: this.maxAngle },
            { color: new THREE.Color(0x0000ff), angle: previousAngle + angle },
            { color: new THREE.Color(0x00ff00), angle: this.angle },
        ]);

        let newEnd = end.clone().sub(p).applyAxisAngle(axis, angleDiff).add(p);

        return newEnd;
    }
}

class RootLimb {
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    child: IKLimb;

    constructor(p: THREE.Vector3, q: THREE.Quaternion, child: IKLimb) {
        this.position = p;
        this.quaternion = q;
        this.child = child;
    }

    setEndOrientation(q: THREE.Quaternion) {
        this.child.setEndOrientation(q);
    }

    updateMesh() {
        this.child.updateMesh(this.position, this.quaternion);
    }

    update(target: THREE.Vector3, deltaTime: number): THREE.Vector3 {
        return this.child.update(this.position, this.quaternion, target, deltaTime);
    }
}

type BipedFootState = {
    tag: "Stepping",
    stepOrigin: THREE.Vector3,
    stepHeight: number,
    // predictedAnchor: THREE.Vector3,
}
| {
    tag: "Planting",
    anchor: THREE.Vector3,
    normal: THREE.Vector3,
}
| {
    tag: "Anchored",
    anchor: THREE.Vector3,
    normal: THREE.Vector3,
};

interface FootInfo {
    legRoot: THREE.Vector3,
    velocity: THREE.Vector3,
    standingHeight: number,
}

class BipedFoot {
    // TODO these static fields should be configurable
    static ANCHOR_LEEWAY = 0.3;
    static PLANT_DISTANCE = 1.0;
    static MAX_PLANTING_TIME = 0.5;
    static STEPPING_TIME = 1.0;
    static STEP_HEIGHT = 0.1;

    up: THREE.Vector3;
    position: THREE.Vector3 = vec3(0, 0, 0);

    state: BipedFootState;
    stateTime: number = 0;

    public normal: THREE.Vector3 = vec3(0, 0, 0);
    public target: THREE.Vector3 = vec3(0, 0, 0);

    constructor(up: THREE.Vector3) {
        this.up = up.clone();
        this.state = {
            tag: "Anchored",
            anchor: vec3(0, 0, 0),
            normal: this.up.clone(),
        };
    }

    predictFootPlacement(footInfo: FootInfo, time: number): THREE.Vector3 {
        let futureLegRoot = footInfo.legRoot.clone().addScaledVector(footInfo.velocity, time);
        let velMag = footInfo.velocity.length();
        if (velMag > 0.01) {
            let directionOfTravel = footInfo.velocity.clone().normalize();
            futureLegRoot.addScaledVector(directionOfTravel, footInfo.standingHeight * 0.25 * clamp(velMag, 0, 1));
        }
        let ray = new THREE.Ray(futureLegRoot, this.up.clone().multiplyScalar(-1));
        let cast = raycastWorld(world, ray, footInfo.standingHeight * 1.5);
        if (cast != null) {
            return ray.at(cast[1].enterT);
        }
        return ray.at(footInfo.standingHeight * 1.5);
    }

    gotoStepping(footInfo: FootInfo) {
        this.stateTime = 0;
        this.state = {
            tag: "Stepping",
            stepOrigin: this.position,
            stepHeight: BipedFoot.STEP_HEIGHT * clamp(this.position.distanceTo(this.predictFootPlacement(footInfo, BipedFoot.STEPPING_TIME)) / 5, 0.5, 1.5),
            // predictedAnchor: this.predictFootPlacement(footInfo, BipedFoot.STEPPING_TIME),
        };
    }

    gotoPlanting() {
        let ray = new THREE.Ray(this.position.clone(), this.up.clone().multiplyScalar(-1));
        let cast = raycastWorld(world, ray, BipedFoot.PLANT_DISTANCE);
        if (cast != null) {
            let [_, intersection] = cast;
            let surfaceNormal = intersection.enterNormal || this.up.clone();
            this.stateTime = 0;
            this.state = {
                tag: "Planting",
                normal: surfaceNormal,
                anchor: ray.at(intersection.enterT),
            };
        }
    }

    update(deltaTime: number, other: BipedFoot, footInfo: FootInfo) {
        this.stateTime += deltaTime;
        switch (this.state.tag) {
            case "Stepping": {
                let t = Math.min(1, this.stateTime / BipedFoot.STEPPING_TIME);

                let predictedAnchor = this.predictFootPlacement(footInfo, (BipedFoot.STEPPING_TIME - (this.stateTime - deltaTime)));

                /*
                let offset = predictedAnchor.clone().sub(this.position);
                let ray = new THREE.Ray(this.position.clone(), offset.normalize());
                let cast = raycastWorld(world, ray, offset.length());
                if (cast != null) {
                    predictedAnchor = ray.at(cast[1].enterT);
                }
                */

                dbgPoints.add(predictedAnchor.clone(), new THREE.Color(0x009900));

                let height =  Math.sin(t * Math.PI) * this.state.stepHeight + mix(this.up.dot(this.state.stepOrigin), this.up.dot(predictedAnchor), t);
                let p = Math.min(1, deltaTime / (BipedFoot.STEPPING_TIME - (this.stateTime - deltaTime)));
                let linearDst = this.position.clone().lerp(predictedAnchor, p);
                linearDst.addScaledVector(this.up, -this.up.dot(linearDst));
                linearDst.addScaledVector(this.up, height);
                this.target.copy(linearDst);
                this.normal.copy(this.up);

                if (this.stateTime > BipedFoot.STEPPING_TIME) {
                    this.gotoPlanting();
                }
            } break;
            case "Planting": {
                this.normal.copy(this.state.normal);
                if (this.position.distanceTo(this.state.anchor) < BipedFoot.ANCHOR_LEEWAY * 0.5) {
                    this.state = {
                        tag: "Anchored",
                        anchor: this.state.anchor,
                        normal: this.state.normal,
                    }
                    this.target.copy(this.state.anchor);
                } else if (this.stateTime > BipedFoot.MAX_PLANTING_TIME) {
                    this.gotoStepping(footInfo);
                } else {
                    this.target.copy(this.state.anchor);
                }
            } break;
            case "Anchored": {
                dbgPoints.add(this.state.anchor.clone(), new THREE.Color(0x000099));
                this.target.copy(this.state.anchor);
                this.normal.copy(this.state.normal);
                if (this.position.distanceTo(this.state.anchor) > BipedFoot.ANCHOR_LEEWAY) {
                    this.gotoStepping(footInfo);
                    if (other.state.tag === "Stepping" && other.stateTime > BipedFoot.STEPPING_TIME / 2) {
                        other.gotoPlanting();
                    }
                } else if (other.state.tag === "Anchored" && this.stateTime >= other.stateTime
                           && this.position.distanceTo(this.predictFootPlacement(footInfo, 0.0)) > 0.05) {
                    this.gotoStepping(footInfo);
                }
            } break;
            default: console.error("Unhandled BipedFootState variant");
        }
    }
}

function addPlayerHitIndicator(source: THREE.Vector3) {
    new HitIndicator(1, source);
}

function processAttack(attacker: Combatant, target: Combatant, deltaTime: number): (() => void)|undefined {
    if (attacker === target) return;
    if (attacker.hasHit.has(target)) return;
    attacker.weapon.mesh.updateMatrixWorld(true);
    target.torso.mesh.updateMatrixWorld(true);
    target.head.mesh.updateMatrixWorld(true);
    let contact: [ConvexShape, THREE.Vector3]|null = null;

    let possibleContacts = (target.isAttacking || target.isParrying) ? [target.weapon, target.head, target.torso] : [target.head, target.torso];
    for (let pc of possibleContacts) {
        if (attacker.weapon.overlaps(pc)) {
            let p = attacker.weapon.worldContactPoint(pc);
            if (p != null) { // ConvexShape removes more face normals than ConvexPolyhedron, so it might incorrectly detect a collision
                contact = [pc, p];
                break;
            }
        }
    }

    if (contact != null) {
        let [contactShape, contactPoint] = contact;
        let previousWeaponContactPoint = attacker.weapon.mesh.worldToLocal(contactPoint.clone()).applyMatrix4(attacker.weapon.previousFrameTransform);
        let previousHitContactPoint = contactShape.mesh.worldToLocal(contactPoint.clone()).applyMatrix4(contactShape.previousFrameTransform);
        let weaponVelocity = contactPoint.clone().sub(previousWeaponContactPoint).divideScalar(deltaTime);
        let hitShapeVelocity = contactPoint.clone().sub(previousHitContactPoint).divideScalar(deltaTime);
        let relativeWeaponVelocity = previousHitContactPoint.clone().sub(previousWeaponContactPoint).divideScalar(deltaTime);
        let damageMultiplier = contactShape === target.weapon ? 0 : (contactShape === target.head ? 2 : 1);
        let damage = relativeWeaponVelocity.lengthSq() / 6 * damageMultiplier;
        if (contactShape === target.weapon) {
            let numParticles = 25;
            for (let i = 0; i < numParticles; i++) {
                particles.push(new TetrahedronParticle(0.6 + Math.random() * 0.6, 0.03, contactPoint, clashParticleMaterial, randomUnitVector().multiplyScalar(1.0 + weaponVelocity.length() / 10).addScaledVector(weaponVelocity, 0.1), false));
            }
        } else {
            let numParticles = clamp(Math.floor(damage), 1, 100);
            for (let i = 0; i < numParticles; i++) {
                particles.push(new TetrahedronParticle(1.0 + Math.random() * 1.0, 0.03, contactPoint, bloodParticleMaterial, randomUnitVector().multiplyScalar(1.0 + weaponVelocity.length() / 10).addScaledVector(weaponVelocity, 0.1), true));
            }
        }
        if (contactShape === target.head) {
            placeSoundAbsolute(playSound("sounds/smash.ogg"), contactPoint);
        } else if (contactShape === target.torso) {
            placeSoundAbsolute(playSound("sounds/enemyhit.wav"), contactPoint);
        } else {
            placeSoundAbsolute(playSound("sounds/parry.ogg"), contactPoint);
        }
        attacker.hitstopT = 0.2;
        attacker.hasHit.add(target);
        if (contactShape === target.weapon) {
            target.velocity.add(relativeWeaponVelocity.clone().multiplyScalar(0.125));
            attacker.velocity.add(relativeWeaponVelocity.clone().multiplyScalar(-0.125));
        } else {
            target.velocity.add(relativeWeaponVelocity.clone().multiplyScalar(0.5));
            attacker.velocity.add(relativeWeaponVelocity.clone().multiplyScalar(-0.25));
        }
        if (target === dbgPlayer) {
            particles.push(new PlayerHitIndicatorParticle(contactPoint.clone()));
            if (contactShape !== target.weapon) {
                addPlayerHitIndicator(attacker.position.clone());
            }
        } else if (contactShape !== target.weapon) {
            return (() => {
                makeDeathParticles(target, contactShape.mesh, relativeWeaponVelocity.clone().multiplyScalar(0.2), contactPoint);
                target.remove();
                combatants = combatants.filter(c => c !== target);
                spawnEnemy();
            });
        }
    }
}

class Combatant {
    head: ConvexShape;
    torso: ConvexShape;
    weapon: ConvexShape;

    position = vec3(0, 0, 0);
    velocity = vec3(0, 0, 0);
    hFacing: number = 0;
    vFacing: number = 0;
    torsoFacing: number = 0;
    handOffset: THREE.Vector3 = vec3(0, -2.2, 0.5);
    weaponDirection = new THREE.Euler(0, 0, 0);

    weaponTrail: SolidTrail;

    isAttacking = false;
    attackT = 0;
    attackFacing = 0;
    attackVFacing = 0;
    attackAnimation: (t: number) => [THREE.Vector3, THREE.Euler] = (t: number) => [vec3(0, 0, 0), new THREE.Euler(0, 0, 0)];
    idleWeaponPose: [THREE.Vector3, THREE.Euler] = [vec3(0, -2.2, 0.5), new THREE.Euler(0, 0, 0)];
    hitstopT = 0;
    attackDuration = 1;
    hasHit = new Set<Combatant>();

    torsoWeaponBridge: THREE.Object3D;

    isDodging = false;
    dodgeT = 0;
    dodgeDir = vec3(0, 0, 0);

    isParrying = false;

    rightArm: RootLimb;
    leftArm: RootLimb;
    rightLeg: RootLimb;
    leftLeg: RootLimb;

    leftFoot: BipedFoot;
    rightFoot: BipedFoot;
    previousPosition = vec3(0, 0, 0);

    legLength: number = 1;

    ai: CombatantAI|null = null;

    root: THREE.Object3D;

    constructor(head: ConvexShape, torso: ConvexShape, weapon: ConvexShape) {
        this.torsoWeaponBridge = new THREE.Object3D();
        this.head = head;
        this.torso = torso;
        this.weapon = weapon;
        this.torso.mesh.add(this.torsoWeaponBridge);
        this.torsoWeaponBridge.add(this.weapon.mesh);
        this.root = new THREE.Object3D();
        scene.add(this.root);
        this.root.add(this.head.mesh);
        this.root.add(this.torso.mesh);

        this.torso.mesh.layers.enable(MINIVIEW_LAYER);
        this.head.mesh.layers.enable(MINIVIEW_LAYER);
        this.weapon.mesh.layers.enable(MINIVIEW_LAYER);

        this.weaponTrail = new SolidTrail(this.weapon.mesh, 10, 0.2);

        let limbMeshRoot = this.torso.mesh;
        this.rightArm = new RootLimb(vec3(0, -0.3, 0.3), new THREE.Quaternion().setFromAxisAngle(vec3(1, 0, 0), Math.PI / 2),
            new RotateLimb(vec3(0, 0, 1), -Math.PI/2, Math.PI,
            new TranslateLimb(0.06, limbMeshRoot,
            new RotateLimb(vec3(0, 1, 0), -Math.PI/2, Math.PI/2,
            new TranslateLimb(0.3, limbMeshRoot,
            new RotateLimb(vec3(0, 1, 0), -Math.PI, 0,
            new TranslateLimb(0.3, limbMeshRoot,
            new EndLimb(limbMeshRoot))))))));

        this.leftArm = new RootLimb(vec3(0, 0.3, 0.3), new THREE.Quaternion().setFromAxisAngle(vec3(1, 0, 0), -Math.PI / 2),
            new RotateLimb(vec3(0, 0, 1), -Math.PI/2, Math.PI,
            new TranslateLimb(0.06, limbMeshRoot,
            new RotateLimb(vec3(0, -1, 0), -Math.PI/2, Math.PI/2,
            new TranslateLimb(0.3, limbMeshRoot,
            new RotateLimb(vec3(0, -1, 0), -Math.PI, 0,
            new TranslateLimb(0.3, limbMeshRoot,
            new EndLimb(limbMeshRoot))))))));

        this.rightLeg = new RootLimb(vec3(0, -0.15, 0), new THREE.Quaternion().setFromAxisAngle(vec3(1, 0, 0), Math.PI),
            new RotateLimb(vec3(1, 0, 0), -Math.PI/4, Math.PI/4,
            new RotateLimb(vec3(0, 1, 0), -Math.PI/2, Math.PI/2,
            new TranslateLimb(this.legLength / 2, limbMeshRoot,
            new RotateLimb(vec3(0, 1, 0), -Math.PI * 0.8, 0,
            new TranslateLimb(this.legLength / 2, limbMeshRoot,
            new EndLimb(limbMeshRoot)))))));

        this.leftLeg = new RootLimb(vec3(0, 0.15, 0), new THREE.Quaternion().setFromAxisAngle(vec3(1, 0, 0), Math.PI),
            new RotateLimb(vec3(1, 0, 0), -Math.PI/4, Math.PI/4,
            new RotateLimb(vec3(0, 1, 0), -Math.PI/2, Math.PI/2,
            new TranslateLimb(this.legLength / 2, limbMeshRoot,
            new RotateLimb(vec3(0, 1, 0), -Math.PI * 0.8, 0,
            new TranslateLimb(this.legLength / 2, limbMeshRoot,
            new EndLimb(limbMeshRoot)))))));

        this.leftFoot = new BipedFoot(vec3(0, 0, 1));
        this.rightFoot = new BipedFoot(vec3(0, 0, 1));
    }

    dbgGenerateShadowMeshes(): THREE.Mesh[] {
        return [this.torso.mesh, this.head.mesh, this.weapon.mesh].map(m => {
            let mp = new THREE.Mesh(extrusionShader.generateExtrudableGeometry(m.geometry as THREE.Geometry), shadowVolumeMaterial);
            mp.frustumCulled = false;
            (mp as any).shadowVolumeParent = m;
            return mp;
        });
    }

    remove() {
        scene.remove(this.root);
        this.weaponTrail.remove();
    }

    toolMesh: THREE.Object3D|null;
    public setToolMesh(toolMesh: THREE.Object3D|null) {
        if (this.toolMesh != null) {
            this.torso.mesh.remove(this.toolMesh);
        }
        this.toolMesh = toolMesh;
        if (this.toolMesh != null) {
            this.torso.mesh.add(this.toolMesh);
        }
        this.weapon.mesh.visible = this.toolMesh == null;
    }

    private updateLegs(deltaTime: number) {
        let velocity = this.position.clone().sub(this.previousPosition).divideScalar(deltaTime);

        this.leftFoot.up = vec3(0, 0, 1).applyQuaternion(this.root.quaternion);
        this.rightFoot.up = vec3(0, 0, 1).applyQuaternion(this.root.quaternion);
        
        this.leftFoot.update(deltaTime, this.rightFoot, {
            legRoot: this.torso.mesh.localToWorld(vec3(0, 0.15, 0)),
            velocity,
            standingHeight: this.legLength * 0.8,
        });
        this.rightFoot.update(deltaTime, this.leftFoot, {
            legRoot: this.torso.mesh.localToWorld(vec3(0, -0.15, 0)),
            velocity,
            standingHeight: this.legLength * 0.8,
        });
        let currentRotation = this.torso.mesh.getWorldQuaternion().clone();
        let leftFootLocalPos = this.leftLeg.update(this.torso.mesh.worldToLocal(this.leftFoot.target.clone()), deltaTime);
        this.leftFoot.position.copy(this.torso.mesh.localToWorld(leftFootLocalPos));
        this.leftLeg.setEndOrientation(new THREE.Quaternion().setFromUnitVectors(vec3(0, 0, 1), this.leftFoot.normal.clone()).premultiply(currentRotation.inverse()));
        this.leftLeg.updateMesh();
        let rightFootLocalPos = this.rightLeg.update(this.torso.mesh.worldToLocal(this.rightFoot.target.clone()), deltaTime);
        this.rightFoot.position.copy(this.torso.mesh.localToWorld(rightFootLocalPos));
        this.rightLeg.setEndOrientation(new THREE.Quaternion().setFromUnitVectors(vec3(0, 0, 1), this.rightFoot.normal.clone()).premultiply(currentRotation.inverse()));
        this.rightLeg.updateMesh();

        dbgPoints.add(this.leftFoot.target.clone());
        dbgPoints.add(this.rightFoot.target.clone());

        this.previousPosition.copy(this.position);
    }

    private updateLimbs(deltaTime: number) {
        this.updateLegs(deltaTime);

        let rightArmEnd = (this.toolMesh || this.weapon.mesh).getWorldPosition();
        this.rightArm.update(this.torso.mesh.worldToLocal(rightArmEnd), deltaTime);
        this.rightArm.updateMesh();

        let leftShoulder = this.torso.mesh.localToWorld(this.leftArm.position.clone());
        let leftTouchyFeely = this.torso.mesh.localToWorld(vec3(0.6, 0, 0.3));
        let leftRay = new THREE.Ray(leftShoulder, leftTouchyFeely.clone().sub(leftShoulder).normalize());
        let leftCast = raycastWorld(world, leftRay, leftTouchyFeely.clone().sub(leftShoulder).length());
        if (leftCast == null) {
            this.leftArm.update(vec3(Math.cos(gameTime * Math.PI * 2) * 0.6, 0.45, 0.0 - Math.abs(Math.sin(gameTime * Math.PI * 2 / 2) * 0.3)), deltaTime);
        } else {
            if (leftCast[1].enterNormal != null) {
                let currentRotation = this.torso.mesh.getWorldQuaternion().clone();
                this.leftArm.setEndOrientation(new THREE.Quaternion().setFromUnitVectors(vec3(0, 0, 1), leftCast[1].enterNormal as THREE.Vector3).premultiply(currentRotation.inverse()));
            }
            this.leftArm.update(this.torso.mesh.worldToLocal(leftRay.at(leftCast[1].enterT)), deltaTime);
        }
        this.leftArm.updateMesh();
    }

    update(deltaTime: number) {
        if (this.ai != null) {
            this.ai.update(deltaTime);
        }
        this.position.addScaledVector(this.velocity, deltaTime);

        if (this.isDodging) {
            this.dodgeT -= deltaTime;
            this.position.addScaledVector(this.dodgeDir, Math.cos((this.dodgeT / 0.2) / (Math.PI / 2.0)) * deltaTime);
        }

        let grounded = false;
        let groundProbe = new ConvexPolyhedron(cubeVertices.map(v => vec3((v.x - 0.5) * 0.5, (v.y - 0.5) * 0.5, 0.0 - v.z * 0.05).add(this.position)));
        for (let solid of world.solids.get(groundProbe.boundingBox().expandByScalar(0.1), [])) {
            let p = groundProbe.getPenetration(solid.shape);
            if (p != null && p.axis.z > 0.5) {
                grounded = true;
                break;
            }
        }

        let gravityDir = vec3(0, 0, -1);
        // let gravityDir = vec3(0, 0, -1).applyQuaternion(this.root.quaternion);

        let collider = new ConvexPolyhedron(cubeVertices.map(v => vec3((v.x - 0.5) * 0.5, (v.y - 0.5) * 0.5, v.z * 2).applyQuaternion(this.root.quaternion).add(this.position)));
        let offset = vec3(0, 0, 0);
        for (let solid of world.solids.get(collider.boundingBox().expandByScalar(0.1), [])) {
            let p = collider.getPenetration(solid.shape);
            if (p != null) {
                let v = p.axis.clone().multiplyScalar(-p.displacement);
                offset.add(v);
                v.normalize();
                if (v.dot(gravityDir) < -0.5) {
                    grounded = true;
                }
                let d = this.velocity.dot(v);
                this.velocity.addScaledVector(v, Math.max(0, -d));
            }
        }
        this.position.addScaledVector(offset, 1);
        if (grounded) {
            if (this.velocity.length() < 1.5) {
                let d = this.velocity.dot(gravityDir);
                this.velocity.set(0, 0, 0).addScaledVector(gravityDir, d);
            }
            this.velocity.addScaledVector(this.velocity, -3 * deltaTime);
        } else {
            this.velocity.addScaledVector(gravityDir, 10 * deltaTime);
            this.velocity.addScaledVector(this.velocity, -0.5 * deltaTime);
        }

        if (this.isAttacking) {
            this.torsoWeaponBridge.rotation.y = -this.attackVFacing;
            if (this.hitstopT > 0) {
                this.hitstopT -= deltaTime;
                deltaTime *= 0.05;
            }
            deltaTime /= this.attackDuration;

            this.attackT += deltaTime;
            let turnEndTime = 0.5;
            if (this.attackT - deltaTime < turnEndTime) {
                let startTime = this.attackT - deltaTime;
                let endTime = Math.min(turnEndTime, this.attackT);
                let turnTime = endTime - startTime;
                let diff = normalizedAngle(this.attackFacing - this.torsoFacing);
                let portionToMove = turnTime / (turnEndTime - startTime);
                this.torsoFacing += diff * portionToMove;
            }

            let [offset, rotation] = this.attackAnimation(this.attackT);
            this.handOffset = offset;
            this.weaponDirection.copy(rotation);
            if (this.attackT > 1) {
                this.hasHit.clear();
                this.hitstopT = 0;
                this.isAttacking = false;
            }
        } else if (this.isDodging) {
            this.torsoWeaponBridge.rotation.y = -this.vFacing;
            let [offset, rotation] = this.idleWeaponPose;
            this.handOffset = offset;
            this.weaponDirection.copy(rotation);
            if (this.dodgeT <= 0) {
                this.isDodging = false;
            }
        } else {
            let spinRate = Math.PI * 2 / 3 * deltaTime;
            let diff = clamp(normalizedAngle(this.hFacing - this.torsoFacing), -spinRate, spinRate);
            this.torsoFacing += diff;
            this.torsoWeaponBridge.rotation.y = -this.vFacing;
            let [offset, rotation] = this.idleWeaponPose;
            this.handOffset = offset;
            this.weaponDirection.copy(rotation);
        }

        this.weaponTrail.update();
        this.weaponTrail.enabled = this.isAttacking;

        this.root.position.copy(this.position);

        this.torso.mesh.position.set(0, 0, 0.6);
        this.torso.mesh.rotation.set(0, 0, this.torsoFacing);

        this.head.mesh.rotation.set(0, 0, 0);
        this.head.mesh.rotateOnAxis(new THREE.Vector3(0, 0, 1), this.hFacing);
        this.head.mesh.rotateOnAxis(new THREE.Vector3(0, 1, 0), -this.vFacing);

        this.head.mesh.position.set(0, 0, 1.05).add(neckCrane(this.hFacing, this.vFacing).multiplyScalar(0.15));

        // let weaponOffset = this.position.clone().add(this.handOffset.clone().applyAxisAngle(vec3(0, 0, 1), this.torsoFacing));
        // this.weapon.mesh.position.copy(weaponOffset);
        this.weapon.mesh.position.copy(this.handOffset);
        this.weapon.mesh.rotation.copy(this.weaponDirection);

        this.updateLimbs(deltaTime);
    }
}

class CombatantAI {
    combatant: Combatant;
    target: Combatant|null = null;
    delayedActions: ((deltaTime: number) => void)[] = [];
    constructor(c: Combatant) {
        this.combatant = c;
    }
    update(deltaTime: number) {
        let roll = Math.cos(gameTime * Math.PI * 2 / 10) * Math.PI;
        if (!this.combatant.isAttacking && (Math.random() < probInterval(0.5, deltaTime) || justPressedKeys.has(VK.X))) {
            placeSoundAbsolute(playSound("sounds/whiff.ogg"), this.combatant.weapon.mesh.getWorldPosition());
            this.combatant.isAttacking = true;
            this.combatant.attackT = 0;
            this.combatant.attackFacing = this.combatant.hFacing;
            this.combatant.attackVFacing = this.combatant.vFacing;
            this.combatant.attackAnimation = rollableAttackAnimation(roll);
            this.combatant.attackDuration = 1;
        }
        this.combatant.idleWeaponPose = rollableAttackAnimation(roll)(0);

        if (this.target == null) return;
        let to = this.target.position.clone().sub(this.combatant.position);
        let toLocal = to.clone().transformDirection(new THREE.Matrix4().getInverse(this.combatant.root.matrixWorld));
        let desiredHFacing = Math.atan2(toLocal.y, toLocal.x);
        let desiredVFacing = Math.atan2(toLocal.z, Math.sqrt(toLocal.x * toLocal.x + toLocal.y * toLocal.y));
        let toFlat = to.clone().setZ(0);
        let velocity: THREE.Vector3;
        if (toFlat.length() > 10) {
            velocity = toFlat.clone().normalize().multiplyScalar(5);
        } else {
            velocity = vec3(0, 0, 0);
        }
        this.delayedActions.push((deltaTime) => {
            this.combatant.hFacing = desiredHFacing;
            this.combatant.vFacing = desiredVFacing;
            if (!this.combatant.isAttacking) {
                this.combatant.position.addScaledVector(velocity, deltaTime);
            }
        });
        // TODO: remove hardcoded frame delay in favor of time-based one
        if (this.delayedActions.length > 15) {
            this.delayedActions.shift()!(deltaTime);
        }
    }
}

let wireframeMaterial = new THREE.MeshBasicMaterial({ color: "magenta", wireframe: true, opacity: 0.5, blending: THREE.NormalBlending, transparent: true });

let white64x64 = new Image();
white64x64.src = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAkklEQVR4nO3QQREAAAiAMPuX1hh7yBJwzD43OkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAO0ARtDDsqXe37wAAAAASUVORK5CYII=";
class Miniview {
    camera: THREE.OrthographicCamera;
    whiteTexture: THREE.Texture;

    constructor(public target: Combatant) {
        let aspect = canvas.width / canvas.height;
        this.camera = new THREE.OrthographicCamera(-3 * aspect, 3 * aspect, 3, -3, -100, 100);
        this.camera.layers.set(MINIVIEW_LAYER);
        white64x64.onload = () => {
            this.whiteTexture = new THREE.Texture(white64x64);
            this.whiteTexture.needsUpdate = true;
        };
    }

    render() {
        renderer.clearDepth();
        let w = Math.floor(canvas.width * 0.2);
        let h = Math.floor(canvas.height * 0.2);
        let l = Math.floor(canvas.width * 0.4);
        let b = Math.floor(canvas.height * 0.1);
        renderer.setViewport(l, b, w, h);
        this.camera.rotation.set(0, 0, 0);
        this.camera.rotateOnAxis(vec3(0, 0, 1), hFacing - Math.PI / 2);
        this.camera.position.copy(this.target.position).add(vec3(0, 0, 5));
        setupExtendedUniforms(scene, this.camera, {texture: this.whiteTexture, width: w, height: h, left: l, bottom: b}, this.whiteTexture, this.whiteTexture);
        renderer.render(scene, this.camera);
        renderer.setViewport(0, 0, canvas.width, canvas.height);
    }
}

function neckCrane(theta: number, phi: number): THREE.Vector3 {
    let facingVec = vec2(1, 0).rotateAround(vec2(0, 0), theta).multiplyScalar(Math.sin(-phi));
    return vec3(facingVec.x, facingVec.y, Math.cos(-phi));
}

function makeConvexGeo(points: THREE.Vector3[]): THREE.Geometry {
    let geo = worldsolids.convexHull3D(points);
    if (geo == null) {
        console.warn("Couldn't make convex shape");
        geo = new THREE.CubeGeometry(1, 1, 1);
    }
    geo.computeFaceNormals();
    geo.computeBoundingSphere();
    return geo;
}

let torsoGeo = makeConvexGeo(cubeVertices.map(v => {
    let vertex = v.clone();
    vertex.x -= 0.5;
    vertex.y -= 0.5;
    if (vertex.z === 1) {
        vertex.y *= 2;
        vertex.z = 1.5;
    }
    vertex.multiplyScalar(0.3);
    return vertex;
}));

let headGeo = makeConvexGeo(cubeVertices.map(v => {
    let vertex = v.clone();
    vertex.x -= 0.5;
    vertex.y -= 0.5;
    vertex.y *= 0.75;
    vertex.multiplyScalar(0.3);
    return vertex;
}));

let weaponGeo = makeConvexGeo(cubeVertices.map(v => {
    let vertex = v.clone();
    vertex.x -= 0.5;
    vertex.y -= 0.5;
    vertex.x *= 0.5;
    vertex.y *= 0.5;
    vertex.z *= 4;
    vertex.multiplyScalar(0.3);
    return vertex;
}));

let playerMaterial = makeExtendedMaterial(0xffff00);
export let dbgPlayer = new Combatant(
    new ConvexShape(new THREE.Mesh(headGeo, playerMaterial)),
    new ConvexShape(new THREE.Mesh(torsoGeo, playerMaterial)),
    new ConvexShape(new THREE.Mesh(weaponGeo, playerMaterial)),
);
combatants.push(dbgPlayer);
dbgPlayer.dbgGenerateShadowMeshes().forEach(m => shadowVolumeScene.add(m));

let enemyMaterial = makeExtendedMaterial(0x00ffff);
export function spawnEnemy() {
    let enemy = new Combatant(
        new ConvexShape(new THREE.Mesh(headGeo, enemyMaterial)),
        new ConvexShape(new THREE.Mesh(torsoGeo, enemyMaterial)),
        new ConvexShape(new THREE.Mesh(weaponGeo, enemyMaterial)),
    );
    combatants.push(enemy);
    enemy.ai = new CombatantAI(enemy);
    enemy.ai.target = dbgPlayer;
}
spawnEnemy();

let miniview = new Miniview(dbgPlayer);

export let world = World.fromSerialized([
    {
        isRoot: true,
        color: 0x0000ff,
        points: cubeVertices.map(({x, y, z}) => [x * 2 + 5, y * 2, z * 2]),
        attachedIndices: [],
    },
    {
        isRoot: true,
        color: 0xffff00,
        points: cubeVertices.map(({x, y, z}) => [x * 1 + 5, y * 1 - 4, z * 1]),
        attachedIndices: [],
    },
]);

{
    let tempWorld = World.fromSerialized([{
        isRoot: true,
        color: 0x00ffff,
        points: cubeVertices.map(({x, y, z}) => [x * 10, y * 10, z * 1 - 4.4]),
        attachedIndices: [],
    }]);
    // console.log(world.add(tempWorld.solids.getAll([])[0]));
}

{
    // Add some terrain generated from a height function
    function height(x: number, y: number): number {
        return Math.cos(x / 100) * Math.cos(y / 100) * 50 + Math.sin(x / 10) * Math.sin(y / 20) * 3 - Math.cos(x / 1000) * Math.cos(y / 1200) * 500 + 450;
    }
    let s = 20;
    let a = 10;
    for (let i = -a; i < a; i++) {
        for (let j = -a; j < a; j++) {
            let x = i * s;
            let y = j * s;
            let solid = new WorldSolid();
            solid.attached = [];
            solid.isRoot = true;
            solid.color = new THREE.Color(0x009900);
            function corner(x: number, y: number): THREE.Vector3 {
                return vec3(x, y, height(x, y));
            }
            let corners = [
                corner(x, y),
                corner(x + s, y),
                corner(x, y + s),
                corner(x + s, y + s)
            ];
            solid.shape = new ConvexPolyhedron(corners.concat(corners.map(v => v.clone().setZ(v.z - s))));
            world.add(solid);
            // console.log(world.add(solid));
        }
    }
}
{
    let s = 50;
    let a = 10;
    for (let i = -a; i < a; i++) {
        for (let j = -a; j < a; j++) {
            let x = i * s;
            let y = j * s;
            let solid = new WorldSolid();
            solid.attached = [];
            solid.isRoot = true;
            solid.color = new THREE.Color(mod(i, 2) === mod(j, 2) ? 0x000099 : 0xffffff);
            function corner(x: number, y: number): THREE.Vector3 {
                return vec3(x, y, -50);
            }
            let corners = [
                corner(x, y),
                corner(x + s, y),
                corner(x, y + s),
                corner(x + s, y + s)
            ];
            solid.shape = new ConvexPolyhedron(corners.concat(corners.map(v => v.clone().setZ(v.z - s))));
            world.add(solid);
        }
    }
}

export let dbgShowRoots = false;
let dbgRootColor = new THREE.Color(0x00ff00);
let dbgNonRootColor = new THREE.Color(0xff0000);

function makeGeometryFromSolid(solid: WorldSolid) {
    let geometry = new THREE.Geometry();
    for (let reached of graphIterator(solid, t => t.attached)) {
        for (let face of reached.shape.geometry.faces) {
            face.color = reached.color;
        }
        geometry.merge(reached.shape.geometry, undefined as any);
    }
    return geometry;
}

function makeGeometryFromWorld() {
    let worldGeometry = new THREE.Geometry();
    world.solids.getAll([]).forEach(solid => {
        for (let face of solid.shape.geometry.faces) {
            if (dbgShowRoots) {
                face.color = solid.isRoot ? dbgRootColor : dbgNonRootColor;
            } else {
                face.color = solid.color;
            }
        }
        worldGeometry.merge(solid.shape.geometry, undefined as any);
    });
    return worldGeometry;
}
export let worldMesh: THREE.Mesh = undefined as any;
export let worldShadowVolume: THREE.Mesh = undefined as any;

function updateWorldMesh() {
    if (worldMesh != null) {
        scene.remove(worldMesh);
    }
    worldMesh = new THREE.Mesh(makeGeometryFromWorld(), worldMaterial);
    worldMesh.castShadow = true;
    worldMesh.receiveShadow = true;
    scene.add(worldMesh);
    if (worldShadowVolume != null) {
        shadowVolumeScene.remove(worldShadowVolume);
    }
    worldShadowVolume = generateWorldShadowVolume();
    worldShadowVolume.frustumCulled = false;
    shadowVolumeScene.add(worldShadowVolume);
}

updateWorldMesh();

let dbgNormals: THREE.FaceNormalsHelper|null = null;

export function exportWorld() {
    // https://stackoverflow.com/questions/16329293/save-json-string-to-client-pc-using-html5-api
    let serialized = JSON.stringify(world.serialize());
    let blob = new Blob([serialized], {type: "application/json"});
    let url = URL.createObjectURL(blob);
    let anchor = document.createElement('a');
    anchor.download = "world.json";
    anchor.href = url;
    anchor.click();
}
window.addEventListener("keydown", (evt) => {
    if (evt.which === VK.P) {
        exportWorld();
    }
});
export function importWorld() {
    let input = document.createElement('input');
    input.setAttribute("type", "file");
    input.setAttribute("accept", ".json");
    input.click();
    input.onchange = () => {
        let files = input.files;
        if (files != null && files.length > 0) {
            let file = files.item(0);
            let reader = new FileReader();
            reader.readAsText(file);
            reader.onload = () => {
                world = World.fromSerialized(JSON.parse(reader.result));
                updateWorldMesh();
            };
        }
    };
}
window.addEventListener("keydown", (evt) => {
    if (evt.which === VK.O) {
        importWorld();
    }
});
export function saveWorld(name: string) {
    localStorage[name] = JSON.stringify(world.serialize());
}
export function loadWorld(name: string) {
    world = World.fromSerialized(JSON.parse(localStorage[name]));
    updateWorldMesh();
}
export function deleteWorld(name: string) {
    delete localStorage[name];
}
export function listWorlds(): string[] {
    let arr: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        arr.push(localStorage.key(i) as string);
    }
    return arr;
}
export function loadRemoteWorld(name: string) {
    xhrPromise("worlds/" + name, "json").then(response => {
        world = World.fromSerialized(response);
        updateWorldMesh();
    });
}

renderer.physicallyCorrectLights = true;

setEditor(exports);