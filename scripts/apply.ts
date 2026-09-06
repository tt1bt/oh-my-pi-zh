// apply.ts — 用户侧一键应用汉化。
//
// 用法：
//   bun scripts/apply.ts [--force] [--bun-global <path>] [--launcher-dir <path>]
//                        [--no-auto-heal] [--check] [--quiet]
//
// 行为：
//   1. 定位 bun 全局 node_modules 与已安装的 @oh-my-pi/pi-coding-agent
//   2. 复制为 pi-coding-agent-zh 副本（原包永不触碰）
//   3. 加载 translations/，按「内容级匹配」把翻译写入副本（行号无关，版本漂移仍可命中）
//   4. 在副本内生成自愈启动器 omp-zh-launch.mjs，并在 ~/.local/bin 安装 omp 启动器
//   5. 写版本标记 ~/.omp-hanhua.json（自愈启动器据此判断 omp 是否升级）
//
// 退出码：0 成功；1 失败。

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { applyEntriesToText, groupEntries } from './lib/apply-entries';
import { loadTranslationDir } from './lib/db';

// ---------- 参数 ----------
interface Args {
	force: boolean;
	bunGlobal: string;
	launcherDir: string;
	noAutoHeal: boolean;
	check: boolean;
	quiet: boolean;
	/** 维护者用：对指定源码目录预演（不安装） */
	source: string;
}

function parseArgs(argv: string[]): Args {
	const norm = (a: string) => (a.startsWith('-') ? a.replace(/^--?/, '').toLowerCase() : a);
	const args: Args = { force: false, bunGlobal: '', launcherDir: '', noAutoHeal: false, check: false, quiet: false, source: '' };
	for (let i = 0; i < argv.length; i++) {
		const a = norm(argv[i]);
		switch (a) {
			case 'force': args.force = true; break;
			case 'bun-global': args.bunGlobal = argv[++i] ?? ''; break;
			case 'launcher-dir': args.launcherDir = argv[++i] ?? ''; break;
			case 'no-auto-heal': args.noAutoHeal = true; break;
			case 'check': args.check = true; break;
			case 'quiet': args.quiet = true; break;
			case 'source': args.source = argv[++i] ?? ''; break;
			default:
				console.error(`[omp-zh] 未知参数: ${argv[i]}`);
				process.exit(1);
		}
	}
	return args;
}
const args = parseArgs(process.argv.slice(2));
if (args.source) args.check = true; // --source 仅用于预演
const log = (...m: unknown[]) => { if (!args.quiet) console.log(...m); };

// ---------- 定位 bun 全局目录 ----------
function findBunGlobalModules(): string {
	if (args.bunGlobal) return resolve(args.bunGlobal);
	try {
		const { execSync } = require('node:child_process') as typeof import('node:child_process');
		const binDir = execSync('bun pm bin -g', { encoding: 'utf8' }).trim().split('\n').pop()?.trim() ?? '';
		if (binDir) {
			const candidate = join(binDir, '..', 'install', 'global', 'node_modules');
			if (existsSync(candidate)) return resolve(candidate);
		}
	} catch {}
	const home = homedir();
	for (const candidate of [join(home, '.bun', 'install', 'global', 'node_modules')]) {
		if (existsSync(candidate)) return candidate;
	}
	return '';
}

// ---------- PATH 顺序检查（成员资格 + 与 bun bin 的先后） ----------
function pathCheck(launcherDir: string, globalModules: string): { inPath: boolean; beforeBun: boolean } {
	const norm = (p: string) => resolve(p).toLowerCase().replace(/[\\/]+$/, '');
	const parts = (process.env.PATH ?? '').split(sep === '\\' ? ';' : ':').filter(Boolean).map(norm);
	const idx = parts.indexOf(norm(launcherDir));
	const bunBinIdx = parts.indexOf(norm(join(globalModules, '..', '..', '..', 'bin')));
	return { inPath: idx !== -1, beforeBun: idx !== -1 && (bunBinIdx === -1 || idx < bunBinIdx) };
}

