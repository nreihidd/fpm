function* range(n: number): IterableIterator<number> {
	for (let i = 0; i < n; i++) {
		yield i;
	}
}

export class ShadowMap {
	public shadowCamera: THREE.OrthographicCamera;
	public shadowTarget: THREE.WebGLRenderTarget;
	public wantRenderThisFrame: boolean = true;
	constructor(camera: THREE.OrthographicCamera, public width: number, public height: number, public bias: number) {
		this.shadowCamera = camera;
		let depthTexture = new THREE.DepthTexture(width, height);
		depthTexture.minFilter = THREE.NearestFilter;
		depthTexture.magFilter = THREE.NearestFilter;
		this.shadowTarget = new THREE.WebGLRenderTarget(width, height, {
			minFilter: THREE.LinearFilter,
			magFilter: THREE.LinearFilter,
			format: THREE.RGBAFormat,
			stencilBuffer: false
		});
		this.shadowTarget.depthTexture = depthTexture;
	}
}

export let depthMaterial = new THREE.MeshDepthMaterial({
	colorWrite: false,
	side: THREE.BackSide,
});
export function renderShadowMaps(renderer: THREE.WebGLRenderer, scene: THREE.Scene, shadowMaps: ShadowMap[]) {
	scene.overrideMaterial = depthMaterial;
	for (let map of shadowMaps) {
		if (!map.wantRenderThisFrame) continue;
		renderer.clearTarget(map.shadowTarget, true, true, false);
		renderer.render(scene, map.shadowCamera, map.shadowTarget);
	}
	scene.overrideMaterial = null as any;
}

function render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, target: THREE.WebGLRenderTarget) {
	let frustum = new THREE.Frustum().setFromMatrix(new THREE.Matrix4().multiplyMatrices( camera.projectionMatrix, camera.matrixWorldInverse ));
	let renderList: any[] = [];
	function addObject(obj: any) {
		if (obj.visible === false) return;
		if (   (obj.layers.mask & camera.layers.mask) !== 0
			&& (obj.isMesh || obj.isLine || obj.isPoints)
			&& obj.castShadow
			&& (obj.frustumCulled === false || frustum.intersectsObject(obj))
			&& obj.material.visible
		) {
			obj.modelViewMatrix.multiplyMatrices( camera.matrixWorldInverse, obj.matrixWorld );
			renderList.push(obj);
		}
		for (let child of obj.children) {
			addObject(child);
		}
	}
	renderer.setRenderTarget(target);
	for (let obj of renderList) {
		// var geometry = _objects.update( object );
		let material = obj.material;
		if (!material.isMultiMaterial) {
			depthMaterial.wireframe = material.wireframe;
			depthMaterial.side = material.side;
			depthMaterial.clipShadows = material.clipShadows;
			depthMaterial.clippingPlanes = material.clippingPlanes;
			depthMaterial.wireframeLinewidth = material.wireframeLinewidth;
			(depthMaterial as any).linewidth = material.linewidth;
			renderer.renderBufferDirect(camera, null as any, depthMaterial, geometry, null as any);
		} else {
			// TODO
		}
	}
}