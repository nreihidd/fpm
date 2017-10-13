let ssaoFragmentShader = `
    // ===========================
    // Ambient occlusion
    uniform sampler2D depthMap;
    uniform vec2 size; // depthMap's size

    uniform mat4 worldToView;
    uniform mat4 viewToWorld;

    varying vec2 fragUV;
    
    #ifndef SAMPLES
        #define SAMPLES 8
    #endif
    // https://stackoverflow.com/questions/4200224/random-noise-functions-for-glsl#4275343
    float rand(vec2 co) {
        return fract(sin(dot(co.xy ,vec2(12.9898,78.233))) * 43758.5453);
    }
    vec3 randVec(vec2 co) {
        vec2 offset = vec2(0.013, 0.07);
        return vec3(rand(co + offset), rand(co), rand(co - offset)) * 2.0 - vec3(1.0, 1.0, 1.0);
    }
    vec3 randSphereVec(vec2 co) {
        vec2 offset = vec2(0.013, 0.07);
        float r1 = rand(co + offset);
        float r2 = rand(co);
        float r3 = rand(co - offset);
        // https://math.stackexchange.com/questions/87230/picking-random-points-in-the-volume-of-sphere-with-uniform-probability
        float theta = r1 * 3.1415926 * 2.0;
        float phi = acos(r2 * 2.0 - 1.0);
        float r = pow(r3, 1.0 / 3.0);
        float r_sine_theta = r * sin(theta);
        return vec3(cos(phi) * r_sine_theta, sin(phi) * r_sine_theta, r * cos(theta));
    }
    vec3 readWorldPos(vec2 coord) {
        float z = 2.0 * texture2D(depthMap, coord).x - 1.0;
        vec4 worldPos = viewToWorld * vec4(2.0 * coord - vec2(1.0), z, 1.0);
        return worldPos.xyz / worldPos.w;
    }
    vec2 clipToUV(vec2 clipPos) {
        vec2 uv = (clipPos + vec2(1.0)) / 2.0; // Might be upside-down?
        // Snap to samples (sampling with linear interpolation doesn't work since the depth isn't stored linearly)
        return floor(uv * size) / size;
    }
    vec3 getOcclusion(vec3 worldPos) {
        vec4 viewPos = worldToView * vec4(worldPos, 1.0);
        vec2 clipPos = viewPos.xy / viewPos.w;

        return readWorldPos(clipToUV(clipPos));
    }
    float hemisphereSample(vec3 worldPos, vec3 worldNormal, vec3 sampleOffset, float sampleRadius, out float weight) {
        float d = dot(sampleOffset, worldNormal);
        vec3 samplePos = worldPos + sampleOffset + worldNormal * (abs(d) - d);
        vec3 sampled = getOcclusion(samplePos);
        float obstruction = dot(worldNormal, normalize(sampled - worldPos));
        float len = length(sampled - worldPos);
        if (len > sampleRadius * 1.01) {
            weight = 0.0;
            return 1.0;
        }
        weight = 1.0;
        if (obstruction > 0.3) {
            return pow(len / sampleRadius, 2.0);
        } else {
            return 1.0;
        }
    }
    float hemisphereAO(vec3 worldPos, vec3 worldNormal, float sampleRadius) {
        float ao = 0.01;
        float totalWeight = 0.01;
        for ( int i = 0; i < SAMPLES; i++ ) {
            vec3 sampleDir = sampleRadius * randSphereVec(fragUV + vec2(1.61, 1.07) * float(i));

            float weight = 0.0;
            float magnitude = hemisphereSample(worldPos, worldNormal, sampleDir, sampleRadius, weight);
            ao += magnitude * weight;
            totalWeight += weight;
        }
        return ao / totalWeight;
    }
    float getAmbientFactor() {
        vec3 worldPos = readWorldPos(fragUV);
        vec3 dWdx = dFdx(readWorldPos(fragUV));
        vec3 dWdy = dFdy(readWorldPos(fragUV));
        vec3 worldNormal = normalize(cross(dWdx, dWdy));
        
        float distance = length(worldPos);
        float sampleRadius = max(0.05, distance * 0.5 / 5.0); // 0.5m radius for 5m distance

        float ao = hemisphereAO(worldPos, worldNormal, sampleRadius);
        return ao;
    }

    void main() {
        float ao = getAmbientFactor();
        gl_FragColor = vec4(ao, ao, ao, 1.0);
    }
`;

let ssaoMaterial = new THREE.ShaderMaterial(<any>{
    uniforms: {
        depthMap: { value: null },
        size: { value: null },
    
        worldToView: { value: null },
        viewToWorld: { value: null },
    },
    vertexShader: `
        varying vec2 fragUV;
        void main() {
            fragUV = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
    `,
    fragmentShader: ssaoFragmentShader,
    extensions: { derivatives: true },
});

let camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
let scene = new THREE.Scene();
let quad = new THREE.Mesh(new THREE.PlaneBufferGeometry( 2, 2 ), ssaoMaterial);
quad.frustumCulled = false;
scene.add(quad);

export function generateSSAO(renderer: THREE.WebGLRenderer, depth: THREE.Texture, depthSize: THREE.Vector2, worldToView: THREE.Matrix4, viewToWorld: THREE.Matrix4, target: THREE.WebGLRenderTarget) {
    ssaoMaterial.uniforms.depthMap.value = depth;
    ssaoMaterial.uniforms.size.value = depthSize;
    ssaoMaterial.uniforms.worldToView.value = worldToView;
    ssaoMaterial.uniforms.viewToWorld.value = viewToWorld;
    renderer.render(scene, camera, target);
}