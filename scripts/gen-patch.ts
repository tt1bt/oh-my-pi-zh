// gen-patch.ts — 由翻译库再生统一 diff 补丁（审计/兼容产物）。
//
// 用法：
//   bun scripts/gen-patch.ts --version 18.2.5               # 指定 omp 版本（npm 拉取，同时处理 pi-tui）
//   bun scripts/gen-patch.ts --source <agentDir> --source-tui <tuiDir>
//   bun scripts/gen-patch.ts --out hanhua.patch             # 输出路径（默认 hanhua.patch）
//
// 自 omp 18.2.5 起上游把 UI 层抽成独立包 @oh-my-pi/pi-tui，因此：
//   主包条目 -> hanhua.patch（-p2，a/pi-coding-agent/ → b/pi-coding-agent-zh/）
//   tui 条目 -> hanhua-tui.patch（-p2，a/pi-tui/ → b/pi-tui-zh/）
// 两者都可用 git apply -p2 应用，也可作为 diff 审计工具。

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applyEntriesToText, groupEntries, splitKey } from './lib/apply-entries';
import { loadTranslationDir } from './lib/db';

function arg(name: string, def = ''): string {
	const i = process.argv.indexOf(`--${name}`);
	return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const VERSION = arg('version');
const SOURCE = arg('source');
const SOURCE_TUI = arg('source-tui');
const OUT = arg('out', 'hanhua.patch');
const WORK = arg('work', '.tmp/genpatch');

if (!VERSION && !SOURCE) {
	console.error('用法: bun scripts/gen-patch.ts --version <omp版本> 或 --source <已解包目录>');
	process.exit(1);
}

/** 从 npm 拉取并解包指定包。 */
function fetchPkg(pkgName: string, version: string, dirName: string): string {
	mkdirSync(WORK, { recursive: true });
	const dir = join(WORK, dirName);
	if (existsSync(dir)) return dir;
	const { execSync } = require('node:child_process') as typeof import('node:child_process');
	execSync(`npm pack ${pkgName}@${version} --pack-destination "${WORK}"`, { stdio: 'inherit' });
	mkdirSync(dir, { recursive: true });
	const tgzName = `${pkgName.replace('@', '').replace('/', '-')}-${version}.tgz`;
	execSync(`tar -xzf "${join(WORK, tgzName)}" -C "${dir}" --strip-components=1`);
	return dir;
}

// 获取源码（主包 + 可选 tui 包）
const srcDir = SOURCE
	? resolve(SOURCE)
	: fetchPkg('@oh-my-pi/pi-coding-agent', VERSION, `pkg-${VERSION}`);

const ompVersion = (JSON.parse(readFileSync(join(srcDir, 'package.json'), 'utf8')) as { version: string }).version;
console.log(`[gen-patch] omp v${ompVersion} @ ${srcDir}`);

// pi-tui：显式指定优先，否则尝试同版本拉取（旧版 omp 无此包则跳过）
let srcTuiDir = SOURCE_TUI ? resolve(SOURCE_TUI) : '';
if (!srcTuiDir) {
	try {
		srcTuiDir = fetchPkg('@oh-my-pi/pi-tui', ompVersion, `pkg-pi-tui-${ompVersion}`);
	} catch {
		srcTuiDir = '';
	}
}
const hasTui = !!srcTuiDir && existsSync(join(srcTuiDir, 'package.json'));
if (hasTui) console.log(`[gen-patch] pi-tui @ ${srcTuiDir}`);

const { entries } = loadTranslationDir('translations');
const grouped = groupEntries(entries);

/** 对某个包生成补丁。 */
function makePatch(opts: {
	label: string;
	src: string;
	treeNames: [string, string];
	out: string;
	onlyPkg: 'agent' | 'tui';
}): number {
	const parent = join(WORK, `tree-${opts.label}-${ompVersion}`);
	rmSync(parent, { recursive: true, force: true });
	mkdirSync(parent, { recursive: true });
	const treeA = join(parent, opts.treeNames[0]);
	const treeB = join(parent, opts.treeNames[1]);
	cpSync(opts.src, treeA, { recursive: true });
	cpSync(opts.src, treeB, { recursive: true });

	let changed = 0;
	for (const [key, set] of grouped) {
		const { pkg, file } = splitKey(key);
		if (pkg !== opts.onlyPkg) continue;
		const dstFile = join(treeB, file);
		if (!existsSync(dstFile)) continue;
		const res = applyEntriesToText(readFileSync(dstFile, 'utf8'), set);
		if (res.changed) {
			writeFileSync(dstFile, res.text, 'utf8');
			changed++;
		}
	}
	console.log(`[gen-patch] ${opts.label}：应用翻译改动 ${changed} 个文件`);

	const { execSync } = require('node:child_process') as typeof import('node:child_process');
	let diff = '';
	try {
		diff = execSync(
			`git -c core.autocrlf=false diff --no-index --src-prefix=a/ --dst-prefix=b/ "${opts.treeNames[0]}" "${opts.treeNames[1]}"`,
			{ cwd: parent, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
		);
	} catch (e) {
		diff = (e as { stdout?: string }).stdout ?? '';
		if (!diff) {
			console.error(`[gen-patch] ${opts.label} git diff 失败:`, (e as Error).message);
			return -1;
		}
	}
	if (!diff) {
		console.warn(`[gen-patch] ${opts.label} 无差异`);
		return 0;
	}
	writeFileSync(opts.out, diff, 'utf8');
	const lines = diff.split('\n').length;
	console.log(`[gen-patch] ✓ ${opts.out} (${lines} 行)。应用: git apply -p2 ${opts.out}`);
	return changed;
}

const agentChanged = makePatch({
	label: 'agent',
	src: srcDir,
	treeNames: ['pi-coding-agent', 'pi-coding-agent-zh'],
	out: OUT,
	onlyPkg: 'agent',
});

if (hasTui) {
	const tuiOut = OUT.replace(/\.patch$/, '') + '-tui.patch';
	makePatch({
		label: 'tui',
		src: srcTuiDir,
		treeNames: ['pi-tui', 'pi-tui-zh'],
		out: tuiOut,
		onlyPkg: 'tui',
	});
} else {
	console.log('[gen-patch] 未检测到 pi-tui 包，跳过 tui 补丁');
}

process.exit(agentChanged < 0 ? 1 : 0);
