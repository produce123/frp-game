import jsep from "jsep";
import type { Expression } from "jsep";

const astCache = new Map<string, Expression>();

const HELPER_FUNCTIONS: Record<string, Function> = {
	// 基础工具
	len: (val: any) => (Array.isArray(val) || typeof val === "string" ? val.length : 0),
	str: (val: any) => String(val ?? ""),
	int: (val: any) => parseInt(val, 10) || 0,
	float: (val: any) => parseFloat(val) || 0,
	bool: (val: any) => !!val,

	// 集合操作
	contains: (collection: any, item: any) => {
		if (Array.isArray(collection) || typeof collection === "string") {
			return collection.includes(item);
		}
		return false;
	},

	// 数学计算
	max: Math.max,
	min: Math.min,
	abs: Math.abs,
	round: Math.round,
	floor: Math.floor,
	ceil: Math.ceil,
	random: Math.random, // 注意：在 UI 中使用随机数可能会导致闪烁
};

/**
 * 递归计算 AST 节点的值
 * @param node 当前 AST 节点
 * @param context 数据上下文
 */
function evaluateAST(node: Expression, context: any): any {
	if (!node) return undefined;

	switch (node.type) {
		// 1. 二元运算 (+, -, *, &&, ==)
		case "BinaryExpression": {
			const binaryNode = node as jsep.BinaryExpression;
			const left = evaluateAST(binaryNode.left, context);
			const right = evaluateAST(binaryNode.right, context);

			switch (binaryNode.operator) {
				case "+":
					return left + right; // JS 原生行为：支持数值相加和字符串拼接
				case "-":
					return left - right;
				case "*":
					return left * right;
				case "/":
					return left / right;
				case "%":
					return left % right;
				case ">":
					return left > right;
				case "<":
					return left < right;
				case ">=":
					return left >= right;
				case "<=":
					return left <= right;
				case "==":
					return left == right; // 宽松相等
				case "===":
					return left === right;
				case "!=":
					return left != right;
				case "!==":
					return left !== right;
				case "&&":
					return left && right;
				case "||":
					return left || right;
				default:
					return undefined;
			}
		}

		// 2. 成员访问 (obj.name, arr[index])
		case "MemberExpression": {
			const memberNode = node as jsep.MemberExpression;
			const object = evaluateAST(memberNode.object, context);

			// 安全检查：防止对 undefined/null 取属性
			if (object == null) return undefined;

			let property;
			if (memberNode.computed) {
				// 形式: arr[i] -> 计算 i 的值
				property = evaluateAST(memberNode.property, context);
			} else {
				// 形式: obj.name -> name 为标识符
				property = (memberNode.property as jsep.Identifier).name;
			}

			return object[property];
		}

		// 3. 变量/标识符 (userName, level)
		case "Identifier": {
			const name = (node as jsep.Identifier).name;
			// 优先从 context 查找
			if (context && Object.prototype.hasOwnProperty.call(context, name)) {
				return context[name];
			}
			// 其次支持原型链上的属性 (例如 context 是一个类实例)
			if (context && name in context) {
				return context[name];
			}
			// 最后从 helper 查找 (为了方便，有些写法可能是变量名)
			return undefined;
		}

		// 4. 字面量 (123, "abc", true)
		case "Literal": {
			return (node as jsep.Literal).value;
		}

		// 5. 一元运算 (!isShow, -1)
		case "UnaryExpression": {
			const unaryNode = node as jsep.UnaryExpression;
			const arg = evaluateAST(unaryNode.argument, context);
			if (unaryNode.operator === "!") return !arg;
			if (unaryNode.operator === "-") return -arg;
			if (unaryNode.operator === "+") return +arg;
			return arg;
		}

		// 6. 三元运算符 (score > 60 ? 'Pass' : 'Fail')
		case "ConditionalExpression": {
			const condNode = node as jsep.ConditionalExpression;
			const test = evaluateAST(condNode.test, context);
			return test ? evaluateAST(condNode.consequent, context) : evaluateAST(condNode.alternate, context);
		}

		// 7. 函数调用 (len(arr), max(1, 2))
		case "CallExpression": {
			const callNode = node as jsep.CallExpression;

			// 限制：只能调用 Identifier 类型的函数 (即白名单内的函数)
			// 不支持 obj.func() 这种形式，以防止安全逃逸 (如 user.save())
			if (callNode.callee.type !== "Identifier") return undefined;

			const funcName = (callNode.callee as jsep.Identifier).name;
			const func = HELPER_FUNCTIONS[funcName];

			if (typeof func === "function") {
				const args = callNode.arguments.map((arg) => evaluateAST(arg, context));
				return func(...args);
			}
			console.warn(`[Expr] Unknown function: ${funcName}`);
			return undefined;
		}

		default:
			// console.warn(`[Expr] Unsupported node type: ${node.type}`);
			return undefined;
	}
}