// ---------- 主流程 ----------
function main(): number {
	const scriptDir = resolve(import.meta.dir);
	const repoRoot = resolve(scriptDir, '..');
	const translationsDir = join(repoRoot, 'translations');
	// --source：维护者对任意 omp 源码目录预演；否则用真实安装
	const globalModules = args.source ? '' : findBunGlobalModules();
	if (!args.source && (!globalModules || !existsSync(globalModules))) {
		console.error('[omp-zh] ERROR: 找不到 bun 全局 node_modules。请确认已安装 bun，或用 --bun-global 指定路径。');
		return 1;
	}
	const srcPkg = args.source ? resolve(args.source) : join(globalModules, '@oh-my-pi', 'pi-coding-agent');
	const dstPkg = join(globalModules || '', '@oh-my-pi', 'pi-coding-agent-zh');
	const srcPkgJson = join(srcPkg, 'package.json');
	if (!existsSync(srcPkgJson)) {
		console.error(`[omp-zh] ERROR: 未找到 omp 源码包: ${srcPkg}`);
		if (!args.source) console.error('[omp-zh] 请先安装: bun add -g @oh-my-pi/pi-coding-agent');
		return 1;
	}
	const ompVersion = (JSON.parse(readFileSync(srcPkgJson, 'utf8')) as { version: string }).version;

	// 翻译库
	if (!existsSync(translationsDir)) {
		console.error(`[omp-zh] ERROR: 未找到翻译库: ${translationsDir}`);
		return 1;
	}
	const { entries } = loadTranslationDir(translationsDir);
	const grouped = groupEntries(entries);

	// --check：对源包做内存预演，不动任何文件
	if (args.check) {
		let hits = 0;
		const zeroHitFiles = new Map<string, number>();
		for (const [file, set] of grouped) {
			const total = set.lineMap.size + set.litMap.size + set.snippets.length + set.assets.length;
			if (!existsSync(join(srcPkg, file))) {
				zeroHitFiles.set(file, (zeroHitFiles.get(file) ?? 0) + total);
				continue;
			}
			const res = applyEntriesToText(readFileSync(join(srcPkg, file), 'utf8'), set);
			for (const n of res.hits.values()) hits += n;
			const zeroHit = total - res.hits.size;
			if (zeroHit > 0) zeroHitFiles.set(file, (zeroHitFiles.get(file) ?? 0) + zeroHit);
		}
		log(`[omp-zh] 预演 (omp v${ompVersion})：命中 ${hits} 处 / 条目 ${entries.length}。未命中条目最多的文件：`);
		for (const [f, n] of [...zeroHitFiles].sort((a, b) => b[1] - a[1]).slice(0, 15)) log(`    ${String(n).padStart(4)}  ${f}`);
		return 0;
	}

	// 版本标记：写在汉化副本内（自包含）；兼容读取旧 ~/.omp-hanhua-version
	const markerPath = join(dstPkg, '.omp-zh-marker.json');
	const legacyMarker = join(homedir(), '.omp-hanhua-version');
	if (!args.force && existsSync(dstPkg) && existsSync(markerPath)) {
		try {
			const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { ompVersion?: string };
			if (marker.ompVersion === ompVersion) {
				log(`[omp-zh] 汉化副本已是最新 (v${ompVersion})，无需重打。(--force 可强制)`);
				return 0;
			}
		} catch {}
	}
	if (!args.force && existsSync(dstPkg) && existsSync(legacyMarker)) {
		const legacy = readFileSync(legacyMarker, 'utf8').trim();
		if (legacy === ompVersion) {
			log(`[omp-zh] 汉化副本已是最新 (v${ompVersion})，无需重打。(--force 可强制)`);
			return 0;
		}
	}

	// 1) 复制副本
	log(`[omp-zh] 正在重建汉化副本 (omp v${ompVersion}) ...`);
	rmSync(dstPkg, { recursive: true, force: true });
	cpSync(srcPkg, dstPkg, { recursive: true });

	// 2) 应用翻译
	let hitCount = 0;
	let changedFiles = 0;
	const missByFile = new Map<string, string[]>();
	const missZeroEntries: { file: string; kind: string; en: string }[] = [];
	for (const [file, set] of grouped) {
		const dstFile = join(dstPkg, file);
		const totalEntries = set.lineMap.size + set.litMap.size + set.snippets.length + set.assets.length;
		if (!existsSync(dstFile)) {
			missByFile.set(file, [...(missByFile.get(file) ?? []), `文件不存在（可能 omp 重构移动了它）×${totalEntries} 条`]);
			missZeroEntries.push({ file, kind: 'file', en: `<缺失> ×${totalEntries}` });
			continue;
		}
		const text = readFileSync(dstFile, 'utf8');
		const res = applyEntriesToText(text, set);
		for (const n of res.hits.values()) hitCount += n;
		if (res.changed) {
			writeFileSync(dstFile, res.text, 'utf8');
			changedFiles++;
		}
		// 零命中条目统计（漂移信号）
		const zeroHit = totalEntries - res.hits.size;
		if (zeroHit > 0) {
			missByFile.set(file, [...(missByFile.get(file) ?? []), `${zeroHit} 条未命中`]);
			const hitSet = new Set([...res.hits.keys()]);
			for (const [key, list] of set.lineMap) {
				for (const e of list) if (!hitSet.has(e)) missZeroEntries.push({ file, kind: 'line', en: key.slice(0, 60) });
			}
			for (const [key, list] of set.litMap) {
				for (const e of list) if (!hitSet.has(e)) missZeroEntries.push({ file, kind: e.kind, en: key.slice(0, 60) });
			}
			for (const sn of set.snippets) if (!hitSet.has(sn)) missZeroEntries.push({ file, kind: 'snippet', en: sn.name });
			for (const as of set.assets) if (!hitSet.has(as)) missZeroEntries.push({ file, kind: 'asset', en: file });
		}
	}

	// 3) 生成自愈启动器（副本内）+ 安装顶层启动器
	const launcherDir = args.launcherDir ? resolve(args.launcherDir) : join(homedir(), '.local', 'bin');
	mkdirSync(launcherDir, { recursive: true });
	const isWindows = process.platform === 'win32' || process.env.OS === 'Windows_NT';

	if (!args.noAutoHeal) {
		const heal = generateHealLauncher(repoRoot, srcPkg, markerPath, ompVersion, args.bunGlobal, args.launcherDir);
		writeFileSync(join(dstPkg, 'omp-zh-launch.mjs'), heal, 'utf8');
	}
	const cliTarget = args.noAutoHeal ? join(dstPkg, 'src', 'cli.ts') : join(dstPkg, 'omp-zh-launch.mjs');
	if (isWindows) {
		const cmd = `@echo off\r\nbun "${cliTarget}" %*\r\n`;
		writeFileSync(join(launcherDir, 'omp.cmd'), cmd, 'utf8');
	} else {
		const sh = `#!/usr/bin/env bash\nexec bun "${cliTarget}" "$@"\n`;
		const omp = join(launcherDir, 'omp');
		writeFileSync(omp, sh, 'utf8');
		try { require('node:fs').chmodSync(omp, 0o755); } catch {}
	}

	// 4) 写版本标记
	writeFileSync(markerPath, JSON.stringify({
		ompVersion,
		appliedAt: new Date().toISOString(),
		hits: hitCount,
		entries: entries.length,
		repo: repoRoot,
		dst: dstPkg,
	}, null, 2), 'utf8');

	// 5) 汇报
	log(`[omp-zh] 完成！命中 ${hitCount} 处翻译，改动 ${changedFiles} 个文件 (omp v${ompVersion})。`);
	if (missZeroEntries.length) {
		log(`[omp-zh] 未命中 ${missZeroEntries.length} 条（omp 文案变更所致，不影响使用，只是局部保持英文）。`);
		if (!args.quiet) {
			for (const [f, list] of [...missByFile].sort().slice(0, 10)) log(`    ${f}: ${list.join('; ')}`);
			if (missByFile.size > 10) log(`    ... 共 ${missByFile.size} 个文件有未命中`);
		}
	}
	const pc = pathCheck(launcherDir, globalModules);
	const launcherName = isWindows ? 'omp.cmd' : 'omp';
	log(`[omp-zh] 启动器: ${join(launcherDir, launcherName)}`);
	if (!pc.inPath) {
		log(`[omp-zh] 警告: ${launcherDir} 不在 PATH 中。`);
	} else if (!pc.beforeBun) {
		log(`[omp-zh] 警告: ${launcherDir} 在 PATH 中但排在 bun bin 之后，直接敲 omp 会启动原版。`);
	} else {
		log('[omp-zh] 现在直接运行 omp 即为汉化版。');
	}
	return 0;
}

