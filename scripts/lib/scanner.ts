// TS 源码字符串字面量扫描器（零依赖，够用即可）。
// 覆盖：单双引号串、模板串（含 ${...} 嵌套表达式内的串/模板）、行/块注释、正则字面量。
// 正则识别用"前瞻 token"启发式：`/` 前是运算符/关键字/`(` 等 → 正则；前是标识符/`)` → 除法。
// 极端歧义（如 `}` 后跟 `/`）按除法处理；失步会在往返校验中暴露而非静默出错。

export interface LitSpan {
	/** 0-based 起始行 */
	line: number;
	/** 0-based 结束行（含） */
	endLine: number;
	startCol: number;
	/** 结束行上的排他列号（指向闭引号之后） */
	endCol: number;
	quote: '"' | "'" | '`';
	/** 引号内原文（转义按源码原样保留，不解码） */
	content: string;
	isTemplate: boolean;
}

interface Frame {
	type: 'sq' | 'dq' | 'tpl' | 'expr';
	/** 开引号（或 ${）索引 */
	startIdx: number;
	/** 内容起始索引（引号后 / ${ 后） */
	contentStart: number;
	braceDepth: number;
}

const REGEX_KEYWORDS = new Set([
	'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case',
	'do', 'else', 'yield', 'await', 'if', 'while', 'for', 'switch', 'catch', 'finally', 'try',
]);

/** 判断 text[i] 的 `/` 是否为正则字面量起点（基于前一个有效 token）。 */
function isRegexStart(text: string, i: number): boolean {
	let j = i - 1;
	while (j >= 0 && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n' || text[j] === '\r')) j--;
	if (j < 0) return true;
	const c = text[j];
	if ('(,=:[!&|?{};+-*%~^<>'.includes(c)) return true;
	if (c === ')' || c === ']') return false;
	if (/[A-Za-z0-9_$]/.test(c)) {
		let k = j;
		while (k >= 0 && /[A-Za-z0-9_$]/.test(text[k])) k--;
		return REGEX_KEYWORDS.has(text.slice(k + 1, j + 1));
	}
	return false; // 紧跟在字符串/模板闭合等其他符号后 → 除法
}

/** 跳过一个正则字面量；i 指向起始 `/`，返回其后的索引。无闭合时按除法返回 i+1。 */
function skipRegex(text: string, i: number): number {
	let j = i + 1;
	let inClass = false;
	while (j < text.length) {
		const c = text[j];
		if (c === '\\') { j += 2; continue; }
		if (c === '\n') return i + 1; // 正则不跨行：判定失败，回退
		if (c === '[') inClass = true;
		else if (c === ']') inClass = false;
		else if (c === '/' && !inClass) {
			j++;
			while (j < text.length && /[a-z]/i.test(text[j])) j++; // flags
			return j;
		}
		j++;
	}
	return i + 1;
}

/** 扫描整份源码文本，返回所有"顶层或嵌套"字符串字面量的位置与内容。 */
export function scanLiterals(text: string): LitSpan[] {
	const spans: LitSpan[] = [];
	const n = text.length;

	// 行首索引表 + 二分求行列
	const lineStarts: number[] = [0];
	for (let k = 0; k < n; k++) if (text[k] === '\n') lineStarts.push(k + 1);
	const posOf = (idx: number): { line: number; col: number } => {
		let lo = 0;
		let hi = lineStarts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (lineStarts[mid] <= idx) lo = mid;
			else hi = mid - 1;
		}
		return { line: lo, col: idx - lineStarts[lo] };
	};

	const closeLit = (f: Frame, endContentIdx: number, closeIdx: number) => {
		const quote: LitSpan['quote'] = f.type === 'sq' ? "'" : f.type === 'dq' ? '"' : '`';
		const p = posOf(f.startIdx);
		const e = posOf(closeIdx + 1);
		spans.push({
			line: p.line,
			endLine: e.line,
			startCol: p.col,
			endCol: e.col,
			quote,
			content: text.slice(f.contentStart, endContentIdx),
			isTemplate: f.type === 'tpl',
		});
	};

	const stack: Frame[] = [];
	let i = 0;
	while (i < n) {
		const c = text[i];
		if (c === '\n') { i++; continue; }
		const top = stack[stack.length - 1];
		if (!top) {
			if (c === '/' && text[i + 1] === '/') {
				const nl = text.indexOf('\n', i);
				i = nl === -1 ? n : nl;
			} else if (c === '/' && text[i + 1] === '*') {
				const end = text.indexOf('*/', i + 2);
				if (end === -1) i = n;
				else i = end + 2;
			} else if (c === '/' && isRegexStart(text, i)) {
				i = skipRegex(text, i);
			} else if (c === "'" || c === '"') {
				stack.push({ type: c === "'" ? 'sq' : 'dq', startIdx: i, contentStart: i + 1, braceDepth: 0 });
				i++;
			} else if (c === '`') {
				stack.push({ type: 'tpl', startIdx: i, contentStart: i + 1, braceDepth: 0 });
				i++;
			} else {
				i++;
			}
			continue;
		}
		switch (top.type) {
			case 'sq':
			case 'dq': {
				const closeCh = top.type === 'sq' ? "'" : '"';
				if (c === '\\') { i += 2; continue; }
				if (c === closeCh) {
					closeLit(top, i, i);
					stack.pop();
				}
				i++;
				continue;
			}
			case 'tpl': {
				if (c === '\\') { i += 2; continue; }
				if (c === '`') {
					closeLit(top, i, i);
					stack.pop();
					i++;
					continue;
				}
				if (c === '$' && text[i + 1] === '{') {
					stack.push({ type: 'expr', startIdx: i, contentStart: i + 2, braceDepth: 1 });
					i += 2;
					continue;
				}
				i++;
				continue;
			}
			case 'expr': {
				if (c === '/' && text[i + 1] === '/') {
					const nl = text.indexOf('\n', i);
					i = nl === -1 ? n : nl;
					continue;
				}
				if (c === '/' && text[i + 1] === '*') {
					const end = text.indexOf('*/', i + 2);
					if (end === -1) i = n;
					else i = end + 2;
					continue;
				}
				if (c === '{') { top.braceDepth++; i++; continue; }
				if (c === '}') {
					if (top.braceDepth <= 1) {
						stack.pop(); // ${…} 闭合，回到模板
					} else {
						top.braceDepth--;
					}
					i++;
					continue;
				}
				if (c === "'" || c === '"') {
					stack.push({ type: c === "'" ? 'sq' : 'dq', startIdx: i, contentStart: i + 1, braceDepth: 0 });
					i++;
					continue;
				}
				if (c === '`') {
					stack.push({ type: 'tpl', startIdx: i, contentStart: i + 1, braceDepth: 0 });
					i++;
					continue;
				}
				if (c === '/' && isRegexStart(text, i)) {
					i = skipRegex(text, i);
					continue;
				}
				i++;
				continue;
			}
		}
	}
	return spans;
}

