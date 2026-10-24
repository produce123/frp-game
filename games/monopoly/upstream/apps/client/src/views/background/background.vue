<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, shallowRef, watch } from "vue";

type CellData = {
	imgIndex: number;
	scale: number;
	opacity: number;
};

interface Props {
	icons: (string | object)[];
	angle?: number;
	speed?: number;
	backgroundColor?: string;
	color?: string;
	iconSize?: number;
	gap?: number;
	scaleRange?: [number, number];
	opacityRange?: [number, number];
}

const props = withDefaults(defineProps<Props>(), {
	angle: 45,
	speed: 50,
	backgroundColor: "#f5f7fa",
	color: "currentColor",
	iconSize: 40,
	gap: 32,
	scaleRange: () => [0.8, 1.2],
	opacityRange: () => [0.2, 0.5],
});

const containerRef = ref<HTMLElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const iconImages = shallowRef<HTMLImageElement[]>([]);
const cellGrid = shallowRef<CellData[][]>([]);
const rows = ref(0);
const cols = ref(0);

let animationId = 0;
let resolvedColor = "";
let resizeObserver: ResizeObserver | null = null;
let isPageVisible = true;

function resolveColorValue(colorStr: string): string {
	const el = document.createElement("div");
	el.style.color = colorStr;
	el.style.display = "none";
	document.body.appendChild(el);
	const c = getComputedStyle(el).color;
	document.body.removeChild(el);
	return c;
}

function svgToDataUri(svgHtml: string): string {
	const colored = svgHtml.replace(/currentColor/g, resolvedColor);
	return `data:image/svg+xml,${encodeURIComponent(colored)}`;
}

function loadIconImage(svgHtml: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("Failed to load icon image"));
		img.src = svgToDataUri(svgHtml);
	});
}

async function loadIcons() {
	if (!props.icons.length) return;
	resolvedColor = resolveColorValue(props.color);
	const images = await Promise.all(
		props.icons.map((icon) => {
			if (typeof icon === "string") {
				return loadIconImage(icon);
			}
			console.warn("[Background] Non-string icons are not supported in canvas mode");
			return loadIconImage("");
		}),
	);
	iconImages.value = images;
}

function getRemScale(): number {
	return parseFloat(getComputedStyle(document.documentElement).fontSize) / 16;
}

function calculateGridDimensions() {
	const w = containerRef.value?.clientWidth ?? window.innerWidth;
	const h = containerRef.value?.clientHeight ?? window.innerHeight;
	const diagonal = Math.sqrt(w * w + h * h);
	const remScale = getRemScale();
	const unitSize = (props.iconSize + props.gap) * remScale;

	const count = Math.ceil(diagonal / unitSize) + 2;
	rows.value = Math.max(count, 2);
	cols.value = Math.max(count, 2);
}

function generateGrid() {
	if (!props.icons.length || rows.value === 0) return;

	const grid: CellData[][] = [];
	for (let r = 0; r < rows.value; r++) {
		const rowData: CellData[] = [];
		for (let c = 0; c < cols.value; c++) {
			rowData.push({
				imgIndex: Math.floor(Math.random() * props.icons.length),
				scale: props.scaleRange[0] + Math.random() * (props.scaleRange[1] - props.scaleRange[0]),
				opacity: props.opacityRange[0] + Math.random() * (props.opacityRange[1] - props.opacityRange[0]),
			});
		}
		grid.push(rowData);
	}
	cellGrid.value = grid;
}

function setupCanvas() {
	const canvas = canvasRef.value;
	const container = containerRef.value;
	if (!canvas || !container) return;

	const dpr = Math.max(window.devicePixelRatio || 1, 2);
	const w = container.clientWidth;
	const h = container.clientHeight;

	if (canvas.width === w * dpr && canvas.height === h * dpr) return;

	canvas.width = w * dpr;
	canvas.height = h * dpr;

	calculateGridDimensions();
	generateGrid();
}

