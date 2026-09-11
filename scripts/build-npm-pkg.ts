// build-npm-pkg.ts — 构建可发布到 npm 的汉化整包（omp-zh）。
//
// 用法：
//   bun scripts/build-npm-pkg.ts --version 18.1.17        # 从 npm 拉取指定版本并构建
//   bun scripts/build-npm-pkg.ts --source <pkgDir>        # 用本地已解包的 omp
//   bun scripts/build-npm-pkg.ts --version 18.1.17 --publish
//
// 产物：<out>/<包名>/ —— 一份"已应用汉化"的 omp 包，package.json 已改写为可直接 npm publish。
//
// 与 apply.ts 的区别：apply.ts 在用户机器上就地汉化**已安装的**包；本脚本产出**可分发**的整包。
// 版本号沿用上游版本（如 18.1.17），便于一眼看出对应哪个上游版本。
//
// 注意：bin 是生成的 bin/omp.mjs，它用 bun 直跑汉化后的 src/cli.ts（显式调用 runCli），
// 因此启动约 4-5 秒（未打包），需要用户装有 bun。
// 包内的 dist/cli.js 仍是上游原版（未汉化），仅为兼容保留、不是入口。

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { applyEntriesToText, groupEntries } from './lib/apply-entries';
import { loadTranslationDir, parseJsonc } from './lib/db';