export interface LineInfo {
	text: string;
	/** 完整落在本行内的字面量（跨行字面量不会出现在任何单行 info 里） */
	lits: { startCol: number; endCol: number; content: string; quote: LitSpan['quote']; isTemplate: boolean }[];
	/** 是否有字面量跨越本行边界 */
	hasCrossingLit: boolean;
}

/** 按行组织扫描结果；同时给出每行的骨架（字面量内容掩码为 ¤）。 */
export function analyzeLines(text: string): { lines: LineInfo[]; skeletons: string[]; hasMultilineLits: boolean } {
	const spans = scanLiterals(text);
	const rawLines = text.split('\n');
	const infos: LineInfo[] = rawLines.map((t) => ({ text: t, lits: [], hasCrossingLit: false }));
	let hasMultilineLits = false;
	for (const s of spans) {
		if (s.line !== s.endLine) {
			hasMultilineLits = true;
			for (let l = s.line; l <= s.endLine; l++) if (infos[l]) infos[l].hasCrossingLit = true;
			continue;
		}
		infos[s.line]?.lits.push({
			startCol: s.startCol,
			endCol: s.endCol,
			content: s.content,
			quote: s.quote,
			isTemplate: s.isTemplate,
		});
	}
	// 骨架：从后往前替换，避免列号位移
	const skeletons = rawLines.map((t) => t);
	for (let l = 0; l < infos.length; l++) {
		const info = infos[l];
		if (info.lits.length === 0) continue;
		let sk = info.text;
		const sorted = [...info.lits].sort((a, b) => b.startCol - a.startCol);
		for (const lit of sorted) {
			sk = sk.slice(0, lit.startCol) + lit.quote + '¤' + lit.quote + sk.slice(lit.endCol);
		}
		skeletons[l] = sk;
	}
	return { lines: infos, skeletons, hasMultilineLits };
}

/** 拆解模板串内容为静态段与槽位段：`a${x}b${y}c` → [a,${x},b,${y},c]。失配（花括号不平衡）返回 null。 */
export function splitTemplate(content: string): { type: 'static' | 'slot'; text: string }[] | null {
	const parts: { type: 'static' | 'slot'; text: string }[] = [];
	let buf = '';
	let i = 0;
	const n = content.length;
	while (i < n) {
		const c = content[i];
		if (c === '\\') {
			buf += content.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (c === '$' && content[i + 1] === '{') {
			// 找配对 }（计花括号深度；槽内含复杂嵌套串的场景放弃 → null）
			let depth = 1;
			let j = i + 2;
			while (j < n && depth > 0) {
				const d = content[j];
				if (d === '\\') { j += 2; continue; }
				if (d === '{') depth++;
				else if (d === '}') depth--;
				j++;
			}
			if (depth !== 0) return null;
			if (buf) parts.push({ type: 'static', text: buf });
			buf = '';
			parts.push({ type: 'slot', text: content.slice(i + 2, j - 1) });
			i = j;
			continue;
		}
		buf += c;
		i++;
	}
	if (buf) parts.push({ type: 'static', text: buf });
	return parts;
}
