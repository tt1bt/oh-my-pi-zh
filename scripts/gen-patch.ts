// gen-patch.ts — 由翻译库再生统一 diff 补丁（hanhua.patch，审计/兼容产物）。
//
// 用法：
//   bun scripts/gen-patch.ts --version 18.1.11   # 指定 omp 版本（npm 拉取）
//   bun scripts/gen-patch.ts --source <pkgDir>   # 本地已解包的 omp
//   bun scripts/gen-patch.ts --out hanhua.patch  # 输出路径（默认 hanhua.patch）
//
// 产物格式与旧手工补丁一致（-p2，a/pi-coding-agent/ → b/pi-coding-agent-zh/），
// 可继续用 git apply / patch -p2 应用，也可作为 diff 审计工具。

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applyEntriesToText, groupEntries } from './lib/apply-entries';
import { loadTranslationDir } from './lib/db';

function arg(name: string, def = ''): string {
	const i = process.argv.indexOf(`--${name}`);
	return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const VERSION = arg('version');
const SOURCE = arg('source');
const OUT = arg('out', 'hanhua.patch');
const WORK = arg('work', '.tmp/genpatch');

if (!VERSION && !SOURCE) {
	console.error('用法: bun scripts/gen-patch.ts --version <omp版本> 或 --source <已解包目录>');
	process.exit(1);
}

// 获取源码
let srcDir: string;
if (SOURCE) {
	srcDir = resolve(SOURCE);
} else {
	mkdirSync(WORK, { recursive: true });
	srcDir = join(WORK, `pkg-${VERSION}`);
	if (!existsSync(srcDir)) {
		const { execSync } = require('node:child_process') as typeof import('node:child_process');
		execSync(`npm pack @oh-my-pi/pi-coding-agent@${VERSION} --pack-destination "${WORK}"`, { stdio: 'inherit' });
		mkdirSync(srcDir, { recursive: true });
		execSync(`tar -xzf "${join(WORK, `oh-my-pi-pi-coding-agent-${VERSION}.tgz`)}" -C "${srcDir}" --strip-components=1`);
	}
}

const ompVersion = (JSON.parse(readFileSync(join(srcDir, 'package.json'), 'utf8')) as { version: string }).version;
console.log(`[gen-patch] omp v${ompVersion} @ ${srcDir}`);

// 构造两棵树：pristine / translated
const parent = join(WORK, `tree-${ompVersion}`);
rmSync(parent, { recursive: true, force: true });
mkdirSync(parent, { recursive: true });
const treeA = join(parent, 'pi-coding-agent');
const treeB = join(parent, 'pi-coding-agent-zh');
cpSync(srcDir, treeA, { recursive: true });
cpSync(srcDir, treeB, { recursive: true });

const { entries } = loadTranslationDir('translations');
const grouped = groupEntries(entries);
let changed = 0;
for (const [file, set] of grouped) {
	const dstFile = join(treeB, file);
	if (!existsSync(dstFile)) continue;
	const res = applyEntriesToText(readFileSync(dstFile, 'utf8'), set);
	if (res.changed) {
		writeFileSync(dstFile, res.text, 'utf8');
		changed++;
	}
}
console.log(`[gen-patch] 应用翻译：改动 ${changed} 个文件`);

// git diff --no-index 生成补丁（路径即 a/pi-coding-agent/... b/pi-coding-agent-zh/...）
// 注意：有差异时 git 退出码为 1，属正常情况，输出在 stdout
const { execSync } = require('node:child_process') as typeof import('node:child_process');
let diff = '';
try {
	diff = execSync(`git -c core.autocrlf=false diff --no-index --src-prefix=a/ --dst-prefix=b/ "pi-coding-agent" "pi-coding-agent-zh"`, {
		cwd: parent,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
	});
} catch (e) {
	diff = (e as { stdout?: string }).stdout ?? '';
	if (!diff) {
		console.error('[gen-patch] git diff 失败:', (e as Error).message);
		process.exit(1);
	}
}
if (!diff) {
	console.error('[gen-patch] 无差异（翻译库未命中任何文件？）');
	process.exit(1);
}
// 去掉临时路径残留，规整 index 行（可选项：保留亦可应用）
writeFileSync(OUT, diff, 'utf8');
const lines = diff.split('\n').length;
console.log(`[gen-patch] ✓ ${OUT} (${lines} 行)。应用: git apply -p2 ${OUT}（在 omp 包内执行）`);
