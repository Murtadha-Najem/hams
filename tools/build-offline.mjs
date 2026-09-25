// Builds hams-offline.html: the whole app in one file (code, styles, fonts, icon), for machines
// that never had internet. Run after changing any app file:  npm run build
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url);
const read = (f) => readFileSync(new URL(f, root), 'utf8').replace(/\r\n/g, '\n');
const b64 = (f) => readFileSync(new URL(f, root)).toString('base64');

// modules in dependency order; imports go, and exports become plain declarations
const MODULES = ['modem.js', 'codec.js', 'protocol.js', 'app.js'];
const bundle = MODULES.map((f) => `// ---- ${f}\n` + read(f)
  .replace(/^import [^;]+;\r?\n/gm, '')
  .replace(/^export (?=(async )?function|const|let|class)/gm, '')).join('\n');
if (bundle.includes('</script')) throw new Error('a module contains </script');

// the bundle must parse on its own before it goes into the page
const check = join(tmpdir(), 'hams-bundle-check.mjs');
writeFileSync(check, bundle);
execFileSync(process.execPath, ['--check', check]);

const fonts = read('fonts/fonts.css').replace(/url\(([\w.-]+\.woff2)\)/g, (_, f) => `url(data:font/woff2;base64,${b64('fonts/' + f)})`);
const icon = `data:image/svg+xml;base64,${b64('icon.svg')}`;

let html = read('index.html');
const swap = (pattern, replacement) => {
  if (!pattern.test(html)) throw new Error(`index.html no longer matches ${pattern}`);
  html = html.replace(pattern, replacement);
};
swap(/<link rel="manifest"[^>]*>\n/, '');
swap(/<link rel="apple-touch-icon"[^>]*>\n/, '');
swap(/<link rel="icon" href="icon.svg"[^>]*>/, `<link rel="icon" href="${icon}" type="image/svg+xml">`);
swap(/<link rel="stylesheet" href="fonts\/fonts.css[^"]*">/, `<style>\n${fonts}</style>`);
swap(/<script type="module" src="app.js[^"]*"><\/script>/, () => `<script type="module">\n${bundle}\n</script>`);
html = html.replace('<!doctype html>', `<!doctype html>\n<!-- Hams, one-file copy, built ${new Date().toISOString().slice(0, 10)}. https://github.com/Murtadha-Najem/hams -->`);

writeFileSync(new URL('hams-offline.html', root), html);
console.log(`hams-offline.html: ${(html.length / 1024).toFixed(0)} KB`);
