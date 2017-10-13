export let worldVertexShader = `
#define PHYSICAL

varying vec3 vViewPosition;

#ifndef FLAT_SHADED

	varying vec3 vNormal;

#endif

#include <common>
#include <uv_pars_vertex>
#include <uv2_pars_vertex>
#include <displacementmap_pars_vertex>
#include <color_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>

void main() {

	#include <uv_vertex>
	#include <uv2_vertex>
	#include <color_vertex>

	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>

#ifndef FLAT_SHADED // Normal computed with derivatives when FLAT_SHADED

	vNormal = normalize( transformedNormal );

#endif

	#include <begin_vertex>
	#include <displacementmap_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>

	vViewPosition = - mvPosition.xyz;

	#include <worldpos_vertex>
	#include <shadowmap_vertex>

}
`;
export let worldFragmentShader = `
#define PHYSICAL

uniform vec3 diffuse;
uniform vec3 emissive;
uniform float roughness;
uniform float metalness;
uniform float opacity;

#ifndef STANDARD
	uniform float clearCoat;
	uniform float clearCoatRoughness;
#endif

varying vec3 vViewPosition;

#ifndef FLAT_SHADED

	varying vec3 vNormal;

#endif

#include <common>
#include <packing>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <uv2_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <envmap_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <cube_uv_reflection_fragment>
#include <lights_pars>
#include <lights_physical_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <roughnessmap_pars_fragment>
#include <metalnessmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>

uniform sampler2D uSSAOTexture;
uniform sampler2D depthMap;
uniform vec2 viewportOffset;
uniform vec2 size; // viewportSize and also the depthMap's size

#define fragUV ((gl_FragCoord.xy - viewportOffset.xy) / size)

// ===========================
// Cascaded shadow mapping

uniform mat4 shadowCascadeMatrix[NUM_SHADOW_CASCADES];
uniform mat4 shadowCascadeMatrixInv[NUM_SHADOW_CASCADES];
uniform sampler2D shadowCascadeMap[NUM_SHADOW_CASCADES];
uniform vec2 shadowCascadeSize[NUM_SHADOW_CASCADES];
uniform float shadowCascadeBias[NUM_SHADOW_CASCADES];

float sampleSpecificCascade(float depth, vec2 shadowCoord, sampler2D tex) {
    float shadowDepth = texture2D(tex, shadowCoord.xy).x;
    if (depth > shadowDepth) {
        return 0.0;
    } else {
        return 1.0;
    }
}

float samplePCF(float depth, vec2 shadowCoord, mat2 rot, sampler2D tex) {
    return (
        sampleSpecificCascade(depth, shadowCoord + rot * vec2( 0, -1), tex) +
        sampleSpecificCascade(depth, shadowCoord + rot * vec2(-1,  0), tex) +
        sampleSpecificCascade(depth, shadowCoord + rot * vec2( 0,  1), tex) +
        sampleSpecificCascade(depth, shadowCoord + rot * vec2( 1,  0), tex) +
        sampleSpecificCascade(depth, shadowCoord + rot * vec2( 0,  0), tex) +
        sampleSpecificCascade(depth, shadowCoord + rot * vec2(-1, -1), tex) +
        sampleSpecificCascade(depth, shadowCoord + rot * vec2(-1,  1), tex) +
        sampleSpecificCascade(depth, shadowCoord + rot * vec2( 1, -1), tex) +
        sampleSpecificCascade(depth, shadowCoord + rot * vec2( 1,  1), tex)
    ) / 9.0;
}

float sampleCascade(vec3 ndc) {
    for (int i = 0; i < NUM_SHADOW_CASCADES; i++) {
        vec4 shadowCoord = shadowCascadeMatrix[i] * vec4(ndc, 1.0);
        shadowCoord /= shadowCoord.w;
        shadowCoord = shadowCoord / 2.0 + vec4(0.5);
        if (shadowCoord.x < 0.0 || shadowCoord.x > 1.0 || shadowCoord.y < 0.0 || shadowCoord.y > 1.0) {
            continue;
        } else {
            float angle = rand(fragUV);
            float s = sin(angle);
            float c = cos(angle);
            vec2 texel = vec2(1.0) / shadowCascadeSize[i];
            mat2 rot = mat2(texel.x, 0.0, 0.0, texel.y) * mat2(c, s, -s, c);
            float depth = shadowCoord.z - shadowCascadeBias[i];
            return samplePCF(depth, shadowCoord.xy, rot, shadowCascadeMap[i]);
        }
    }

    return 1.0;
}

uniform sampler2D uStencilShadowTexture;

float shadowValue() {
    if (texture2D(uStencilShadowTexture, fragUV).x == 0.0) {
        return 0.0;
    } else {
        vec3 ndc = vec3(fragUV, gl_FragCoord.z) * 2.0 - vec3(1.0);
        return sampleCascade(ndc);
    }
}

// Assuming a 24-bit depth buffer
#define DEPTH_BUFFER_RANGE 16777216.0

void main() {

    #include <clipping_planes_fragment>
    
    float depth = texture2D(depthMap, fragUV).x;
    // gl_FragCoord.z is higher precision than what gets stored in the depth buffer
    // a 32-bit float has a 23-bit mantissa, so maybe lowering by 2**-24 is just coincidentally a good way to slightly
    // reduce all values [0, 1) and it has nothing to do with number of depth buffer bits?
    float fragDepth = gl_FragCoord.z - 1.0 / DEPTH_BUFFER_RANGE;
    if (fragDepth > depth) { discard; }

	vec4 diffuseColor = vec4( diffuse, opacity );
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;

	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <specularmap_fragment>
	#include <roughnessmap_fragment>
	#include <metalnessmap_fragment>
	#include <normal_flip>
	#include <normal_fragment>
	#include <emissivemap_fragment>

	// accumulation
	#include <lights_physical_fragment>
    // include <lights_template>
    //========= Start of Custom lights_template
    GeometricContext geometry;
    
    geometry.position = - vViewPosition;
    geometry.normal = normal;
    geometry.viewDir = normalize( vViewPosition );
    
    IncidentLight directLight;
    
    #if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )
    
        PointLight pointLight;
    
        for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {
    
            pointLight = pointLights[ i ];
    
            getPointDirectLightIrradiance( pointLight, geometry, directLight );
    
            #ifdef USE_SHADOWMAP
            directLight.color *= all( bvec2( pointLight.shadow, directLight.visible ) ) ? getPointShadow( pointShadowMap[ i ], pointLight.shadowMapSize, pointLight.shadowBias, pointLight.shadowRadius, vPointShadowCoord[ i ] ) : 1.0;
            #endif
    
            RE_Direct( directLight, geometry, material, reflectedLight );
    
        }
    
    #endif
    
    #if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )
    
        SpotLight spotLight;
    
        for ( int i = 0; i < NUM_SPOT_LIGHTS; i ++ ) {
    
            spotLight = spotLights[ i ];
    
            getSpotDirectLightIrradiance( spotLight, geometry, directLight );
    
            #ifdef USE_SHADOWMAP
            directLight.color *= all( bvec2( spotLight.shadow, directLight.visible ) ) ? getShadow( spotShadowMap[ i ], spotLight.shadowMapSize, spotLight.shadowBias, spotLight.shadowRadius, vSpotShadowCoord[ i ] ) : 1.0;
            #endif
    
            RE_Direct( directLight, geometry, material, reflectedLight );
    
        }
    
    #endif
    
    #if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )
    
        DirectionalLight directionalLight;
    
        for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
    
            directionalLight = directionalLights[ i ];
    
            getDirectionalDirectLightIrradiance( directionalLight, geometry, directLight );
    
            directLight.color *= shadowValue();
            //#ifdef USE_SHADOWMAP
            //directLight.color *= all( bvec2( directionalLight.shadow, directLight.visible ) ) ? getShadow( directionalShadowMap[ i ], directionalLight.shadowMapSize, directionalLight.shadowBias, directionalLight.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
            //#endif
    
            RE_Direct( directLight, geometry, material, reflectedLight );
    
        }
    
    #endif
    
    #if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )
    
        RectAreaLight rectAreaLight;
    
        for ( int i = 0; i < NUM_RECT_AREA_LIGHTS; i ++ ) {
    
            rectAreaLight = rectAreaLights[ i ];
            RE_Direct_RectArea( rectAreaLight, geometry, material, reflectedLight );
    
        }
    
    #endif
    
    #if defined( RE_IndirectDiffuse )
    
        vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );
    
        #ifdef USE_LIGHTMAP
    
            vec3 lightMapIrradiance = texture2D( lightMap, vUv2 ).xyz * lightMapIntensity;
    
            #ifndef PHYSICALLY_CORRECT_LIGHTS
    
                lightMapIrradiance *= PI; // factor of PI should not be present; included here to prevent breakage
    
            #endif
    
            irradiance += lightMapIrradiance;
    
        #endif
    
        #if ( NUM_HEMI_LIGHTS > 0 )
    
            for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {
    
                irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometry );
    
            }
    
        #endif
    
        #if defined( USE_ENVMAP ) && defined( PHYSICAL ) && defined( ENVMAP_TYPE_CUBE_UV )
    
            // TODO, replace 8 with the real maxMIPLevel
             irradiance += getLightProbeIndirectIrradiance( /*lightProbe,*/ geometry, 8 );
    
        #endif
    
        RE_IndirectDiffuse( irradiance, geometry, material, reflectedLight );
    
    #endif
    
    #if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
    
        // TODO, replace 8 with the real maxMIPLevel
        vec3 radiance = getLightProbeIndirectRadiance( /*specularLightProbe,*/ geometry, Material_BlinnShininessExponent( material ), 8 );
    
        #ifndef STANDARD
            vec3 clearCoatRadiance = getLightProbeIndirectRadiance( /*specularLightProbe,*/ geometry, Material_ClearCoat_BlinnShininessExponent( material ), 8 );
        #else
            vec3 clearCoatRadiance = vec3( 0.0 );
        #endif
            
        RE_IndirectSpecular( radiance, clearCoatRadiance, geometry, material, reflectedLight );
    
    #endif
    //========= End of Custom lights_template


	// modulation
	#include <aomap_fragment>

    #ifndef AO_DISABLED
        float ao = texture2D(uSSAOTexture, fragUV).x;
    #else
        float ao = 1.0;
    #endif
	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse * ao + reflectedLight.directSpecular + reflectedLight.indirectSpecular * ao + totalEmissiveRadiance;

    gl_FragColor = vec4( outgoingLight, diffuseColor.a );

	#include <premultiplied_alpha_fragment>
	#include <tonemapping_fragment>
	#include <encodings_fragment>
	#include <fog_fragment>

}
`;