/** 生成自愈启动器脚本（写入汉化副本内）。 */
function generateHealLauncher(repoRoot: string, srcPkg: string, markerPath: string, ompVersion: string, bunGlobal: string, launcherDir: string): string {
	const q = (s: string) => JSON.stringify(s.split(sep).join('/'));
	// 自愈时继承安装时使用的 bun-global/launcher-dir（真实安装场景二者为空，等价默认行为）
	const extra: string[] = [];
	if (bunGlobal) extra.push('--bun-global', bunGlobal.split(sep).join('/'));
	if (launcherDir) extra.push('--launcher-dir', launcherDir.split(sep).join('/'));
	return `#!/usr/bin/env bun
// 由 oh-my-pi-zh apply 生成 (v${ompVersion})——omp 升级后自动重打汉化。
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";

const REPO = ${q(repoRoot)};
const SRC = ${q(srcPkg)};
const MARKER = ${q(markerPath)};
const EXTRA = ${JSON.stringify(extra)};
const SELF = import.meta.dirname;

function pkgVersion(p) {
	try { return JSON.parse(readFileSync(p + "/package.json", "utf8")).version; } catch { return ""; }
}
const cur = pkgVersion(SRC);
let marked = "";
try { marked = JSON.parse(readFileSync(MARKER, "utf8")).ompVersion; } catch {}
if (cur && marked && cur !== marked) {
	const applyScript = REPO + "/scripts/apply.ts";
	if (existsSync(applyScript)) {
		console.log("[omp-zh] 检测到 omp 已升级 (" + marked + " → " + cur + ")，自动更新汉化 ...");
		const r = spawnSync(process.execPath, [applyScript, "--quiet", ...EXTRA], { stdio: "inherit" });
		if (r.status !== 0) console.log("[omp-zh] 自动更新失败，以上次汉化版本启动。");
	} else {
		console.log("[omp-zh] omp 已升级 (" + cur + ")，汉化未更新：找不到 " + applyScript);
		console.log("[omp-zh] 请重新克隆/更新 oh-my-pi-zh 后重跑 apply。");
	}
}
const r2 = spawnSync(process.execPath, [SELF + "/src/cli.ts", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r2.status ?? 0);
`;
}

process.exit(main());