/**
 * 表达式求值入口 (完全安全，无 eval)
 * @param context 数据上下文对象
 * @param expression 表达式字符串 (例如: "'LV ' + user.level")
 */
export function evalExpression(context: any, expression: string): any {
	if (!expression) return undefined;
	// 纯数字或布尔值优化
	if (typeof expression !== "string") return expression;

	const exprStr = expression.trim();
	if (!exprStr) return undefined;

	// CSS 值快速检测：匹配常见的纯 CSS 值模式，避免将纯 CSS 值当作表达式解析
	// 例如: 0.85rem, 100px, 50%, 1.5s, auto, #fff, rgb(0,0,0)
	// 检测1: CSS 关键字
	if (/^(auto|inherit|none|transparent)$/.test(exprStr)) return exprStr;
	// 检测2: 颜色值 (#fff, #ffffff)
	if (/^#[0-9a-fA-F]{3,8}$/.test(exprStr)) return exprStr;
	// 检测3: rgb/rgba/hsl/hsla 颜色
	if (/^rgba?\([^)]+\)$/.test(exprStr)) return exprStr;
	if (/^hsla?\([^)]+\)$/.test(exprStr)) return exprStr;
	// 检测4: 带单位的数值 (0.85rem, 100px, 50%, 1.5s, etc.)
	if (/^-?\d*\.?\d+(px|em|rem|vw|vh|%|cm|mm|in|pt|pc|ch|ex|vmin|vmax|s|ms|deg|rad|grad|turn|fr)?$/.test(exprStr)) return exprStr;

	// 1. 尝试从缓存获取 AST
	let ast = astCache.get(exprStr);

	if (!ast) {
		try {
			// 2. 解析 AST
			ast = jsep(exprStr);
			astCache.set(exprStr, ast);
		} catch (e) {
			console.warn(`[Expr Error] Parse failed: "${exprStr}"`, e);
			return undefined;
		}
	}

	try {
		// 3. 执行解释器
		return evaluateAST(ast, context);
	} catch (e) {
		console.warn(`[Expr Error] Exec failed: "${exprStr}"`, e);
		return undefined;
	}
}

/**
 * 解析 v-for 语法
 * 支持: "item in list" 或 "(item, index) in list"
 */
export function parseVFor(expression: string) {
	const match = expression.match(/^\s*(?:\((\w+)(?:,\s*(\w+))?\)|\s*(\w+))\s+in\s+(.+)\s*$/);

	if (!match) {
		console.warn(`[VFor Error] Invalid syntax: "${expression}"`);
		return { itemKey: "item", indexKey: "index", listExpr: "" };
	}

	// 正则捕获组说明:
	// match[1]: (item, index) 中的 item
	// match[2]: (item, index) 中的 index
	// match[3]: item in list 中的 item
	// match[4]: list 表达式

	const itemKey = match[1] || match[3];
	const indexKey = match[2] || "index"; // 默认索引名为 index
	const listExpr = match[4];

	return { itemKey, indexKey, listExpr };
}
