// 统一 diff（git apply 格式）解析器：把 hanhua.patch 拆成文件 → hunk → 行序列。

export interface DiffLine {
	type: ' ' | '-' | '+';
	text: string;
	/** 是否紧跟 \ No newline at end of file 标记 */
	noNewline?: boolean;
}

export interface Hunk {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	/** 段标题（@@ ... @@ 之后的部分，可为空） */
	section: string;
	lines: DiffLine[];
}

export interface DiffFile {
	/** a/ 侧路径（去掉 pi-coding-agent/ 前缀后，即包内相对路径） */
	pathEn: string;
	/** b/ 侧路径（去掉 pi-coding-agent-zh/ 前缀后） */
	pathZh: string;
	hunks: Hunk[];
}

/** 解析统一 diff。假定头形如 diff --git a/pi-coding-agent/X b/pi-coding-agent-zh/X。 */
export function parseUnifiedDiff(text: string): DiffFile[] {
	const files: DiffFile[] = [];
	// 剥离每行行尾的 \r（Windows 检出会把 LF 补丁转成 CRLF；diff 内容行不该带 \r）
	const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
	let cur: DiffFile | null = null;
	let curHunk: Hunk | null = null;

	const strip = (p: string, pkg: string) => {
		const prefix = `${pkg}/`;
		if (!p.startsWith(prefix)) throw new Error(`意外的路径前缀: ${p}`);
		return p.slice(prefix.length);
	};

	for (let idx = 0; idx < lines.length; idx++) {
		const raw = lines[idx];
		if (raw.startsWith('diff --git ')) {
			const m = raw.match(/^diff --git a\/(.+?) b\/(.+?)$/);
			if (!m) throw new Error(`无法解析 diff --git 行: ${raw}`);
			cur = {
				pathEn: strip(m[1], 'pi-coding-agent'),
				pathZh: strip(m[2], 'pi-coding-agent-zh'),
				hunks: [],
			};
			files.push(cur);
			curHunk = null;
			continue;
		}
		if (!cur) continue;
		if (raw.startsWith('@@')) {
			const m = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
			if (!m) throw new Error(`无法解析 hunk 头: ${raw}`);
			curHunk = {
				oldStart: Number(m[1]),
				oldCount: m[2] === undefined ? 1 : Number(m[2]),
				newStart: Number(m[3]),
				newCount: m[4] === undefined ? 1 : Number(m[4]),
				section: m[5] ?? '',
				lines: [],
			};
			cur.hunks.push(curHunk);
			continue;
		}
		if (!curHunk) continue; // index/---/+++ 等文件头行
		if (raw.startsWith('\\ No newline at end of file') || raw.startsWith('\\ 不在文件末尾')) {
			const prev = curHunk.lines[curHunk.lines.length - 1];
			if (prev) prev.noNewline = true;
			continue;
		}
		const t = raw[0] as DiffLine['type'];
		if (t === ' ' || t === '-' || t === '+') {
			curHunk.lines.push({ type: t, text: raw.slice(1) });
		} else if (raw === '') {
			// 空行在 hunk 内等价于 " "（上下文空行），但仅当 hunk 未满时
			const remaining = (curHunk.oldCount - count(curHunk.lines, ' ')) + 0;
			void remaining;
			if (hunkIncomplete(curHunk)) curHunk.lines.push({ type: ' ', text: '' });
		}
	}
	return files;
}

function count(lines: DiffLine[], type: DiffLine['type']): number {
	return lines.filter((l) => l.type === type || (type === ' ' && l.type === ' ')).length;
}

function hunkIncomplete(h: Hunk): boolean {
	const oldSeen = h.lines.filter((l) => l.type === ' ' || l.type === '-').length;
	const newSeen = h.lines.filter((l) => l.type === ' ' || l.type === '+').length;
	return oldSeen < h.oldCount || newSeen < h.newCount;
}
