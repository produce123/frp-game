import { createRouter, createWebHashHistory, createWebHistory } from "vue-router";
import { env } from "@mine-monopoly/env";
import { menus } from "./menus";

const menuRoutes = menus.map((menu) => {
	const { path, name, component } = menu;
	return { path, name, component };
});

const routes = [
	{
		path: "/",
		alias: "/main",
		redirect: "/dashboard",
		name: "main",
		component: () => import("@/views/main.vue"),
		children: menuRoutes,
	},
	{ path: "/login", name: "login", component: () => import("@/views/login/login.vue") },
];

const adminBase = env('ADMIN_BASE_PREFIX', '');

const router = createRouter({ history: import.meta.env.PROD ? createWebHistory(adminBase || undefined) : createWebHashHistory(), routes });

router.beforeEach(async (to, form) => {
	if (!["/login"].includes(to.path) && !localStorage.getItem("token")) {
		// 将用户重定向到登录页面
		return { path: "/login" };
	}
});

export default router;
