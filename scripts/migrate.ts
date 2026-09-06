// migrate.ts — 一次性迁移：把手工 hanhua.patch 反推为「翻译数据库」。
//
// 用法：
//   bun scripts/migrate.ts --patch hanhua.patch \
//     --pristine .tmp/work/pristine --golden .tmp/work/golden \
//     --out translations --work .tmp/migrate-work
//
// 流程：
//   1. 解析补丁 → 文件/hunk；等长 (−,+) 块逐行配对 → 分类为 string/template/line；
//      不平衡块 → 整块 snippet（find=原块，replace=译块；纯新增块以 golden 上下文行为锚）
//   2. 往返校验：对 pristine 应用翻译库，与 golden 逐文件比对
//   3. 自动收紧：歧义条目依次加 context → occurrence → 降级 line，直至零差异
//   4. 上下文泛化：零差异前提下去掉可安全移除的 context（提升跨版本命中率）
//   5. 写出 translations/*.jsonc + 迁移报告
//
// 退出码：0 = 往返零差异；1 = 仍有残差（.tmp/migrate-issues.json 供人工处理）。

import { parseUnifiedDiff } from './lib/patch-parse';
import { analyzeLines, splitTemplate } from './lib/scanner';
import { applyEntriesToText, groupEntries } from './lib/apply-entries';
import { writeTranslationFiles } from './lib/db';
import type { AssetEntry, Entry, LineEntry, SnippetEntry, StringEntry, TemplateEntry } from './lib/types';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------- CLI ----------
function arg(name: string, def = ''): string {
	const i = process.argv.indexOf(`--${name}`);
	return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const PATCH = arg('patch', 'hanhua.patch');
const PRISTINE = arg('pristine', '.tmp/work/pristine');
const GOLDEN = arg('golden', '.tmp/work/golden');
const OUT = arg('out', 'translations');
const WORK = arg('work', '.tmp/migrate-work');

const readText = (p: string) => readFileSync(p, 'utf8');

// ---------- 分类 ----------
interface Candidate {
	entry: StringEntry | TemplateEntry | LineEntry;
	/** pristine 行号（0-based） */
	provLine: number;
	provenanceEn: string;
	provenanceZh: string;
}

const classifyStats = new Map<string, number>();
function bumpStat(k: string) {
	classifyStats.set(k, (classifyStats.get(k) ?? 0) + 1);
}

function classifyPair(file: string, enLine: string, zhLine: string, provLine: number): Candidate[] {
	const asLine = (why: string): Candidate[] => {
		bumpStat(`line:${why}`);
		return [
			{ entry: { kind: 'line', file, en: enLine, zh: zhLine }, provLine, provenanceEn: enLine, provenanceZh: zhLine },
		];
	};
	const enScan = analyzeLines(enLine);
	const zhScan = analyzeLines(zhLine);
	const enLits = enScan.lines[0]?.lits ?? [];
	const zhLits = zhScan.lines[0]?.lits ?? [];
	const enSkel = enScan.skeletons[0];
	const zhSkel = zhScan.skeletons[0];

	if (enLits.length !== zhLits.length) return asLine('lit-count'); // 跨行字面量片段或引号错位
	if (enSkel !== zhSkel) return asLine('skeleton'); // 代码骨架不同（翻译纠缠了代码）
	if (enLits.length === 0) return asLine('no-lit'); // 纯代码行变化
	if (enLine === zhLine) return []; // 恒等行（重排等）

	const out: Candidate[] = [];
	// 行内同内容出现多次且译文不一 → 需要 span 限定（如 { value: "never", label: "never" }）
	const contentSeen = new Map<string, number>();
	const spanOf = new Map<number, number>(); // en lit 下标 -> 行内同内容序号
	for (let i = 0; i < enLits.length; i++) {
		const c = enLits[i].content;
		const k = contentSeen.get(c) ?? 0;
		spanOf.set(i, k);
		contentSeen.set(c, k + 1);
	}
	for (let i = 0; i < enLits.length; i++) {
		const le = enLits[i];
		const lz = zhLits[i];
		if (le.content === lz.content) continue; // 恒等字面量（对象 key 等）
		// 同内容多 span 且各 span 译文不一致时，全部挂 span（含恒等处涉及的防御）
		const sameContent = enLits.map((l, idx) => ({ l, idx })).filter((x) => x.l.content === le.content);
		const needSpan = sameContent.length > 1 && sameContent.some((x) => zhLits[x.idx].content !== lz.content);
		const span = needSpan ? spanOf.get(i) : undefined;
		if (le.isTemplate || lz.isTemplate) {
			const pe = splitTemplate(le.content);
			const pz = splitTemplate(lz.content);
			const slotsEqual =
				!!pe && !!pz && pe.length === pz.length && pe.every((p, idx) => p.type === pz[idx].type && (p.type === 'static' || p.text === pz[idx].text));
			if (!slotsEqual) return asLine('template-slot'); // 槽位表达式被改写（如 pluralize→查表）
			bumpStat('template');
			out.push({ entry: { kind: 'template', file, en: le.content, zh: lz.content, context: enSkel, span }, provLine, provenanceEn: enLine, provenanceZh: zhLine });
		} else {
			bumpStat('string');
			out.push({ entry: { kind: 'string', file, en: le.content, zh: lz.content, context: enSkel, span }, provLine, provenanceEn: enLine, provenanceZh: zhLine });
		}
	}
	return out.length ? out : asLine('identity-only');
}

// ---------- 纯新增块的锚点构造（锚与替换文本都取自 golden） ----------
function buildInsertSnippet(goldenLines: string[], insertNewNo: number, adds: string[]): { find: string; replace: string } {
	// 锚 = 插入点前一条 golden 行（可能是空行）；find 不唯一或全空白时向上扩窗（最多 12 行）
	const anchorNo = insertNewNo - 1;
	if (anchorNo < 0) return { find: adds.join('\n'), replace: adds.join('\n') }; // 文件头插入（罕见）
	const goldenText = goldenLines.join('\n');
	const build = (start: number) => {
		const win: string[] = [];
		for (let i = start; i <= anchorNo; i++) win.push(goldenLines[i]);
		return win.join('\n');
	};
	let start = anchorNo;
	let find = build(start);
	while ((find.trim() === '' || countSub(goldenText, find) > 1) && start > 0 && anchorNo - start < 12) {
		start--;
		find = build(start);
	}
	return { find, replace: `${find}\n${adds.join('\n')}` };
}

function countSub(haystack: string, needle: string): number {
	if (!needle) return 0;
	let n = 0;
	let idx = haystack.indexOf(needle);
	while (idx !== -1) {
		n++;
		idx = haystack.indexOf(needle, idx + needle.length);
	}
	return n;
}

// ---------- 行级 diff（LCS，先去公共前后缀） ----------
type Op = { type: 'eq' | 'del' | 'ins'; aNo?: number; bNo?: number; aText?: string; bText?: string };
function diffLines(a: string[], b: string[]): Op[] {
	const ops: Op[] = [];
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	for (let i = 0; i < start; i++) ops.push({ type: 'eq', aNo: i, bNo: i, aText: a[i], bText: b[i] });
	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);
	if (midA.length * midB.length > 4_000_000) {
		for (let i = 0; i < midA.length; i++) ops.push({ type: 'del', aNo: start + i, aText: midA[i] });
		for (let j = 0; j < midB.length; j++) ops.push({ type: 'ins', bNo: start + j, bText: midB[j] });
	} else {
		const m = midA.length;
		const n = midB.length;
		const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
		for (let i = m - 1; i >= 0; i--) {
			for (let j = n - 1; j >= 0; j--) {
				dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}
		let i = 0;
		let j = 0;
		while (i < m && j < n) {
			if (midA[i] === midB[j]) {
				ops.push({ type: 'eq', aNo: start + i, bNo: start + j, aText: midA[i], bText: midB[j] });
				i++;
				j++;
			} else if (dp[i + 1][j] >= dp[i][j + 1]) {
				ops.push({ type: 'del', aNo: start + i, aText: midA[i] });
				i++;
			} else {
				ops.push({ type: 'ins', bNo: start + j, bText: midB[j] });
				j++;
			}
		}
		while (i < m) {
			ops.push({ type: 'del', aNo: start + i, aText: midA[i] });
			i++;
		}
		while (j < n) {
			ops.push({ type: 'ins', bNo: start + j, bText: midB[j] });
			j++;
		}
	}
	for (let i = endA; i < a.length; i++) ops.push({ type: 'eq', aNo: i, bNo: endB + (i - endA), aText: a[i], bText: b[endB + (i - endA)] });
	return ops;
}

// ---------- 收紧 ----------
function tighten(offender: Entry, is: DiffIssue, provByKey: Map<string, Candidate>): Entry | null {
	const file = is.file;
	if (offender.kind === 'snippet' || offender.kind === 'asset') return null;

	if (offender.kind === 'line') {
		const le = offender as LineEntry;
		// 同形行冲突：定位差异行对应的 pristine 行号（用 actual=误翻前的原文行），设 occurrence
		let provNo = pristineLines(file).indexOf(is.actual);
		if (provNo < 0) provNo = pristineLines(file).indexOf(is.expected);
		if (provNo >= 0) {
			const occ = lineOrdinal(file, le.en, provNo);
			if (occ >= 0) return { ...le, occurrence: occ };
		}
		return null;
	}

	// string / template
	const oe = offender as StringEntry;
	const prov = provByKey.get(`${file}|${oe.en}|${is.expected}`) ?? findAnyProv(provByKey, file, oe.en);
	if (!prov) return null;
	const provPristineLine = pristineLineAt(file, prov.provLine);
	const lineChanged = is.expected !== provPristineLine;
	if (!lineChanged) {
		// 该行本不该被翻译 → 条目打错了位置
		if (oe.context === undefined) {
			return { ...oe, context: lineSkeletonAt(file, prov.provLine) } as StringEntry;
		}
		if (oe.span === undefined) {
			// 行内歧义：按 provenance 行的行内序号限定
			const sp = lineSpanOrdinal(file, oe.en, prov.provLine);
			if (sp !== null && sp > 0) return { ...oe, span: sp } as StringEntry;
		}
		if (oe.occurrence === undefined) {
			const occ = spanOrdinal(file, oe.en, prov.provLine);
			if (occ >= 0) return { ...oe, occurrence: occ } as StringEntry;
		}
	}
	// 该行应被翻译但内容不对（分类出错）→ 降级 line
	return {
		kind: 'line',
		file,
		en: prov.provenanceEn,
		zh: prov.provenanceZh,
		occurrence: lineOrdinal(file, prov.provenanceEn, prov.provLine),
	} as LineEntry;
}

function findAnyProv(provByKey: Map<string, Candidate>, file: string, en: string): Candidate | null {
	for (const [, c] of provByKey) {
		const e = c.entry as StringEntry;
		if (e.file === file && e.en === en) return c;
	}
	return null;
}

// ---------- pristine / golden 行缓存 ----------
const pristineCache = new Map<string, string[]>();
const goldenCache = new Map<string, string[]>();
function pristineLines(file: string): string[] {
	let v = pristineCache.get(file);
	if (!v) {
		v = readText(join(PRISTINE, file)).split('\n');
		pristineCache.set(file, v);
	}
	return v;
}
function goldenLinesOf(file: string): string[] {
	let v = goldenCache.get(file);
	if (!v) {
		v = readText(join(GOLDEN, file)).split('\n');
		goldenCache.set(file, v);
	}
	return v;
}
const pristineLineAt = (file: string, no: number) => pristineLines(file)[no] ?? '';
function lineSkeletonAt(file: string, lineNo: number): string {
	return analyzeLines(pristineLines(file).join('\n')).skeletons[lineNo] ?? '';
}
/** en 内容在文件中的出现序号：provLine 行上的那次出现是第几次（0-based） */
function spanOrdinal(file: string, content: string, provLine: number): number {
	const { lines } = analyzeLines(pristineLines(file).join('\n'));
	let occ = 0;
	for (let li = 0; li < lines.length; li++) {
		for (const lit of lines[li].lits) {
			if (lit.content === content) {
				if (li === provLine) return occ;
				occ++;
			}
		}
	}
	return -1;
}

/** provLine 行上该内容的行内序号；该行内容唯一时返回 null（无需 span） */
function lineSpanOrdinal(file: string, content: string, provLine: number): number | null {
	const { lines } = analyzeLines(pristineLines(file).join('\n'));
	const info = lines[provLine];
	if (!info) return null;
	let k = 0;
	let found: number | null = null;
	for (const lit of info.lits) {
		if (lit.content === content) {
			if (found === null) found = k;
			k++;
		}
	}
	return found !== null && k > 1 ? found : null;
}
/** 整行 en 在文件中的出现序号：provLine 行是第几次（0-based） */
function lineOrdinal(file: string, lineText: string, provLine: number): number {
	const lines = pristineLines(file);
	let occ = 0;
	for (let li = 0; li < lines.length; li++) {
		if (lines[li] === lineText) {
			if (li === provLine) return occ;
			occ++;
		}
	}
	return -1;
}
function countLitOccurrences(root: string, file: string, content: string): number {
	const text = readText(join(root, file));
	const { lines } = analyzeLines(text);
	let n = 0;
	for (const info of lines) for (const lit of info.lits) if (lit.content === content) n++;
	return n;
}
function short(s: string, n = 80): string {
	return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ---------- 往返校验 ----------
interface DiffIssue {
	kind: 'diff' | 'miss';
	file: string;
	/** output 中的 0-based 行号（miss 为 -1） */
	line: number;
	expected: string;
	actual: string;
	detail?: string;
}
interface RoundtripResult {
	issues: DiffIssue[];
	/** "file:line" -> 命中该行的条目 */
	offenderByLine: Map<string, Entry>;
}

function runRoundtrip(entries: Entry[]): RoundtripResult {
	rmSync(WORK, { recursive: true, force: true });
	mkdirSync(WORK, { recursive: true });
	const grouped = groupEntries(entries);
	const patchFiles = new Set<string>();
	for (const e of entries) patchFiles.add(e.file);
	const offenderByLine = new Map<string, Entry>();
	const issues: DiffIssue[] = [];

	for (const file of patchFiles) {
		const set = grouped.get(file)!;
		const srcPath = join(PRISTINE, file);
		const goldenPath = join(GOLDEN, file);
		if (!existsSync(srcPath) || !existsSync(goldenPath)) {
			issues.push({ kind: 'miss', file, line: -1, expected: '<file>', actual: '缺失', detail: 'pristine/golden 缺文件' });
			continue;
		}
		const res = applyEntriesToText(readText(srcPath), set);
		for (const [entry, lines] of res.hitLines) {
			for (const ln of lines) offenderByLine.set(`${file}:${ln}`, entry);
		}
		for (const m of res.misses) {
			const name = (m.entry as SnippetEntry).name ?? (m.entry as StringEntry).kind;
			issues.push({ kind: 'miss', file, line: -1, expected: '', actual: '', detail: `${name}: ${m.reason}` });
		}
		const outText = res.text;
		mkdirSync(join(WORK, file, '..'), { recursive: true });
		writeFileSync(join(WORK, file), outText, 'utf8');
		const goldenText = readText(goldenPath);
		if (outText === goldenText) continue;
		for (const op of diffLines(outText.split('\n'), goldenText.split('\n'))) {
			if (op.type === 'eq') continue;
			issues.push({
				kind: 'diff',
				file,
				line: op.type === 'del' ? op.aNo ?? -1 : op.bNo ?? -1,
				expected: op.bText ?? '',
				actual: op.aText ?? '',
			});
		}
	}
	return { issues, offenderByLine };
}

// ---------- 主流程 ----------
function main() {
	console.log(`[1/6] 解析补丁 ${PATCH}`);
	const diffFiles = parseUnifiedDiff(readText(PATCH));
	console.log(`      ${diffFiles.length} 个文件`);

	console.log('[2/6] 配对与分类');
	const allCandidates: Candidate[] = [];
	const allSnippets: SnippetEntry[] = [];
	const fileAssets = new Map<string, string>();
	let pairCount = 0;
	let blockCount = 0;
	for (const df of diffFiles) {
		if (!existsSync(join(PRISTINE, df.pathEn))) {
			console.error(`  ! pristine 缺文件: ${df.pathEn}`);
			continue;
		}
		const golden = goldenLinesOf(df.pathEn);
		// 文件尾换行状态被补丁改变（如 tips.txt 去掉/补上末尾换行）→ 整文件 asset，行条目无法表达
		const pristineText = readText(join(PRISTINE, df.pathEn));
		const goldenText = readText(join(GOLDEN, df.pathEn));
		if (pristineText.endsWith('\n') !== goldenText.endsWith('\n')) {
			console.log(`      · ${df.pathEn}: 尾换行变化 → asset 条目`);
			fileAssets.set(df.pathEn, goldenText);
			continue;
		}
		for (const hunk of df.hunks) {
			let oldNo = hunk.oldStart - 1;
			let newNo = hunk.newStart - 1;
			type Run = { dels: { text: string; oldNo: number }[]; adds: { text: string; newNo: number }[] };
			let run: Run = { dels: [], adds: [] };
			const flushRun = () => {
				if (!run.dels.length && !run.adds.length) return;
				if (run.dels.length > 0 && run.dels.length === run.adds.length) {
					for (let i = 0; i < run.dels.length; i++) {
						pairCount++;
						allCandidates.push(...classifyPair(df.pathEn, run.dels[i].text, run.adds[i].text, run.dels[i].oldNo));
					}
				} else if (run.dels.length > 0) {
					blockCount++;
					const delText = run.dels.map((d) => d.text).join('\n');
					const addText = run.adds.map((a) => a.text).join('\n');
					allSnippets.push({
						kind: 'snippet',
						file: df.pathEn,
						name: `block@-${hunk.oldStart}+${hunk.newStart}#${blockCount}`,
						// 纯删除块：连带行尾换行一起删，避免留下空行
						find: addText === '' ? delText + '\n' : delText,
						replace: addText,
						note: `hunk @@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount}`,
					});
				} else {
					blockCount++;
					const { find, replace } = buildInsertSnippet(golden, run.adds[0].newNo, run.adds.map((a) => a.text));
					allSnippets.push({
						kind: 'snippet',
						file: df.pathEn,
						name: `insert@-${hunk.oldStart}+${hunk.newStart}#${blockCount}`,
						find,
						replace,
						note: `hunk @@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount}`,
					});
				}
				run = { dels: [], adds: [] };
			};
			for (const l of hunk.lines) {
				if (l.type === ' ') {
					flushRun();
					oldNo++;
					newNo++;
				} else if (l.type === '-') {
					run.dels.push({ text: l.text, oldNo });
					oldNo++;
				} else {
					run.adds.push({ text: l.text, newNo });
					newNo++;
				}
			}
			flushRun();
		}
	}
	console.log(`      行对 ${pairCount}，块级 snippet ${blockCount}`);
	console.log('      分类分布:', [...classifyStats].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  '));

	console.log('[3/6] 去重与冲突消解');
	const byKey = new Map<string, Candidate>();
	for (const c of allCandidates) {
		const e = c.entry as StringEntry;
		const key = `${e.file}|${e.kind}|${e.en}|${e.context ?? ''}|${e.span ?? ''}|${e.zh}`;
		if (!byKey.has(key)) byKey.set(key, c);
	}
	const zhSets = new Map<string, Set<string>>();
	for (const c of byKey.values()) {
		const e = c.entry as StringEntry;
		const ck = `${e.file}|${e.kind}|${e.en}|${e.context ?? ''}|${e.span ?? ''}`;
		let set = zhSets.get(ck);
		if (!set) {
			set = new Set();
			zhSets.set(ck, set);
		}
		set.add(e.zh);
	}
	let entries: Entry[] = [];
	let downgradeCount = 0;
	for (const c of byKey.values()) {
		const e = c.entry as StringEntry;
		const ck = `${e.file}|${e.kind}|${e.en}|${e.context ?? ''}|${e.span ?? ''}`;
		if ((zhSets.get(ck)?.size ?? 0) > 1) {
			downgradeCount++;
			entries.push({ kind: 'line', file: e.file, en: c.provenanceEn, zh: c.provenanceZh } as LineEntry);
		} else {
			entries.push(c.entry);
		}
	}
	entries.push(...allSnippets);
	for (const [file, content] of fileAssets) {
		entries.push({ kind: 'asset', file, zhContent: content } as AssetEntry);
	}
	const seenLine = new Set<string>();
	entries = entries.filter((e) => {
		if (e.kind !== 'line') return true;
		const k = `${e.file}|${e.en}|${e.zh}`;
		if (seenLine.has(k)) return false;
		seenLine.add(k);
		return true;
	});
	console.log(`      条目 ${entries.length}（冲突降级 ${downgradeCount}）`);

	// provenance 索引
	const provByKey = new Map<string, Candidate>();
	for (const c of allCandidates) {
		const e = c.entry as StringEntry;
		provByKey.set(`${e.file}|${e.en}|${c.provenanceEn}`, c);
	}

	console.log('[4/6] 往返校验（自动收紧）');
	const noTighten = process.env.MIGRATE_NO_TIGHTEN === '1';
	let round = 0;
	let issues: DiffIssue[] = [];
	while (round < (noTighten ? 1 : 30)) {
		const rt = runRoundtrip(entries);
		issues = rt.issues;
		if (noTighten) {
			mkdirSync('.tmp', { recursive: true });
			writeFileSync('.tmp/migrate-issues.json', JSON.stringify(issues, null, 2), 'utf8');
			console.log(`      [no-tighten] 第 0 轮 ${issues.length} 处差异 → .tmp/migrate-issues.json，条目未改动`);
			break;
		}
		if (issues.length === 0) {
			console.log(`      第 ${round} 轮：零差异 ✓`);
			break;
		}
		console.log(`      第 ${round} 轮：${issues.length} 处差异`);
		const replacements = new Map<Entry, Entry>();
		for (const is of issues) {
			if (is.kind === 'miss') {
				console.error(`  ! [miss] ${is.file}: ${is.detail}`);
				continue;
			}
			const offender = rt.offenderByLine.get(`${is.file}:${is.line}`);
			if (!offender) {
				console.error(`  ! 无法归因 ${is.file}:${is.line + 1}\n      期望: ${JSON.stringify(short(is.expected, 90))}\n      实际: ${JSON.stringify(short(is.actual, 90))}`);
				continue;
			}
			if (replacements.has(offender)) continue;
			const tight = tighten(offender, is, provByKey);
			if (tight) replacements.set(offender, tight);
			else console.error(`  ! 收紧失败 ${is.file}:${is.line + 1} (${offender.kind} "${short((offender as StringEntry).en ?? '', 40)}")`);
		}
		if (replacements.size === 0) {
			console.error(`      无法继续收紧，仍有 ${issues.length} 处差异`);
			break;
		}
		entries = entries.map((e) => replacements.get(e) ?? e);
		round++;
	}
	const clean = issues.length === 0;

	console.log('[5/6] 上下文泛化');
	if (clean) {
		const droppable: Entry[] = [];
		for (const e of entries) {
			if (e.kind !== 'string' && e.kind !== 'template') continue;
			const se = e as StringEntry;
			if (se.context === undefined) continue;
			const pc = countLitOccurrences(PRISTINE, se.file, se.en);
			const gc = countLitOccurrences(GOLDEN, se.file, se.zh);
			if (pc > 0 && pc === gc) droppable.push(e);
		}
		if (droppable.length) {
			const kept = entries.filter((e) => !droppable.includes(e));
			const dropped = droppable.map((e) => {
				const se = JSON.parse(JSON.stringify(e)) as StringEntry;
				delete se.context;
				delete se.occurrence;
				return se as Entry;
			});
			const rt = runRoundtrip([...kept, ...dropped]);
			if (rt.issues.length === 0) {
				entries = [...kept, ...dropped];
				console.log(`      去掉 ${dropped.length} 个 context ✓`);
			} else {
				console.log(`      泛化引发 ${rt.issues.length} 处差异，保守整批回退`);
				entries = [...kept, ...droppable];
				runRoundtrip(entries);
			}
		} else {
			console.log('      无可泛化条目');
		}
	} else {
		console.log('      跳过（往返未清零）');
	}

	console.log('[6/6] 写出与报告');
	const finalRt = runRoundtrip(entries);
	if (finalRt.issues.length > 0) {
		mkdirSync('.tmp', { recursive: true });
		writeFileSync('.tmp/migrate-issues.json', JSON.stringify(finalRt.issues, null, 2), 'utf8');
		console.error(`✗ 最终往返仍有 ${finalRt.issues.length} 处差异 → .tmp/migrate-issues.json`);
	}
	const written = writeTranslationFiles(OUT, entries);
	console.log(`\n✓ 写出 ${written.length} 个区域文件 → ${OUT}/`);
	const kindCount = new Map<string, number>();
	for (const e of entries) kindCount.set(e.kind, (kindCount.get(e.kind) ?? 0) + 1);
	for (const [k, v] of [...kindCount].sort()) console.log(`  ${k}: ${v}`);
	process.exit(finalRt.issues.length === 0 ? 0 : 1);
}

main();
