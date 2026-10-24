// apps/map-editor/src/components/resource-picker/use-resource-picker.ts

import { ref, computed, watch } from "vue";
import { message } from "ant-design-vue";
import { useResourceStore } from "@src/stores";
import { addNewImage, addNewModel, convertToFpUrl } from "@src/utils/file";
import type {
	ResourcePickerOptions,
	ResourceInfo,
	ResourcePickerError,
	ResourceType,
} from "./types";

/**
 * Composable for managing resource selection logic
 * @param options Configuration options for the resource picker
 * @returns Resource picker state and methods
 */
export function useResourcePicker(options: ResourcePickerOptions) {
	const { type, initialId, resourceName, onBeforeSelect, onSelect, autoSave = true } = options;

	// State
	const resourceId = ref<string | undefined>(initialId);
	const isDirty = ref<boolean>(false);
	const isLoading = ref<boolean>(false);
	const error = ref<ResourcePickerError | null>(null);
	const tempResourceUrl = ref<string>(""); // Temporary URL for newly selected files

	// Store
	const resourceStore = useResourceStore();

	// Computed
	const resource = computed<ResourceInfo | undefined>(() => {
		if (!resourceId.value) return undefined;
		if (type === "image") {
			return resourceStore.findImageById(resourceId.value);
		} else {
			return resourceStore.findModelById(resourceId.value);
		}
	});

	const resourceUrl = computed<string>(() => {
		// Return temporary URL first (for newly selected files), then fall back to store URL
		return tempResourceUrl.value || resource.value?.url || "";
	});

	// Track initial value for dirty state
	const initialResourceId = ref<string | undefined>(initialId);

	watch(resourceId, (newId) => {
		isDirty.value = newId !== initialResourceId.value;
		// Clear temporary URL when resourceId changes from external source
		if (newId !== undefined && newId !== initialResourceId.value) {
			tempResourceUrl.value = "";
		}
	});

	// File type filters
	const getImageFilters = () => [
		{ name: "图片文件", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
	];

	const getModelFilters = () => [
		{ name: "模型文件", extensions: ["gltf", "glb"] },
	];

	/**
	 * Select a resource file
	 * @returns The selected file path (if autoSave is false) or undefined
	 */
	async function selectResource(): Promise<string | undefined> {
		try {
			// Check before select hook
			if (onBeforeSelect) {
				const canProceed = await onBeforeSelect();
				if (!canProceed) {
					error.value = {
						code: "FILE_SELECT_CANCELLED",
						message: "资源选择被取消",
					};
					return;
				}
			}

			isLoading.value = true;
			error.value = null;

			// Show file dialog
			const filters = type === "image" ? getImageFilters() : getModelFilters();
			const result = await window.electronAPI.showOpenDialog({
				title: type === "image" ? "选择图片" : "选择模型",
				properties: ["openFile"],
				filters,
			});

			if (!result.filePaths || result.filePaths.length === 0) {
				error.value = {
					code: "FILE_SELECT_CANCELLED",
					message: "未选择文件",
				};
				return;
			}

			const filePath = result.filePaths[0];
			const fileName = filePath.split(/[/\\]/).pop() || "";
			const fileExt = fileName.split(".").pop()?.toLowerCase() || "";

			// Validate file type
			const validExtensions = type === "image"
				? ["png", "jpg", "jpeg", "webp", "gif"]
				: ["gltf", "glb"];

			if (!validExtensions.includes(fileExt)) {
				error.value = {
					code: "INVALID_FILE_TYPE",
					message: `不支持的文件类型: ${fileExt}`,
					details: { supportedTypes: validExtensions },
				};
				message.error(`不支持的文件类型: ${fileExt}`);
				return;
			}

			// Process selected file
			if (autoSave) {
				// Auto-save mode: Add resource to store immediately
				// Store old resource ID for deletion after new resource is successfully added
				const oldResourceId = resourceId.value;

				let newResourceId: string;
				let newResourceUrl: string;

				if (type === "image") {
					newResourceId = await addNewImage(filePath, resourceName || fileName);
					const newImage = resourceStore.findImageById(newResourceId);
					newResourceUrl = newImage?.url || "";
				} else {
					await addNewModel(filePath, resourceName || fileName);
					// Get the newly added model's ID
					const newModel = resourceStore.models[resourceStore.models.length - 1];
					newResourceId = newModel.id;
					newResourceUrl = newModel.url;
				}

				// Remove old resource if it exists and is different from the new one
				if (oldResourceId && oldResourceId !== newResourceId) {
					if (type === "image") {
						resourceStore.removeImage(oldResourceId);
					} else {
						resourceStore.removeModel(oldResourceId);
					}
				}

				// Update resource ID and temporary URL
				resourceId.value = newResourceId;
				tempResourceUrl.value = newResourceUrl;

				message.success(type === "image" ? "图片添加成功" : "模型添加成功");
			} else {
				// Manual-save mode: Just store the file path, don't add to store yet
				const fpUrl = convertToFpUrl(filePath);

				// Clear the resource ID (not saved to store yet)
				resourceId.value = undefined;
				// Store the file URL for preview
				tempResourceUrl.value = fpUrl;

				message.success("文件已选择，请点击保存按钮完成保存");

				// Return the file path for parent component to handle
				return filePath;
			}

			// Call select callback
			if (onSelect && resource.value) {
				onSelect(resource.value);
			}

			return undefined;
		} catch (err: any) {
			error.value = {
				code: "FILE_READ_FAILED",
				message: err.message || "文件读取失败",
				details: err,
			};
			message.error(`文件读取失败: ${err.message}`);
		} finally {
			isLoading.value = false;
		}
	}

	/**
	 * Save the current resource (returns resource ID)
	 */
	async function saveResource(name?: string): Promise<string> {
		if (!resourceId.value) {
			throw new Error("没有可保存的资源");
		}

		if (name && resource.value) {
			// Update resource name if provided
			if (type === "image") {
				const image = resourceStore.findImageById(resourceId.value);
				if (image) {
					image.name = name;
				}
			} else {
				const model = resourceStore.findModelById(resourceId.value);
				if (model) {
					model.name = name;
				}
			}
		}

		return resourceId.value;
	}

	/**
	 * Clear the current resource selection
	 */
	function clearResource(): void {
		resourceId.value = undefined;
		tempResourceUrl.value = "";
		isDirty.value = true;
		error.value = null;
	}

	/**
	 * Reset resource to initial value
	 */
	function resetResource(): void {
		resourceId.value = initialResourceId.value;
		tempResourceUrl.value = "";
		isDirty.value = false;
		error.value = null;
	}

	return {
		// State
		resourceId,
		resource,
		resourceUrl,
		isDirty,
		isLoading,
		error,

		// Methods
		selectResource,
		saveResource,
		clearResource,
		resetResource,
	};
}
