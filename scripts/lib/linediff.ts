// 行级 LCS diff（先去公共前后缀；规模超限时退化为整段 del+ins）。

export type DiffOp = { type: 'eq' | 'del' | 'ins'; aNo?: number; bNo?: number; aText?: string; bText?: string };

export function diffLines(a: string[], b: string[]): DiffOp[] {
	const ops: DiffOp[] = [];
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
