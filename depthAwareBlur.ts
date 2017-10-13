// TODO: not yet depth aware; doesn't use the provided depth texture at all

// https://en.wikipedia.org/wiki/Gaussian_blur
function gaussian(stddev: number, x: number): number {
    return 1.0 / Math.sqrt(2.0 * Math.PI * stddev**2) * Math.E**(-x * x / (2.0 * stddev**2))
}
function* range(low: number, high: number) {
    for (let x = low; x <= high; x++) {
        yield x;
    }
}
let blurStddev = 3;
let blurSampleDist = Math.floor(blurStddev * 3);
let blurKernel = Array.from(range(-blurSampleDist, blurSampleDist)).map(x => [x, gaussian(blurStddev, x)]);
export let dbgBlurKernel = blurKernel;

let blurFragmentShaderHorizontal = `
    uniform sampler2D uTexture;
    uniform sampler2D uDepth;
    uniform vec2 uTextureSize;

    varying vec2 vUv;
    void main() {
        vec2 dv = vec2(1.0 / uTextureSize.x, 0.0);
        float value = (
            ${blurKernel.map(([x, m]) => `texture2D(uTexture, vUv + dv * ${x.toFixed(1)}).x * ${m}`).join(" + \n")}
        );
        gl_FragColor = vec4(value, value, value, 1.0);
    }
`;
let blurFragmentShaderVertical = `
    uniform sampler2D uTexture;
    uniform sampler2D uDepth;
    uniform vec2 uTextureSize;

    varying vec2 vUv;
    void main() {
        vec2 dv = vec2(0.0, 1.0 / uTextureSize.y);
        float value = (
            ${blurKernel.map(([x, m]) => `texture2D(uTexture, vUv + dv * ${x.toFixed(1)}).x * ${m}`).join(" + \n")}
        );
        gl_FragColor = vec4(value, value, value, 1.0);
    }
`;

let horizontalMaterial = new THREE.ShaderMaterial({
    uniforms: {
        uTexture: { value: null },
        uDepth: { value: null },
        uTextureSize: { value: null }
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
    `,
    fragmentShader: blurFragmentShaderHorizontal
});
export let verticalMaterial = new THREE.ShaderMaterial({
    uniforms: {
        uTexture: { value: null },
        uDepth: { value: null },
        uTextureSize: { value: null }
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
    `,
    fragmentShader: blurFragmentShaderVertical
});

let camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
let scene = new THREE.Scene();
let quad = new THREE.Mesh(new THREE.PlaneBufferGeometry( 2, 2 ), horizontalMaterial);
quad.frustumCulled = false;
scene.add(quad);

export function blurHorizontal(renderer: THREE.WebGLRenderer, textureSize: THREE.Vector2, texture: THREE.Texture, depth: THREE.Texture, target: THREE.WebGLRenderTarget) {
    // No clearing necessary, will overwrite every pixel anyway
    quad.material = horizontalMaterial;
    horizontalMaterial.uniforms.uTextureSize.value = textureSize.clone();
    horizontalMaterial.uniforms.uTexture.value = texture;
    horizontalMaterial.uniforms.uDepth.value = depth;
    renderer.render(scene, camera, target);
}
export function blurVertical(renderer: THREE.WebGLRenderer, textureSize: THREE.Vector2, texture: THREE.Texture, depth: THREE.Texture, target: THREE.WebGLRenderTarget) {
    // No clearing necessary, will overwrite every pixel anyway
    quad.material = verticalMaterial;
    verticalMaterial.uniforms.uTextureSize.value = textureSize.clone();
    verticalMaterial.uniforms.uTexture.value = texture;
    verticalMaterial.uniforms.uDepth.value = depth;
    renderer.render(scene, camera, target);
}