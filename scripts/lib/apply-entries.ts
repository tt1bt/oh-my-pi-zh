// 翻译条目应用引擎：对单个文件的源码文本应用 string/template/line/snippet/asset 条目。
// 匹配全部基于"内容"（字面量内容 / 整行文本 / 精确块文本），与行号无关，
// 因此 omp 升级导致行号漂移时仍能命中幸存的字符串。

import { analyzeLines } from './scanner';
import type { Entry, ApplyReport, LineEntry, SnippetEntry, StringEntry, TemplateEntry, AssetEntry } from './types';

export interface FileApplyResult {
	text: string;
	changed: boolean;
	/** entry 引用 -> 命中次数 */
	hits: Map<Entry, number>;
	/** entry 引用 -> 命中的行号列表（诊断用） */
	hitLines: Map<Entry, number[]>;
	/** 因歧义未应用的条目 */
	misses: { entry: Entry; reason: string }[];
}

type LitEntry = StringEntry | TemplateEntry;

interface FileEntrySet {
	lineMap: Map<string, LineEntry[]>;
	litMap: Map<string, LitEntry[]>;
	snippets: SnippetEntry[];
	assets: AssetEntry[];
}

/** 按文件组织条目。 */
export function groupEntries(entries: Entry[]): Map<string, FileEntrySet> {
	const byFile = new Map<string, FileEntrySet>();
	const ensure = (file: string): FileEntrySet => {
		let s = byFile.get(file);
		if (!s) {
			s = { lineMap: new Map(), litMap: new Map(), snippets: [], assets: [] };
			byFile.set(file, s);
		}
		return s;
	};
	for (const e of entries) {
		const s = ensure(e.file);
		switch (e.kind) {
			case 'line': {
				const list = s.lineMap.get(e.en) ?? [];
				list.push(e);
				s.lineMap.set(e.en, list);
				break;
			}
			case 'string':
			case 'template': {
				const list = s.litMap.get(e.en) ?? [];
				list.push(e);
				s.litMap.set(e.en, list);
				break;
			}
			case 'snippet':
				s.snippets.push(e);
				break;
			case 'asset':
				s.assets.push(e);
				break;
		}
	}
	return byFile;
}

