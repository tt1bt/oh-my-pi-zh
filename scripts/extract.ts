// extract.ts — 维护侧：对照新版 omp 生成「翻译缺口报告」（diff 驱动，高精度）。
//
// 用法：
//   bun scripts/extract.ts --version 18.1.12           # 从 npm 拉取目标版本（基线取 meta.jsonc）
//   bun scripts/extract.ts --version A --base B        # 显式指定基线版本
//   bun scripts/extract.ts --source <pkgDir> [--base-source <pkgDir>]
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
import { join } from 'node:path';
import { analyzeLines } from './lib/scanner';
import { applyEntriesToText, groupEntries } from './lib/apply-entries';
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
const BASE = arg('base');
const BASE_SOURCE = arg('base-source');
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
function fetchPkg(version: string, dest: string): string {
	mkdirSync(WORK, { recursive: true });
	const dir = join(WORK, `pkg-${version}`);
	if (existsSync(dir)) return dir;
	const { execSync } = require('node:child_process') as typeof import('node:child_process');
	console.log(`[extract] 拉取 @oh-my-pi/pi-coding-agent@${version} ...`);
	execSync(`npm pack @oh-my-pi/pi-coding-agent@${version} --pack-destination "${WORK}"`, { stdio: 'pipe' });
	mkdirSync(dir, { recursive: true });
	execSync(`tar -xzf "${join(WORK, `oh-my-pi-pi-coding-agent-${version}.tgz`)}" -C "${dir}" --strip-components=1`);
	return dir;
}
const targetDir = SOURCE ? SOURCE : fetchPkg(VERSION, WORK);
const baseDir = BASE_SOURCE ? BASE_SOURCE : fetchPkg(baseVersion, WORK);
const targetVersion = (JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8')) as { version: string }).version;
console.log(`[extract] 基线 v${baseVersion} → 目标 v${targetVersion}`);

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
// file -> Set(基线行文本)。这些行若在目标版本中发生变化，即需要跟进翻译。
const translatedBaseLines = new Map<string, Set<string>>();
for (const e of entries) {
	if (e.kind !== 'line') continue;
	const set = translatedBaseLines.get(e.file) ?? new Set<string>();
	set.add((e as { en: string }).en);
	translatedBaseLines.set(e.file, set);
}
// string/template 条目：回溯其所在行（用 context 骨架在基线中定位）
for (const e of entries) {
	if (e.kind !== 'string' && e.kind !== 'template') continue;
	const se = e as StringEntry;
	const basePath = join(baseDir, se.file);
	if (!existsSync(basePath)) continue;
	const { lines, skeletons } = analyzeLines(readFileSync(basePath, 'utf8'));
	if (se.context) {
		const idx = skeletons.indexOf(se.context);
		if (idx !== -1) (translatedBaseLines.get(se.file) ?? translatedBaseLines.set(se.file, new Set()).get(se.file)!).add(lines[idx].text);
	}
}
// string 条目内容集合（file -> en 内容），用于"该内容是否有覆盖"判断
const dbContents = new Map<string, Set<string>>();
for (const e of entries) {
	if (e.kind !== 'string' && e.kind !== 'template') continue;
	const set = dbContents.get(e.file) ?? new Set<string>();
	set.add((e as { en: string }).en);
	dbContents.set(e.file, set);
}

// ---------- A. 失效条目 ----------
const grouped = groupEntries(entries);
const stale: { file: string; kind: string; en: string; zh: string }[] = [];
for (const [file, set] of grouped) {
	if (!existsSync(join(targetDir, file))) {
		for (const [key, list] of set.litMap) for (const e of list) stale.push({ file, kind: e.kind, en: key, zh: e.zh });
		for (const [key, list] of set.lineMap) for (const e of list) stale.push({ file, kind: 'line', en: key, zh: e.zh });
		continue;
	}
	const res = applyEntriesToText(readFileSync(join(targetDir, file), 'utf8'), set);
	const hitSet = new Set([...res.hits.keys()]);
	for (const [key, list] of set.litMap) for (const e of list) if (!hitSet.has(e)) stale.push({ file, kind: e.kind, en: key, zh: e.zh });
	for (const [key, list] of set.lineMap) for (const e of list) if (!hitSet.has(e)) stale.push({ file, kind: 'line', en: key, zh: e.zh });
	for (const sn of set.snippets) if (!hitSet.has(sn)) stale.push({ file, kind: 'snippet', en: (sn as SnippetEntry).name, zh: (sn as SnippetEntry).name });
}

// ---------- B+C. diff 驱动扫描 ----------
const drifted: { file: string; line: number; oldEn: string; newEn: string }[] = [];
const fresh: { file: string; line: number; en: string; field: string }[] = [];

const allFiles = new Set<string>();
for (const e of entries) allFiles.add(e.file);
// 目标版本的 scope 内文件也要扫（新文件）
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
for (const f of listFiles(targetDir)) if (inScope(f)) allFiles.add(f);

for (const file of [...allFiles].sort()) {
	if (!inScope(file)) continue;
	const basePath = join(baseDir, file);
	const targetPath = join(targetDir, file);
	if (!existsSync(basePath)) {
		// 新文件：仅字段启发式（同样要排除翻译库已覆盖的内容，否则已译条目会被误报为新增未译）
		const { lines } = analyzeLines(readFileSync(targetPath, 'utf8'));
		const newFileDbCont = dbContents.get(file);
		for (let li = 0; li < lines.length; li++) {
			for (const lit of lines[li].lits) {
				const m = lines[li].text.slice(0, lit.startCol).match(FIELD_RE);
				if (m && !newFileDbCont?.has(lit.content) && !keepEnglish.has(lit.content))
					fresh.push({ file, line: li + 1, en: lit.content, field: m[1] });
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
	const translated = translatedBaseLines.get(file);
	const dbCont = dbContents.get(file);
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
				if (m && !dbCont?.has(lit.content) && !keepEnglish.has(lit.content)) fresh.push({ file, line: newNo + 1, en: lit.content, field: m[1] });
			}
			continue;
		}
		// del / del+ins：基线行曾被翻译过 → 漂移
		const oldLine = op.aText ?? '';
		if (translated?.has(oldLine)) {
			drifted.push({ file, line: newNo + 1, oldEn: oldLine, newEn: newLine });
			continue;
		}
		if (isTextAsset && newLine.trim()) {
			// 文本资产中变化的行
			drifted.push({ file, line: newNo + 1, oldEn: oldLine, newEn: newLine });
		}
	}
}

// ---------- 报告 ----------
const byFile = (list: { file: string }[]) => {
	const m = new Map<string, number>();
	for (const x of list) m.set(x.file, (m.get(x.file) ?? 0) + 1);
	return [...m].sort((a, b) => b[1] - a[1]);
};

console.log(`\n===== omp v${baseVersion} → v${targetVersion} 翻译缺口报告 =====`);
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
