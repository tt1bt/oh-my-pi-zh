// 翻译数据库条目类型定义。
// 所有 file 字段均为相对 pi-coding-agent 包根的 POSIX 路径（如 src/cli/args.ts）。

/** 字符串字面量替换：匹配引号内内容完全一致的普通字面量（'…' 或 "…"）。 */
export interface StringEntry {
	kind: 'string';
	file: string;
	/** 原文（字面量内部原文，保留转义形式） */
	en: string;
	/** 译文（同上，逐字替换引号内内容） */
	zh: string;
	/**
	 * 行骨架限定：仅当所在行的骨架（所有字面量内容被掩码为 ¤ 后的行文本）
	 * 与此字段完全一致时才应用。用于同文件同原文不同译文的消解，
	 * 以及保护"比较值保留、显示值翻译"的双轨字符串。
	 */
	context?: string;
	/** 文件内该内容的第几次出现（0-based）。context 无法消解同形行时使用。 */
	occurrence?: number;
	/**
	 * 行内序号：同一行内该内容出现多次、且各处译文不同时，
	 * 指明本条目作用于行内第几个同内容 span（0-based）。
	 * 典型场景：{ value: "never", label: "never" } 中 value 保留、label 翻译。
	 */
	span?: number;
	note?: string;
}

/** 模板字面量替换：`${...}` 槽位表达式必须与译文一致，仅静态文本不同。 */
export interface TemplateEntry {
	kind: 'template';
	file: string;
	/** 原模板内容（含 ${...}，不含反引号） */
	en: string;
	/** 译模板内容（槽位表达式须与 en 一致） */
	zh: string;
	context?: string;
	occurrence?: number;
	/** 行内同内容 span 序号（见 StringEntry.span） */
	span?: number;
	note?: string;
}

/** 整行替换：en 为完整行原文（含缩进），任何字面量/代码纠缠改动都走这里。 */
export interface LineEntry {
	kind: 'line';
	file: string;
	en: string;
	zh: string;
	/** 同 en 行多次出现、需指向特定某次时使用（0-based） */
	occurrence?: number;
	note?: string;
}

/** 结构性代码补丁：按 find 精确文本定位后整块替换。 */
export interface SnippetEntry {
	kind: 'snippet';
	file: string;
	/** 便于人读的名字 */
	name: string;
	find: string;
	replace: string;
	/** 期望出现次数，默认 1 */
	count?: number;
	note?: string;
}

/** 整文件替换（如纯文本资产）。 */
export interface AssetEntry {
	kind: 'asset';
	file: string;
	zhContent: string;
	note?: string;
}

export type Entry = StringEntry | TemplateEntry | LineEntry | SnippetEntry | AssetEntry;

/** translations/*.jsonc 的文件结构 */
export interface TranslationFile {
	entries: Entry[];
}

/** 应用过程的统计报告 */
export interface ApplyReport {
	/** 每个文件的命中条目数 */
	hitsByFile: Map<string, number>;
	/** 未命中的条目（含原因） */
	misses: { entry: Entry; reason: string }[];
	/** 发生变更的文件列表 */
	changedFiles: Set<string>;
	/** 每个文件的变更行数 */
	changedLines: Map<string, number>;
}
