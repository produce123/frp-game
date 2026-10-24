import path from "path";
import type { NextConfig } from "next";

// 构建时读出包版本（前端只用它显示，不参与逻辑）
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require("./package.json") as { version?: string };

/**
 * 纯静态导出，挂在平台 `/werewolf/` 下。
 *
 * 关键点：
 *   · `basePath: "/werewolf"` —— 页面里的 `/_next/...` 会自动变成 `/werewolf/_next/...`，
 *     平台把 `games/werewolf/dist` 挂在 `/werewolf/`，两边正好对上；
 *   · `output: "export"` —— 产物是 `out/`，没有 Node 运行期；
 *   · 关掉图片优化（静态导出不支持 next/image 的服务端部分）。
 */
const nextConfig: NextConfig = {
  output: "export",
  basePath: "/werewolf",
  reactCompiler: true,
  images: {
    unoptimized: true,
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version ?? "0.0.0",
    NEXT_PUBLIC_BASE_PATH: "/werewolf",
  },
  webpack(config) {
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      jotai: path.resolve(__dirname, "node_modules/jotai"),
      "jotai/vanilla": path.resolve(__dirname, "node_modules/jotai/vanilla"),
    };
    config.module.rules.push({
      test: /\.mp3$/,
      type: "asset/resource",
      generator: {
        filename: "static/media/[name].[hash][ext]",
      },
    });
    return config;
  },
};

export default nextConfig;