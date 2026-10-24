/// <reference path="./pako.d.ts" />
import pako from "pako";

/**
 * 使用 gzip 压缩数据
 * @param data 要压缩的数据
 * @param onProgress 进度回调 (0-100)
 * @returns 压缩后的数据
 */
export async function gzipCompress(
  data: Uint8Array,
  onProgress?: (percent: number) => void
): Promise<Uint8Array> {
  // 使用 pako 进行 gzip 压缩，级别 9 为最高压缩率
  const compressed = pako.gzip(data, { level: 9, to: "Uint8Array" });

  // 如果有进度回调，立即报告完成（pako 不支持流式进度）
  if (onProgress) {
    onProgress(100);
  }

  return compressed as Uint8Array;
}

/**
 * 使用 gzip 解压数据
 * @param data 压缩的数据
 * @returns 解压后的数据
 * @throws 当数据不是有效的 gzip 格式时抛出错误
 */
export async function gzipDecompress(data: Uint8Array): Promise<Uint8Array> {
  try {
    const decompressed = pako.ungzip(data, { to: "Uint8Array" });
    return decompressed as Uint8Array;
  } catch (error) {
    // 重新抛出更清晰的错误信息
    throw new Error(`gzip 解压失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}
