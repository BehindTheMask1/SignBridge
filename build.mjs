/* build.mjs — turns index.src.html + engine.js + ai-core.js + learn.js into ONE self-contained dist/index.html.
   Netlify drag-and-drop then only needs that single file: no module paths to 404, no nested folders. */
import fs from "node:fs";
import path from "node:path";
const root = path.dirname(new URL(import.meta.url).pathname);
const read = f => fs.readFileSync(path.join(root, f), "utf8");

let html = read("index.src.html");
const modules = ["engine.js", "lexicon.js", "ai-core.js", "learn.js", "hands.js"];
let inlined = "";
for (const m of modules) {
  let code = read(m)
    .replace(/^import .*?;\s*$/gm, "")        // cross-module imports are satisfied by concatenation
    .replace(/^export\s+(?=(function|const|class|let)\b)/gm, "")
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, "");
  if (/^\s*(import|export)\b/m.test(code)) throw new Error(`${m}: unhandled import/export left after inlining`);
  inlined += `\n/* ===== ${m} ===== */\n${code}\n`;
}
let count = 0;
html = html.replace(/^import \{[^}]*\} from "\.\/(engine|ai-core|learn|hands|lexicon)\.js";\s*$/gm, () => { count++; return ""; });
if (count !== 5) throw new Error(`expected 5 local imports in index.src.html, found ${count}`);
// inlined modules go at the very top of the app script
const tag = '<script type="module">\n';
if (html.split(tag).length !== 2) throw new Error("expected exactly one module script tag");
html = html.replace(tag, () => tag + inlined + "\n");

fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist/index.html"), html);
fs.writeFileSync(path.join(root, "dist/_headers"), "/*\n  Permissions-Policy: camera=(self), microphone=(self)\n  Cache-Control: public, max-age=0, must-revalidate\n");
console.log("built dist/index.html", (html.length / 1024).toFixed(1) + " KB", "· lines:", html.split("\n").length);