function arg(name: string, def = ''): string {
	const i = process.argv.indexOf(`--${name}`);
	return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const VERSION = arg('version');
const SOURCE = arg('source');
const NAME = arg('name', 'omp-zh');
const OUT = resolve(arg('out', join('.tmp', 'npm-pkg')));
const DO_PUBLISH = has('publish');
const REGISTRY = arg('registry', 'https://registry.npmjs.org');
const WORK = arg('work', '.tmp/npm-build');
const REPO_URL = 'https://github.com/tt1bt/oh-my-pi-zh';

if (!VERSION && !SOURCE) {
	console.error('用法: bun scripts/build-npm-pkg.ts --version <omp版本> [--source <已解包目录>] [--name omp-zh] [--out <dir>] [--publish]');
	process.exit(1);
}

// ---------- 取源码 ----------
function fetchPkg(version: string): string {
	mkdirSync(WORK, { recursive: true });
	const dir = join(WORK, `pkg-${version}`);
	if (existsSync(dir)) return dir;
	console.log(`[npm-pkg] 拉取 @oh-my-pi/pi-coding-agent@${version} ...`);
	execSync(`npm pack @oh-my-pi/pi-coding-agent@${version} --pack-destination "${WORK}"`, { stdio: 'pipe' });
	mkdirSync(dir, { recursive: true });
	execSync(`tar -xzf "${join(WORK, `oh-my-pi-pi-coding-agent-${version}.tgz`)}" -C "${dir}" --strip-components=1`);
	return dir;
}
const srcDir = SOURCE ? resolve(SOURCE) : fetchPkg(VERSION);
const upstreamPkg = JSON.parse(readFileSync(join(srcDir, 'package.json'), 'utf8')) as Record<string, unknown>;
const ompVersion = String(upstreamPkg.version);
console.log(`[npm-pkg] 源: omp v${ompVersion} @ ${srcDir}`);

// ---------- 翻译库基线自检 ----------
const baseVersion = parseJsonc<{ baseVersion?: string }>(readFileSync('translations/meta.jsonc', 'utf8')).baseVersion ?? '';
if (baseVersion && baseVersion !== ompVersion) {
	const msg = `翻译库基线为 ${baseVersion}，与目标 ${ompVersion} 不一致；未命中的文案会保持英文。`;
	if (has('strict-baseline')) {
		console.error(`[npm-pkg] 拒绝构建: ${msg}`);
		console.error('[npm-pkg] 请先按 README「维护者指南」跟进新版本，把 translations/meta.jsonc 的 baseVersion 更新为目标版本。');
		process.exit(1);
	}
	console.warn(`[npm-pkg] 警告: ${msg}`);
}

// ---------- 复制 + 应用翻译 ----------
const dstRoot = join(OUT, NAME);
rmSync(dstRoot, { recursive: true, force: true });
mkdirSync(dstRoot, { recursive: true });
console.log(`[npm-pkg] 复制源码树 ...`);
cpSync(srcDir, dstRoot, { recursive: true });

const { entries } = loadTranslationDir('translations');
const grouped = groupEntries(entries);
let hitCount = 0;
let changedFiles = 0;
const missed: string[] = [];
for (const [file, set] of grouped) {
	const dstFile = join(dstRoot, file);
	if (!existsSync(dstFile)) {
		missed.push(file);
		continue;
	}
	const res = applyEntriesToText(readFileSync(dstFile, 'utf8'), set);
	for (const n of res.hits.values()) hitCount += n;
	if (res.changed) {
		writeFileSync(dstFile, res.text, 'utf8');
		changedFiles++;
	}
	const zero = set.lineMap.size + set.litMap.size + set.snippets.length + set.assets.length - res.hits.size;
	if (zero > 0) missed.push(`${file} (${zero} 条未命中)`);
}
console.log(`[npm-pkg] 应用翻译: 命中 ${hitCount} 处，改动 ${changedFiles} 个文件`);
if (missed.length) {
	console.log(`[npm-pkg] 未完全命中（保持英文）: ${missed.length} 个文件`);
	for (const m of missed.slice(0, 10)) console.log(`    ${m}`);
}

// ---------- bin 入口 ----------
// 为什么不用 `bin: {omp: "./src/cli.ts"}`：
//   1) bun 给 .ts 入口生成 shim 时会崩（1.3.14 实测），.mjs 则正常；
//   2) cli.ts 用 `import.meta.main` 判断入口，被 import 时该值为 false，会静默什么都不做。
// 因此这里生成一个 .mjs 用「显式调用 runCli」复刻上游入口的最后一段（与 cli.ts 尾部等价）：
//   runCli(process.argv.slice(2)).catch(fatal)
const CLI_ENTRY = 'bin/omp.mjs';
const cliTs = join(dstRoot, 'src', 'cli.ts');
const cliText = existsSync(cliTs) ? readFileSync(cliTs, 'utf8') : '';
if (!/export async function runCli\(/.test(cliText)) {
	console.error('[npm-pkg] src/cli.ts 未导出 runCli，上游入口结构变了，请检查 bin 生成逻辑。');
	process.exit(1);
}
mkdirSync(join(dstRoot, 'bin'), { recursive: true });
writeFileSync(
	join(dstRoot, 'bin', 'omp.mjs'),
	[
		'#!/usr/bin/env bun',
		'// 由 oh-my-pi-zh build-npm-pkg 生成——等价于 src/cli.ts 的入口段：',
		'//   if (isProcessEntry) runCli(process.argv.slice(2)).catch(fatal);',
		'// 这里直接显式调用，绕开 import.meta.main（被 import 的模块该值为 false）。',
		'import { fatal } from "@oh-my-pi/pi-utils/postmortem";',
		'import { runCli } from "../src/cli.ts";',
		'',
		'runCli(process.argv.slice(2)).catch(fatal);',
		'',
	].join('\n'),
	'utf8',
);

// ---------- 改写 package.json ----------
const pkg = { ...upstreamPkg };
pkg.name = NAME;
pkg.version = ompVersion;
pkg.description = `oh-my-pi (omp) CLI 简体中文汉化版（非官方，对应上游 ${ompVersion}）`;
pkg.bin = { omp: CLI_ENTRY };
pkg.repository = { type: 'git', url: `git+${REPO_URL}.git` };
pkg.homepage = `${REPO_URL}#readme`;
pkg.bugs = { url: `${REPO_URL}/issues` };
pkg.keywords = [...(Array.isArray(pkg.keywords) ? (pkg.keywords as string[]) : []), 'chinese', 'i18n', 'zh-cn'];
// 把 bin 加进 files 白名单（保留上游其余白名单项）
const files = Array.isArray(pkg.files) ? (pkg.files as string[]) : [];
pkg.files = files.includes('bin') ? files : [...files, 'bin'];
delete pkg.publishConfig;
delete pkg.private;
// 去掉上游的 scripts：其中的 prepack 会在 npm pack/publish 时触发构建，
// 而 build/gen:* 又指向 monorepo 里不存在的路径（../collab-web、../natives）必然失败。
// 本包是二次分发产物，不需要这些脚本。
delete pkg.scripts;
writeFileSync(join(dstRoot, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');

// ---------- 包内 README（覆盖上游英文 README） ----------
writeFileSync(
	join(dstRoot, 'README.md'),
	[
		`# ${NAME}`,
		'',
		`[oh-my-pi](https://github.com/can1357/oh-my-pi)（CLI 名 \`omp\`）的**简体中文汉化版**，对应上游 **${ompVersion}**。`,
		'',
		'> **非官方包。** 由社区汉化项目 [oh-my-pi-zh](' + REPO_URL + ') 生成，与上游作者无关。',
		'> 翻译采用内容级替换，未覆盖的文案会保持英文（不影响功能）。',
		'',
		'## 安装',
		'',
		'```bash',
		`bun install -g ${NAME}`,
		'```',
		'',
		'安装后直接运行 `omp` 即为中文界面（需要 [bun](https://bun.sh) ≥ 1.3.14）。',
		'',
		'```bash',
		'omp --help',
		'```',
		'',
		'升级：`bun install -g ' + NAME + '@latest`　卸载：`bun remove -g ' + NAME + '`',
		'',
		'## 说明',
		'',
		'- 本包用 bun 直接运行汉化后的 TypeScript 源码，启动约 4-5 秒。',
		'- 包内的 `dist/cli.js` 为上游原版（未汉化），仅为兼容保留，不是本包入口。',
		'- 上游更新后，汉化项目会跟进翻译并重新发版。',
		'',
		'## 许可',
		'',
		'[MIT](LICENSE)。翻译内容与脚本基于 MIT 许可的 oh-my-pi 派生，感谢原作者。',
		'',
	].join('\n'),
	'utf8',
);

// ---------- 体积统计 ----------
function dirSize(dir: string): { bytes: number; files: number } {
	let bytes = 0;
	let files = 0;
	const walk = (d: string) => {
		for (const name of require('node:fs').readdirSync(d)) {
			const p = join(d, name);
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else {
				bytes += st.size;
				files++;
			}
		}
	};
	walk(dir);
	return { bytes, files };
}
const size = dirSize(dstRoot);
const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

console.log(`[npm-pkg] 产物: ${dstRoot}`);
console.log(`[npm-pkg] 体积: ${mb(size.bytes)} MB / ${size.files} 个文件（发布前打包后约为此的 1/3）`);
console.log('');
console.log('下一步（发布）:');
console.log(`  cd "${dstRoot}" && npm publish --registry ${REGISTRY} --access public`);
console.log('提示: 本地 ~/.npmrc 若指向镜像源（如 npmmirror）将无法发布，需用上面的 --registry 指定官方源并先 npm login。');

if (DO_PUBLISH) {
	console.log('');
	console.log(`[npm-pkg] 发布到 ${REGISTRY} ...`);
	execSync(`npm publish --registry ${REGISTRY} --access public`, { cwd: dstRoot, stdio: 'inherit' });
	console.log('[npm-pkg] ✓ 已发布');
}
