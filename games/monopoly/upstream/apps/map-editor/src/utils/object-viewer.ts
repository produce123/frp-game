/**
 * 渲染一个可折叠、带样式的对象树
 * @param container - 渲染目标的 DOM 元素
 * @param obj - 要展示的对象
 */
export function renderObjectTree(container: HTMLElement, obj: unknown): void {
  injectStyles(); // 自动注入 CSS

  container.innerHTML = "";
  container.appendChild(renderNode(obj));
}

/* --------------------------- 样式注入 ---------------------------- */

let styleInjected = false;

function injectStyles() {
  if (styleInjected) return;
  styleInjected = true;

  const style = document.createElement("style");
  style.textContent = `
.object-viewer-summary {
  cursor: pointer;
  user-select: none;
  font-weight: 600;
  color: #444;
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 2px 0;
}

.object-viewer-summary:hover {
  color: #000;
}

.object-viewer-arrow {
  display: inline-block;
  transition: transform 0.15s ease;
  font-size: 10px;
}

details[open] > .object-viewer-summary .object-viewer-arrow {
  transform: rotate(90deg);
}

.object-viewer-primitive {
  margin-left: 16px;
  color: #555;
}

.object-viewer-key {
  color: #2844e2;
  font-weight: 500;
}

.object-viewer-type-info {
  font-size: 12px;
  color: #999;
}
`;
  document.head.appendChild(style);
}

/* --------------------------- 节点渲染 ---------------------------- */

function renderNode(value: unknown): HTMLElement | Text {
  // 基础类型
  if (value === null || typeof value !== "object") {
    const el = document.createElement("div");
    el.className = "object-viewer-primitive";
    el.textContent = JSON.stringify(value);
    return el;
  }

  // Object / Array
  const wrapper = document.createElement("div");
  wrapper.style.marginLeft = "12px";

  const entries = Object.entries(value as Record<string, any>);

  for (const [key, val] of entries) {
    const isObj = val !== null && typeof val === "object";

    if (isObj) {
      const details = document.createElement("details");

      const summary = document.createElement("summary");
      summary.className = "object-viewer-summary";

      const arrow = document.createElement("span");
      arrow.className = "object-viewer-arrow";
      arrow.textContent = ">";

      const typeName = Array.isArray(val) ? "Array" : "Object";
      const lengthInfo =
        Array.isArray(val)
          ? `${typeName} (${val.length})`
          : `${typeName} (${Object.keys(val).length})`;

      const label = document.createElement("span");
      label.innerHTML = `
        <span class="object-viewer-key">${key}</span>
        <span class="object-viewer-type-info"> ${lengthInfo}</span>
      `;

      summary.appendChild(arrow);
      summary.appendChild(label);

      details.appendChild(summary);
      details.appendChild(renderNode(val));

      wrapper.appendChild(details);
    } else {
      // 基础类型字段
      const div = document.createElement("div");
      div.className = "object-viewer-primitive";

      div.innerHTML = `
        <span class="object-viewer-key">${key}</span>:
        ${JSON.stringify(val)}
        <span class="object-viewer-type-info"> (${typeof val})</span>
      `;

      wrapper.appendChild(div);
    }
  }

  return wrapper;
}
