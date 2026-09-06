// 翻译库读写：JSONC 解析（剥离注释）、条目序列化、按区域分组。

import type { Entry, TranslationFile } from './types';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** 读取翻译目录下全部条目。 */
export function loadTranslationDir(dir: string): { entries: Entry[]; sourceFiles: string[] } {
	const entries: Entry[] = [];
	const sourceFiles: string[] = [];
	for (const name of readdirSync(dir).sort()) {
		if (!name.endsWith('.jsonc') && !name.endsWith('.json')) continue;
		const full = join(dir, name);
		const data = parseJsonc<TranslationFile>(readFileSync(full, 'utf8'));
		if (!data.entries) continue;
		entries.push(...data.entries);
		sourceFiles.push(name);
	}
	return { entries, sourceFiles };
}

/** 把条目按区域拆分并写出 JSONC 文件（每条一行，git 友好）。 */
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
	const groups = new Map<string, Entry[]>();
	for (const e of entries) {
		const area = e.kind === 'snippet' ? 'snippets' : areaOf(e.file);
		const list = groups.get(area) ?? [];
		list.push(e);
		groups.set(area, list);
	}
	const written: string[] = [];
	const writtenNames = new Set<string>();
	for (const [area, list] of groups) {
		const lines = ['{', `\t"entries": [`];
		list.forEach((e, idx) => {
			const comma = idx === list.length - 1 ? '' : ',';
			lines.push(`\t\t${JSON.stringify(e)}${comma}`);
		});
		lines.push('\t]', '}');
		const file = join(dir, `${area}.jsonc`);
		writeFileSync(file, lines.join('\n') + '\n', 'utf8');
		written.push(file);
		writtenNames.add(`${area}.jsonc`);
	}
	// 清掉已无条目的区域文件（否则残留文件会被下次加载读回）
	for (const name of readdirSync(dir)) {
		if (!name.endsWith('.jsonc') || name === 'excluded.jsonc' || name === 'meta.jsonc') continue;
		if (!writtenNames.has(name)) rmSync(join(dir, name));
	}
	return written;
}
