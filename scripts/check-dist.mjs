// 构建产物扫描（AC-OPS-03-5、AC-CON-10-1）：不加载任何外部资源，不含管理和运维接口的密钥字符串，没有 source map。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const secrets = [
  'X-Admin-Key',
  'X-IM-Signature',
  'X-IM-Caller',
  'CON_IM_SIGNING_KEY',
  'IM_OPS_PUBKEYS',
  'IM_ADMIN',
  '/internal/v1',
  'tianting-e2e-legacy-key',
  'tianting-e2e-signing-seed',
];
const problems = [];
const external = (text, file) => {
  const patterns = [
    /<script[^>]*\bsrc=["'](?:https?:)?\/\/[^"']+/gi,
    /<link[^>]*\bhref=["'](?:https?:)?\/\/[^"']+/gi,
    /@import\s+(?:url\()?["']?(?:https?:)?\/\/[^"')]+/gi,
    /url\(["']?(?:https?:)?\/\/[^"')]+/gi,
    /\bfetch\(\s*["'`](?:https?:)?\/\/[^"'`]+/g,
    /\bnew\s+WebSocket\(\s*["'`]wss?:[^"'`]+/g,
    /\.open\(\s*["'`][A-Z]+["'`]\s*,\s*["'`](?:https?:)?\/\/[^"'`]+/g,
  ];
  for (const p of patterns)
    for (const m of text.matchAll(p)) problems.push(`${file}: external reference ${m[0].slice(0, 80)}`);
};
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p);
      continue;
    }
    if (name.endsWith('.map')) problems.push(`source map shipped: ${p}`);
    const text = readFileSync(p, 'utf8');
    for (const s of secrets) if (text.includes(s)) problems.push(`${p} contains "${s}"`);
    external(text, p);
  }
};
walk('dist');
const html = readFileSync('dist/index.html', 'utf8');
if (/<script(?![^>]*\bsrc=)[^>]*>/.test(html)) problems.push('index.html has an inline script: CSP would block it');
if (/<style/.test(html)) problems.push('index.html has an inline style: the ops CSP is style-src self');
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('dist: no external resources, no secrets, no source maps, no inline scripts or styles');
