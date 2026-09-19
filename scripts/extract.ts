// extract.ts — 维护侧：对照新版 omp 生成「翻译缺口报告」（diff 驱动，高精度）。
//
// 用法：
//   bun scripts/extract.ts --version 18.2.6              # 从 npm 拉取目标版本（基线取 meta.jsonc）
//   bun scripts/extract.ts --version A --base B          # 显式指定基线版本
//   bun scripts/extract.ts --source <pkgDir> [--base-source <pkgDir>]
//   bun scripts/extract.ts --source-tui <tuiDir> [--base-source-tui <tuiDir>]
//
// 双包：omm 18.2.5 起 UI 层抽成独立包 @oh-my-pi/pi-tui，条目按 pkg 分流
// （translations/tui/ 与显式 pkg:"tui" 的条目走 pi-tui，其余走主包）。
// 未显式指定 tui 目录时按同版本自动拉取；旧版无该包则退化为单包。
//
// 报告三类缺口：
//   A. 失效条目 —— 翻译库条目在目标版本中找不到原文（omp 改文案/删功能）
//   B. 漂移串   —— 基线版本中"被翻译过"的行，在目标版本中发生了变化（需要跟进翻译）
//   C. 新增行   —— 目标版本新增的、命中显示字段启发式（label/description/title/...）的行
//
// 设计：以「基线→目标」的行级 diff 限定扫描范围，避免把第三方文本/模型侧提示词/
// 注入脚本等噪声卷进来。报告写入 .tmp/extract-report-<version>.json。
// 退出码：0 无缺口；2 有缺口（供 CI 判定）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { analyzeLines } from './lib/scanner';
import { applyEntriesToText, groupEntries, splitKey } from './lib/apply-entries';
import { loadTranslationDir, parseJsonc } from './lib/db';
import { diffLines } from './lib/linediff';
import type { SnippetEntry, StringEntry } from './lib/types';

