/**
 * 统一的 API 响应结构
 */
export interface ApiResponse<T = any> {
  status: number;
  msg?: string;
  data: T;
}
