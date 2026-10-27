import { rankSearchItems, type SearchIndexItem } from "../src/search";
import suite from "../test/search-queries.json";

const baseUrl = Bun.env.SEARCH_BASE_URL ?? "http://localhost:3000";
const response = await fetch(new URL("/search-index.json", baseUrl));
if (!response.ok) throw new Error(`Search index returned HTTP ${response.status}`);
const items: SearchIndexItem[] = await response.json();
const key = (item: { type: string; id: string }) => `${item.type}:${item.id}`;
for (const test of suite.cases) {
  for (const expected of test.expected) {
    if (!items.some((item) => key(item) === key(expected))) {
      throw new Error(`Missing expected catalog entry: ${key(expected)}`);
    }
  }
}
const cases = suite.cases.map((test) => {
  const start = performance.now();
  const results = rankSearchItems(items, test.query);
  const elapsedMs = performance.now() - start;
  const expected = new Set(test.expected.map(key));
  const found = results.findIndex(({ item }) => expected.has(key(item)));
  const rank = found < 0 ? null : found + 1;
  const excluded = results.filter(({ item }) =>
    (test as { exclude?: string[] }).exclude?.includes(item.id),
  ).map(({ item }) => key(item));
  const passed = expected.size ? rank === 1 && excluded.length === 0 : results.length === 0;
  return { ...test, passed, rank, resultCount: results.length, excluded, elapsedMs,
    top5: results.slice(0, 5).map(({ item, score }) => ({ type: item.type, id: item.id, title: item.title, score })) };
});
const positive = cases.filter((test) => test.expected.length);
const timings = cases.map((test) => test.elapsedMs).sort((a, b) => a - b);
const summary = {
  total: cases.length,
  passed: cases.filter((test) => test.passed).length,
  top1: positive.filter((test) => test.rank === 1).length / positive.length,
  top5: positive.filter((test) => test.rank !== null && test.rank <= 5).length / positive.length,
  mrr: positive.reduce((sum, test) => sum + (test.rank ? 1 / test.rank : 0), 0) / positive.length,
  noResultCorrect: cases.filter((test) => !test.expected.length && test.passed).length,
  noResultTotal: cases.filter((test) => !test.expected.length).length,
  medianMs: timings[Math.floor(timings.length / 2)],
  p95Ms: timings[Math.ceil(timings.length * 0.95) - 1],
};
const report = { generatedAt: new Date().toISOString(), baseUrl, catalogItems: items.length,
  methodology: suite.description, note: "Latency measures one cold in-process ranking call per query, excluding network and UI. Results are capped at 40 by the production ranker.",
  summary, cases };
const output = Bun.env.SEARCH_REPORT_PATH;
if (output) await Bun.write(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
for (const test of cases.filter((test) => !test.passed)) {
  console.log(`FAIL ${JSON.stringify(test.query)}: rank=${test.rank ?? "missing"}, results=${test.resultCount}, excluded=${test.excluded.join(",") || "none"}; first=${test.top5[0]?.id ?? "none"}`);
}
if (Bun.argv.includes("--check") && summary.passed !== summary.total) process.exitCode = 1;