// ---------- CLI ----------
function arg(name: string, def = ''): string {
	const i = process.argv.indexOf(`--${name}`);
	return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const VERSION = arg('version');
const SOURCE = arg('source');
const SOURCE_TUI = arg('source-tui');
const BASE = arg('base');
const BASE_SOURCE = arg('base-source');
const BASE_SOURCE_TUI = arg('base-source-tui');
const WORK = arg('work', '.tmp/extract');

// ---------- 翻译库 ----------
const { entries } = loadTranslationDir('translations');
let baseVersion = BASE;
if (!baseVersion) {
	const metaPath = 'translations/meta.jsonc';
	baseVersion = existsSync(metaPath) ? (parseJsonc<{ baseVersion?: string }>(readFileSync(metaPath, 'utf8')).baseVersion ?? '') : '';
}
if (!baseVersion && !BASE_SOURCE) {
	console.error('[extract] 未指定基线（--base 或 translations/meta.jsonc 的 baseVersion）');
	process.exit(1);
}

// ---------- 获取源码 ----------
/** 从 npm 拉取并解包指定包。 */
function fetchPkgNamed(pkgName: string, version: string, dirName: string): string {
	mkdirSync(WORK, { recursive: true });
	const dir = join(WORK, dirName);
	if (existsSync(dir)) return dir;
	const { execSync } = require('node:child_process') as typeof import('node:child_process');
	console.log(`[extract] 拉取 ${pkgName}@${version} ...`);
	execSync(`npm pack ${pkgName}@${version} --pack-destination "${WORK}"`, { stdio: 'pipe' });
	mkdirSync(dir, { recursive: true });
	const tgz = `${pkgName.replace('@', '').replace('/', '-')}-${version}.tgz`;
	execSync(`tar -xzf "${join(WORK, tgz)}" -C "${dir}" --strip-components=1`);
	return dir;
}
function fetchPkg(version: string, dest: string): string {
	return fetchPkgNamed('@oh-my-pi/pi-coding-agent', version, dest);
}
/** pi-tui 包（18.2.5 起 UI 层抽包）；拉取失败（旧版无此包）时返回空串。 */
function fetchTuiPkg(version: string): string {
	try {
		return fetchPkgNamed('@oh-my-pi/pi-tui', version, `pkg-pi-tui-${version}`);
	} catch {
		return '';
	}
}

const targetDir = SOURCE ? SOURCE : fetchPkg(VERSION, WORK);
const baseDir = BASE_SOURCE ? BASE_SOURCE : fetchPkg(baseVersion, WORK);
const targetVersion = (JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8')) as { version: string }).version;
// 双包：pi-tui 目录（显式指定优先，否则按同版本拉取）
const targetTuiDir = SOURCE_TUI ? resolve(SOURCE_TUI) : fetchTuiPkg(targetVersion);
const baseTuiDir = BASE_SOURCE_TUI ? resolve(BASE_SOURCE_TUI) : fetchTuiPkg(baseVersion);
const hasTui = !!targetTuiDir && existsSync(join(targetTuiDir, 'package.json'));
console.log(`[extract] 基线 v${baseVersion} → 目标 v${targetVersion}${hasTui ? '（双包，含 pi-tui）' : ''}`);

/** 按包取根目录：pkg=tui 走 pi-tui，其余走主包。 */
function rootOf(pkg: string, which: 'target' | 'base'): string {
	if (pkg === 'tui') return which === 'target' ? targetTuiDir : baseTuiDir;
	return which === 'target' ? targetDir : baseDir;
}

// ---------- 范围与排除 ----------
const excludedPath = 'translations/excluded.jsonc';
const excludedFiles = new Set<string>(['src/tools/output-meta.ts', 'src/tools/yield.ts']);
const excludedPrefixes = new Set<string>();
const keepEnglish = new Set<string>();
if (existsSync(excludedPath)) {
	try {
		const ex = parseJsonc<{ files?: string[]; prefixes?: string[]; keepEnglish?: string[] }>(readFileSync(excludedPath, 'utf8'));
		for (const f of ex.files ?? []) excludedFiles.add(f);
		for (const p of ex.prefixes ?? []) excludedPrefixes.add(p);
		for (const s of ex.keepEnglish ?? []) keepEnglish.add(s);
	} catch (e) {
		console.warn('[extract] excluded.jsonc 解析失败，忽略:', e);
	}
}
const EXTRACT_ROOTS = ['src/cli/', 'src/commands/', 'src/modes/', 'src/tui/', 'src/config/', 'src/tools/', 'src/prompts/system/'];
const FIELD_RE = /\b(label|description|title|text|group|hint|summary|placeholder|note|message|detail|header|footer|caption|prefix|suffix|subtitle)s?\s*:\s*$/;
const TEXT_EXT = /\.(txt|md)$/;

function inScope(file: string): boolean {
	if (excludedFiles.has(file)) return false;
	for (const p of excludedPrefixes) if (file.startsWith(p)) return false;
	return EXTRACT_ROOTS.some((r) => file.startsWith(r));
}

// ---------- 基线中"被翻译过"的行集合 ----------
// 键为 `pkg:file`，避免两个包的同名文件互相污染。
const key = (pkg: string, file: string) => `${pkg}:${file}`;
const translatedBaseLines = new Map<string, Set<string>>();
for (const e of entries) {
	if (e.kind !== 'line') continue;
	const k = key((e as { pkg?: string }).pkg ?? 'agent', e.file);
	const set = translatedBaseLines.get(k) ?? new Set<string>();
	set.add((e as { en: string }).en);
	translatedBaseLines.set(k, set);
}
// string/template 条目：回溯其所在行（用 context 骨架在基线中定位）
for (const e of entries) {
	if (e.kind !== 'string' && e.kind !== 'template') continue;
	const se = e as StringEntry;
	const pkg = (se as { pkg?: string }).pkg ?? 'agent';
	const basePath = join(rootOf(pkg, 'base'), se.file);
	if (!basePath || !existsSync(basePath)) continue;
	const { lines, skeletons } = analyzeLines(readFileSync(basePath, 'utf8'));
	if (se.context) {
		const idx = skeletons.indexOf(se.context);
		const k = key(pkg, se.file);
		if (idx !== -1) (translatedBaseLines.get(k) ?? translatedBaseLines.set(k, new Set()).get(k)!).add(lines[idx].text);
	}
}
// string 条目内容集合（pkg:file -> en 内容），用于"该内容是否有覆盖"判断
const dbContents = new Map<string, Set<string>>();
for (const e of entries) {
	if (e.kind !== 'string' && e.kind !== 'template') continue;
	const k = key((e as { pkg?: string }).pkg ?? 'agent', e.file);
	const set = dbContents.get(k) ?? new Set<string>();
	set.add((e as { en: string }).en);
	dbContents.set(k, set);
}

// ---------- A. 失效条目 ----------
const grouped = groupEntries(entries);
const stale: { pkg: string; file: string; kind: string; en: string; zh: string }[] = [];
for (const [groupKey, set] of grouped) {
	const { pkg, file } = splitKey(groupKey);
	const root = rootOf(pkg, 'target');
	// pi-tui 包不存在（旧版 omp）时跳过该包条目，不算失效
	if (!root || !existsSync(root)) continue;
	const targetPath = join(root, file);
	if (!existsSync(targetPath)) {
		for (const [k, list] of set.litMap) for (const e of list) stale.push({ pkg, file, kind: e.kind, en: k, zh: e.zh });
		for (const [k, list] of set.lineMap) for (const e of list) stale.push({ pkg, file, kind: 'line', en: k, zh: e.zh });
		continue;
	}
	const res = applyEntriesToText(readFileSync(targetPath, 'utf8'), set);
	const hitSet = new Set([...res.hits.keys()]);
	for (const [k, list] of set.litMap) for (const e of list) if (!hitSet.has(e)) stale.push({ pkg, file, kind: e.kind, en: k, zh: e.zh });
	for (const [k, list] of set.lineMap) for (const e of list) if (!hitSet.has(e)) stale.push({ pkg, file, kind: 'line', en: k, zh: e.zh });
	for (const sn of set.snippets) if (!hitSet.has(sn)) stale.push({ pkg, file, kind: 'snippet', en: (sn as SnippetEntry).name, zh: (sn as SnippetEntry).name });
}

// ---------- B+C. diff 驱动扫描 ----------
const drifted: { pkg: string; file: string; line: number; oldEn: string; newEn: string }[] = [];
const fresh: { pkg: string; file: string; line: number; en: string; field: string }[] = [];

/** 目标版本 scope 内的文件（按包收集）。 */
function listFiles(root: string, prefix = ''): string[] {
	const out: string[] = [];
	const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
	for (const name of readdirSync(join(root, prefix))) {
		const rel = prefix ? `${prefix}/${name}` : name;
		const st = statSync(join(root, rel));
		if (st.isDirectory()) out.push(...listFiles(root, rel));
		else if (/\.(ts|txt|md)$/.test(name)) out.push(rel);
	}
	return out;
}

// 待扫描的 (pkg, file) 集合：翻译库涉及的 + 目标版本 scope 内的
const scanSet = new Set<string>();
for (const e of entries) scanSet.add(key((e as { pkg?: string }).pkg ?? 'agent', e.file));
if (targetDir && existsSync(targetDir)) for (const f of listFiles(targetDir)) if (inScope(f)) scanSet.add(key('agent', f));
if (hasTui) for (const f of listFiles(targetTuiDir)) if (inScope(f)) scanSet.add(key('tui', f));

for (const groupKey of [...scanSet].sort()) {
	const { pkg, file } = splitKey(groupKey);
	if (!inScope(file)) continue;
	const root = rootOf(pkg, 'target');
	const baseRoot = rootOf(pkg, 'base');
	if (!root || !existsSync(root)) continue;
	const basePath = baseRoot ? join(baseRoot, file) : '';
	const targetPath = join(root, file);
	if (!basePath || !existsSync(basePath)) {
		// 新文件：仅字段启发式（同样要排除翻译库已覆盖的内容，否则已译条目会被误报为新增未译）
		if (!existsSync(targetPath)) continue;
		const { lines } = analyzeLines(readFileSync(targetPath, 'utf8'));
		const newFileDbCont = dbContents.get(groupKey);
		for (let li = 0; li < lines.length; li++) {
			for (const lit of lines[li].lits) {
				const m = lines[li].text.slice(0, lit.startCol).match(FIELD_RE);
				if (m && !newFileDbCont?.has(lit.content) && !keepEnglish.has(lit.content))
					fresh.push({ pkg, file, line: li + 1, en: lit.content, field: m[1] });
			}
		}
		continue;
	}
	if (!existsSync(targetPath)) continue;
	const baseText = readFileSync(basePath, 'utf8');
	const targetText = readFileSync(targetPath, 'utf8');
	if (baseText === targetText) continue;
	const baseLines = baseText.split('\n');
	const targetLines = targetText.split('\n');
	const { lines: targetInfo } = analyzeLines(targetText);
	const translated = translatedBaseLines.get(groupKey);
	const dbCont = dbContents.get(groupKey);
	const isTextAsset = TEXT_EXT.test(file) && (translated?.size ?? 0) > 0; // 有覆盖历史的文本资产才扫

	for (const op of diffLines(baseLines, targetLines)) {
		if (op.type === 'eq') continue;
		const newNo = op.bNo ?? -1;
		const newLine = op.bText ?? '';
		if (op.type === 'ins') {
			// C. 新增行：字段启发式
			const info = targetInfo[newNo];
			if (!info) continue;
			for (const lit of info.lits) {
				const m = info.text.slice(0, lit.startCol).match(FIELD_RE);
				if (m && !dbCont?.has(lit.content) && !keepEnglish.has(lit.content)) fresh.push({ pkg, file, line: newNo + 1, en: lit.content, field: m[1] });
			}
			continue;
		}
		// del / del+ins：基线行曾被翻译过 → 漂移
		const oldLine = op.aText ?? '';
		if (translated?.has(oldLine)) {
			drifted.push({ pkg, file, line: newNo + 1, oldEn: oldLine, newEn: newLine });
			continue;
		}
		if (isTextAsset && newLine.trim()) {
			// 文本资产中变化的行
			drifted.push({ pkg, file, line: newNo + 1, oldEn: oldLine, newEn: newLine });
		}
	}
}

// ---------- 报告 ----------
const label = (pkg: string, file: string) => (pkg === 'tui' ? `tui:${file}` : file);
const byFile = (list: { pkg: string; file: string }[]) => {
	const m = new Map<string, number>();
	for (const x of list) {
		const k = label(x.pkg, x.file);
		m.set(k, (m.get(k) ?? 0) + 1);
	}
	return [...m].sort((a, b) => b[1] - a[1]);
};

console.log(`\n===== omp v${baseVersion} → v${targetVersion} 翻译缺口报告${hasTui ? '（双包）' : ''} =====`);
console.log(`A. 失效条目: ${stale.length} 条`);
for (const [f, n] of byFile(stale).slice(0, 12)) console.log(`    ${String(n).padStart(4)}  ${f}`);
console.log(`B. 漂移串（曾被翻译、原文已变）: ${drifted.length} 处`);
for (const [f, n] of byFile(drifted).slice(0, 12)) console.log(`    ${String(n).padStart(4)}  ${f}`);
console.log(`C. 新增未译（字段启发式）: ${fresh.length} 处`);
for (const [f, n] of byFile(fresh).slice(0, 12)) console.log(`    ${String(n).padStart(4)}  ${f}`);

mkdirSync('.tmp', { recursive: true });
const report = {
	baseVersion,
	targetVersion,
	hasTui,
	generatedAt: new Date().toISOString(),
	staleCount: stale.length,
	driftCount: drifted.length,
	freshCount: fresh.length,
	stale,
	drifted,
	fresh,
};
const reportPath = `.tmp/extract-report-${targetVersion}.json`;
writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
console.log(`\n[extract] 报告已写入 ${reportPath}`);
process.exit(stale.length + drifted.length + fresh.length > 0 ? 2 : 0);