/** 对一份文件文本应用该文件的所有条目。 */
export function applyEntriesToText(text: string, set: FileEntrySet): FileApplyResult {
	const hits = new Map<Entry, number>();
	const hitLines = new Map<Entry, number[]>();
	const misses: { entry: Entry; reason: string }[] = [];
	const bump = (e: Entry, line: number) => {
		hits.set(e, (hits.get(e) ?? 0) + 1);
		const arr = hitLines.get(e) ?? [];
		arr.push(line);
		hitLines.set(e, arr);
	};
	const miss = (e: Entry, reason: string) => misses.push({ entry: e, reason });

	// 0) 整文件资产
	if (set.assets.length) {
		const a = set.assets[0];
		bump(a, 0);
		for (const extra of set.assets.slice(1)) miss(extra, '文件已有 asset 条目，忽略多余条目');
		return { text: a.zhContent, changed: a.zhContent !== text, hits, hitLines, misses };
	}

	// 先把行拆出来（保留 \r 信息）
	const rawLines = text.split('\n');
	const hadCR = rawLines.map((l) => l.endsWith('\r'));
	const lines = rawLines.map((l, idx) => (hadCR[idx] ? l.slice(0, -1) : l));
	const replacedByLine = new Array<boolean>(lines.length).fill(false);
	let changedLines = 0;

	// 1) 整行条目（精确匹配）
	if (set.lineMap.size) {
		// occurrence 计数：同一 en 行第 k 次出现
		const seen = new Map<string, number>();
		for (let li = 0; li < lines.length; li++) {
			const line = lines[li];
			const candidates = set.lineMap.get(line);
			if (!candidates || replacedByLine[li]) continue;
			const occ = seen.get(line) ?? 0;
			seen.set(line, occ + 1);
			let chosen: LineEntry | undefined;
			if (candidates.length === 1) {
				const c = candidates[0];
				if (c.occurrence === undefined || c.occurrence === occ) chosen = c;
			} else {
				chosen = candidates.find((c) => c.occurrence === occ);
			}
			if (!chosen) {
				continue;
			}
			lines[li] = chosen.zh;
			replacedByLine[li] = true;
			bump(chosen, li);
		}
	}

	// 2) 字面量内容条目（string/template 统一按内容匹配；context/occurrence 限定）
	if (set.litMap.size) {
		const { lines: infos, skeletons } = analyzeLines(lines.join('\n'));
		// 文件级字面量出现序号：content -> 出现计数
		const occCounter = new Map<string, number>();
		// 收集替换动作，再统一应用（自右向左，避免列位移）
		type Action = { li: number; startCol: number; endCol: number; zh: string; entry: LitEntry };
		const actions: Action[] = [];

		for (let li = 0; li < infos.length; li++) {
			const info = infos[li];
			if (!info || replacedByLine[li] || info.lits.length === 0) continue;
			// 行内同内容序号（span 限定用）
			const lineContentSeen = new Map<string, number>();
			for (const lit of info.lits) {
				const spanInLine = lineContentSeen.get(lit.content) ?? 0;
				lineContentSeen.set(lit.content, spanInLine + 1);
				const candidates = set.litMap.get(lit.content);
				if (!candidates) continue;
				const occ = occCounter.get(lit.content) ?? 0;
				occCounter.set(lit.content, occ + 1);
				let chosen: LitEntry | undefined;
				let ambiguous = false;
				for (const c of candidates) {
					if (c.context !== undefined && c.context !== skeletons[li]) continue;
					if (c.occurrence !== undefined && c.occurrence !== occ) continue;
					if (c.span !== undefined && c.span !== spanInLine) continue;
					if (chosen) { ambiguous = true; break; }
					chosen = c;
				}
				if (!chosen) {
					if (ambiguous) {
						// 记录一次歧义（同一内容多个候选同时满足限定）
						miss(candidates[0], `歧义：内容 "${short(lit.content)}" 在第 ${li + 1} 行有多个候选条目同时满足限定`);
					}
					continue;
				}
				// 用译文的引号风格？保持原引号，仅换内容
				actions.push({ li, startCol: lit.startCol, endCol: lit.endCol, zh: chosen.zh, entry: chosen });
			}
		}

		// 同一行内自右向左应用
		const byLine = new Map<number, Action[]>();
		for (const a of actions) {
			const list = byLine.get(a.li) ?? [];
			list.push(a);
			byLine.set(a.li, list);
		}
		for (const [li, list] of byLine) {
			const sorted = [...list].sort((a, b) => b.startCol - a.startCol);
			let lineText = lines[li];
			for (const a of sorted) {
				// 替换 [startCol+1, endCol-1) 的内容（去掉两侧引号）
				const before = lineText.slice(0, a.startCol + 1);
				const after = lineText.slice(a.endCol - 1);
				lineText = before + a.zh + after;
				bump(a.entry, li);
			}
			lines[li] = lineText;
		}
	}

	// 3) 重组文本
	let out = lines.join('\n');
	// 恢复 \r
	if (hadCR.some(Boolean)) {
		const parts = out.split('\n');
		out = parts.map((p, idx) => (hadCR[idx] ? p + '\r' : p)).join('\n');
	}
	const changedLinesCount = hitLines.size > 0 ? new Set<number>([...hitLines.values()].flat()).size : 0;
	changedLines = changedLinesCount;

	// 4) snippet（精确块查找替换）
	for (const sn of set.snippets) {
		const want = sn.count ?? 1;
		const found = countOccurrences(out, sn.find);
		if (found !== want) {
			miss(sn, `锚点出现 ${found} 次（期望 ${want}）：${sn.name}`);
			continue;
		}
		out = out.replace(sn.find, () => sn.replace);
		bump(sn, -1);
	}

	return {
		text: out,
		changed: out !== text,
		hits,
		hitLines,
		misses,
	};
}

function short(s: string, n = 60): string {
	return s.length > n ? `${s.slice(0, n)}…` : s;
}

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let idx = haystack.indexOf(needle);
	while (idx !== -1) {
		count++;
		idx = haystack.indexOf(needle, idx + needle.length);
	}
	return count;
}

export type { ApplyReport };