function draw() {
	const canvas = canvasRef.value;
	const container = containerRef.value;
	if (!canvas || !container) return;

	const ctx = canvas.getContext("2d");
	if (!ctx) return;

	const images = iconImages.value;
	const grid = cellGrid.value;
	if (!images.length || !grid.length) return;

	const dpr = Math.max(window.devicePixelRatio || 1, 2);
	const w = container.clientWidth;
	const h = container.clientHeight;
	const diagonal = Math.sqrt(w * w + h * h);
	const remScale = getRemScale();
	const unitSize = (props.iconSize + props.gap) * remScale;
	const patternWidth = cols.value * unitSize;
	const iconSize = props.iconSize * remScale;

	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, w, h);

	ctx.save();
	ctx.translate(w / 2, h / 2);
	ctx.rotate((props.angle * Math.PI) / 180);

	const elapsed = performance.now() / 1000;
	const offset = props.speed > 0 ? (elapsed * props.speed * remScale) % patternWidth : 0;

	const halfCoverage = diagonal / 2;
	const startCol = Math.floor((-halfCoverage + offset) / unitSize);
	const endCol = Math.ceil((halfCoverage + offset) / unitSize);
	const startRow = Math.floor(-halfCoverage / unitSize);
	const endRow = Math.ceil(halfCoverage / unitSize);

	for (let r = startRow; r <= endRow; r++) {
		const rowIdx = ((r % rows.value) + rows.value) % rows.value;
		const rowData = grid[rowIdx];
		if (!rowData) continue;

		for (let c = startCol; c <= endCol; c++) {
			const colIdx = ((c % cols.value) + cols.value) % cols.value;
			const cell = rowData[colIdx];
			if (!cell || cell.imgIndex >= images.length) continue;

			const x = c * unitSize - offset;
			const y = r * unitSize;
			const img = images[cell.imgIndex];
			const imgAspect = img.naturalWidth / img.naturalHeight;
			const maxSize = iconSize * cell.scale;
			let drawW: number, drawH: number;
			if (imgAspect >= 1) {
				drawW = maxSize;
				drawH = maxSize / imgAspect;
			} else {
				drawW = maxSize * imgAspect;
				drawH = maxSize;
			}
			const cx = x + iconSize / 2;
			const cy = y + iconSize / 2;

			ctx.save();
			ctx.translate(cx, cy);
			ctx.rotate((-props.angle * Math.PI) / 180);
			ctx.globalAlpha = cell.opacity;
			ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
			ctx.restore();
		}
	}

	ctx.globalAlpha = 1;
	ctx.restore();

	animationId = requestAnimationFrame(draw);
}

function startAnimation() {
	stopAnimation();
	if (isPageVisible) {
		animationId = requestAnimationFrame(draw);
	}
}

function stopAnimation() {
	if (animationId) {
		cancelAnimationFrame(animationId);
		animationId = 0;
	}
}

function handleVisibilityChange() {
	isPageVisible = !document.hidden;
	if (isPageVisible) {
		startAnimation();
	} else {
		stopAnimation();
	}
}

onMounted(async () => {
	await loadIcons();
	setupCanvas();
	startAnimation();

	if (containerRef.value) {
		resizeObserver = new ResizeObserver(() => {
			setupCanvas();
		});
		resizeObserver.observe(containerRef.value);
	}

	document.addEventListener("visibilitychange", handleVisibilityChange);
});

onBeforeUnmount(() => {
	stopAnimation();
	if (resizeObserver) resizeObserver.disconnect();
	document.removeEventListener("visibilitychange", handleVisibilityChange);
});

watch([() => props.iconSize, () => props.gap], () => {
	setupCanvas();
});

watch(() => props.icons, async () => {
	await loadIcons();
	setupCanvas();
});
</script>

<template>
	<div class="dynamic-bg-container" :style="{ backgroundColor: props.backgroundColor }" ref="containerRef">
		<canvas ref="canvasRef" class="bg-canvas" />
	</div>
</template>

<style scoped>
.dynamic-bg-container {
	position: absolute;
	top: 0;
	left: 0;
	width: 100%;
	height: 100%;
	overflow: hidden;
	z-index: 0;
	pointer-events: none;
}

.bg-canvas {
	position: absolute;
	top: 0;
	left: 0;
	width: 100%;
	height: 100%;
}
</style>
