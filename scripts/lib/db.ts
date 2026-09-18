// 翻译库读写：JSONC 解析（剥离注释）、条目序列化、按区域分组。

import type { Entry, PkgId, TranslationFile } from './types';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 剥离 JSONC 注释（字符串字面量内的 // 与 /* 不受影响）。 */
export function stripJsonComments(text: string): string {
	let out = '';
	let i = 0;
	const n = text.length;
	while (i < n) {
		const c = text[i];
		if (c === '"') {
			// 字符串原样拷贝
			const end = readJsonString(text, i);
			out += text.slice(i, end);
			i = end;
			continue;
		}
		if (c === '/' && text[i + 1] === '/') {
			const nl = text.indexOf('\n', i);
			i = nl === -1 ? n : nl; // 保留换行
			continue;
		}
		if (c === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end === -1 ? n : end + 2;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

function readJsonString(text: string, start: number): number {
	// start 指向开引号，返回闭引号之后的索引
	let i = start + 1;
	while (i < text.length) {
		const c = text[i];
		if (c === '\\') { i += 2; continue; }
		if (c === '"') return i + 1;
		i++;
	}
	return text.length;
}

export function parseJsonc<T>(text: string): T {
	const stripped = stripJsonComments(text);
	// 容忍尾逗号（字符串感知：仅删除不在字符串内的、后随 } 或 ] 的逗号）
	const cleaned = removeTrailingCommas(stripped);
	return JSON.parse(cleaned) as T;
}

function removeTrailingCommas(text: string): string {
	let out = '';
	let i = 0;
	const n = text.length;
	while (i < n) {
		const c = text[i];
		if (c === '"') {
			const end = readJsonString(text, i);
			out += text.slice(i, end);
			i = end;
			continue;
		}
		if (c === ',') {
			let j = i + 1;
			while (j < n && /\s/.test(text[j])) j++;
			if (text[j] === '}' || text[j] === ']') {
				i++; // 丢弃尾逗号
				continue;
			}
		}
		out += c;
		i++;
	}
	return out;
}

/** 读取翻译目录下全部条目。
 *  条目按所在子目录标注包归属：
 *    translations/*.jsonc       -> pkg=agent（@oh-my-pi/pi-coding-agent）
 *    translations/tui/*.jsonc   -> pkg=tui  （@oh-my-pi/pi-tui，omp 18.2.5 起抽出）
 *  另有一个根级 meta.jsonc 记录基线版本，不参与条目加载。
 */
export function loadTranslationDir(dir: string): { entries: Entry[]; sourceFiles: string[] } {
	const entries: Entry[] = [];
	const sourceFiles: string[] = [];

	const readFile = (full: string, pkg: PkgId) => {
		const data = parseJsonc<TranslationFile>(readFileSync(full, 'utf8'));
		if (!data.entries) return;
		for (const e of data.entries) {
			// 条目显式声明的 pkg 优先（用于同文件内混合归属，如从主包迁到 pi-tui 的条目）
			const explicit = (e as { pkg?: PkgId }).pkg;
			(e as { pkg?: PkgId }).pkg = explicit === 'tui' || explicit === 'agent' ? explicit : pkg;
			entries.push(e);
		}
		sourceFiles.push(full);
	};

	for (const name of readdirSync(dir).sort()) {
		if (!name.endsWith('.jsonc') && !name.endsWith('.json')) continue;
		if (name === 'meta.jsonc' || name === 'excluded.jsonc') continue;
		readFile(join(dir, name), 'agent');
	}

	// 子目录：每个子目录名即包标识（tui -> @oh-my-pi/pi-tui）
	const tuiDir = join(dir, 'tui');
	if (existsSync(tuiDir)) {
		for (const name of readdirSync(tuiDir).sort()) {
			if (!name.endsWith('.jsonc') && !name.endsWith('.json')) continue;
			readFile(join(tuiDir, name), 'tui');
		}
	}

	return { entries, sourceFiles };
}

/** 把条目按区域拆分并写出 JSONC 文件（每条一行，git 友好）。
 *  pkg=tui 的条目写入 translations/tui/ 子目录，其余写入 translations/ 根目录。 */
export function writeTranslationFiles(dir: string, entries: Entry[]): string[] {
	mkdirSync(dir, { recursive: true });
	const areaOf = (file: string): string => {
		if (file.startsWith('src/cli/')) return 'cli';
		if (file.startsWith('src/commands/')) return 'commands';
		if (file.startsWith('src/config/')) return 'settings';
		if (file.startsWith('src/modes/')) return 'modes';
		if (file.startsWith('src/tools/')) return 'tools';
		if (file.startsWith('src/tui/')) return 'tui';
		if (file.startsWith('src/prompts/')) return 'prompts';
		return 'misc';
	};
	// 键 = 目标目录 + 区域名
	const groups = new Map<string, { dir: string; area: string; list: Entry[] }>();
	for (const e of entries) {
		const pkg: PkgId = (e as { pkg?: PkgId }).pkg === 'tui' ? 'tui' : 'agent';
		const targetDir = pkg === 'tui' ? join(dir, 'tui') : dir;
		const area = e.kind === 'snippet' ? 'snippets' : areaOf(e.file);
		const key = `${pkg}:${area}`;
		const g = groups.get(key) ?? { dir: targetDir, area, list: [] };
		g.list.push(e);
		groups.set(key, g);
	}
	const written: string[] = [];
	const writtenByDir = new Map<string, Set<string>>();
	for (const { dir: gdir, area, list } of groups.values()) {
		mkdirSync(gdir, { recursive: true });
		const lines = ['{', `\t"entries": [`];
		list.forEach((e, idx) => {
			// pkg 是加载期推导的元数据，不写回文件
			const { pkg: _drop, ...rest } = e as Entry & { pkg?: PkgId };
			const comma = idx === list.length - 1 ? '' : ',';
			lines.push(`\t\t${JSON.stringify(rest)}${comma}`);
		});
		lines.push('\t]', '}');
		const file = join(gdir, `${area}.jsonc`);
		writeFileSync(file, lines.join('\n') + '\n', 'utf8');
		written.push(file);
		const set = writtenByDir.get(gdir) ?? new Set<string>();
		set.add(`${area}.jsonc`);
		writtenByDir.set(gdir, set);
	}
	// 清掉已无条目的区域文件（否则残留文件会被下次加载读回）
	for (const [gdir, names] of writtenByDir) {
		for (const name of readdirSync(gdir)) {
			if (!name.endsWith('.jsonc') || name === 'excluded.jsonc' || name === 'meta.jsonc') continue;
			if (!names.has(name)) rmSync(join(gdir, name));
		}
	}
	return written;
}
