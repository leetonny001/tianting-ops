// 从协议的 errors.json 生成关闭码含义（F-OPS-09 规则 2：取自 ERRORS.md，不手抄）。
// 用法：node scripts/gen-close-codes.mjs [errors.json]。生成的文件要提交。CI 用 --check 确认没过期（有协议文件时）。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const check = process.argv.includes('--check');
const src = process.argv.find((a) => a.endsWith('.json')) ?? '../im-mvp/protocol/errors.json';
const out = 'src/lib/closeCodes.ts';
if (!existsSync(src)) {
  console.log(`close codes: ${src} is not available, skipped`);
  process.exit(0);
}
const d = JSON.parse(readFileSync(src, 'utf8'));
const msg = new Map(d.errors.map((e) => [e.code, e.message]));
const rows = d.closeCodes.map((c) => {
  const same = /^同错误码 (\d+)/.exec(c.meaning);
  return [c.code, same ? (msg.get(Number(same[1])) ?? c.meaning) : c.meaning];
});
const text =
  '// 由 scripts/gen-close-codes.mjs 从 protocol/errors.json 生成，不要手改。\n' +
  'export const closeCodeMeaning: Record<number, string> = {\n' +
  rows.map(([c, m]) => `  ${c}: ${JSON.stringify(m)},`).join('\n') +
  '\n};\n';
if (check) {
  if (!existsSync(out) || readFileSync(out, 'utf8') !== text) {
    console.error(`${out} is stale: run node scripts/gen-close-codes.mjs`);
    process.exit(1);
  }
  console.log('close codes: up to date');
} else {
  writeFileSync(out, text);
}
