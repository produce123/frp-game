import * as THREE from "three";

/**
 * 创建屏幕空间的框选框
 * 用于在正交相机模式下进行框选
 */
export class BoxSelector {
  private scene: THREE.Scene;
  private boxElement: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement, scene: THREE.Scene) {
    this.canvas = canvas;
    this.scene = scene;
    this.createBoxElement();
  }

  private createBoxElement() {
    this.boxElement = document.createElement("div");
    this.boxElement.style.position = "absolute";
    this.boxElement.style.border = "2px solid #ffffff";
    this.boxElement.style.backgroundColor = "rgba(255, 255, 255, 0.3)";
    this.boxElement.style.pointerEvents = "none";
    this.boxElement.style.display = "none";
    this.boxElement.style.zIndex = "1000";

    // 添加到 canvas 的父容器
    const canvasContainer = this.canvas.parentElement;
    if (canvasContainer) {
      canvasContainer.style.position = "relative";
      canvasContainer.appendChild(this.boxElement);
    }
  }

  /**
   * 显示框选框
   */
  show(startX: number, startY: number, currentX: number, currentY: number) {
    if (!this.boxElement) return;

    const rect = this.calculateRect(startX, startY, currentX, currentY);

    this.boxElement.style.left = `${rect.x}px`;
    this.boxElement.style.top = `${rect.y}px`;
    this.boxElement.style.width = `${rect.width}px`;
    this.boxElement.style.height = `${rect.height}px`;
    this.boxElement.style.display = "block";
  }

  /**
   * 隐藏框选框
   */
  hide() {
    if (!this.boxElement) return;
    this.boxElement.style.display = "none";
  }

  /**
   * 计算矩形框的位置和尺寸
   */
  private calculateRect(
    startX: number,
    startY: number,
    currentX: number,
    currentY: number
  ): { x: number; y: number; width: number; height: number } {
    const x = Math.min(startX, currentX);
    const y = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);

    return { x, y, width, height };
  }

  /**
   * 销毁框选框
   */
  destroy() {
    if (this.boxElement && this.boxElement.parentElement) {
      this.boxElement.parentElement.removeChild(this.boxElement);
      this.boxElement = null;
    }
  }
}

/**
 * 将 3D 位置投影到屏幕坐标
 */
export function projectToScreen(
  position: { x: number; y: number; z: number },
  camera: THREE.Camera,
  canvasSize: { width: number; height: number }
): { x: number; y: number } {
  const vector = new THREE.Vector3(position.x, position.y, position.z);
  vector.project(camera);

  return {
    x: (vector.x + 1) / 2 * canvasSize.width,
    y: -(vector.y - 1) / 2 * canvasSize.height,
  };
}

/**
 * 判断点是否在矩形框内
 */
export function isPointInRect(
  point: { x: number; y: number },
  rect: { minX: number; maxX: number; minY: number; maxY: number }
): boolean {
  return (
    point.x >= rect.minX &&
    point.x <= rect.maxX &&
    point.y >= rect.minY &&
    point.y <= rect.maxY
  );
}
