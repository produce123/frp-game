import * as THREE from "three";

export async function createModelFromImage(
	url: string,
): Promise<THREE.Group> {
	const textureLoader = new THREE.TextureLoader();
	const texture = await textureLoader.loadAsync(url);
	texture.repeat.set(1, 1);
	texture.colorSpace = THREE.SRGBColorSpace;

	// 创建一个基础材质
	const planeMaterial = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide });
	const planeGeometry = new THREE.PlaneGeometry(1, 1);
	const planeMesh = new THREE.Mesh(planeGeometry, planeMaterial);
	const group = new THREE.Group();
	group.add(planeMesh);

	// 缩放到单位大小
	const box = new THREE.Box3().setFromObject(group);
	const size = new THREE.Vector3();
	box.getSize(size);
	const maxSide = Math.max(size.x, size.y, size.z);
	const scale = 1 / maxSide;
	group.scale.set(scale, scale, scale);

	// 把几何移到原点
	const center = new THREE.Vector3();
	box.getCenter(center).multiplyScalar(scale);
	group.position.sub(center);

	return group;
}