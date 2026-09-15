// Evaluates a JavaScript expression in a page of a Chrome started with remote
// debugging, and prints the result. This is how a real frame rate is read on
// this machine: the in-app browser pane starves requestAnimationFrame (see
// CLAUDE.md, 验证改动), so measurements run in a separate Chrome instance —
//
//   open -na "Google Chrome" --args --remote-debugging-port=9222 \
//     --user-data-dir=/tmp/three-particles-chrome --no-first-run \
//     --start-maximized "http://localhost:8080/?gputime"
//   node scripts/cdp-eval.mjs localhost:8080 <file-with-expression> [timeoutMs]
//
// The expression may be an async IIFE; its promise is awaited and a string
// result is printed as is (JSON.stringify the rest). To run the harness there:
//   await fetch('/__ai-test.js').then((r) => r.text()).then(eval); await __t.perfReport()
import { readFileSync } from 'node:fs';

const [, , match = 'localhost:8080', exprFile, timeoutArg] = process.argv;
const timeoutMs = Number(timeoutArg || 60000);
const expression = readFileSync(exprFile, 'utf8');

const targets = await fetch('http://127.0.0.1:9222/json').then((r) => r.json());
const page = targets.find((t) => t.type === 'page' && t.url.includes(match));
if (!page) {
  console.error('no page matching', match, 'among', targets.map((t) => t.url));
  process.exit(2);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const timer = setTimeout(() => { console.error('timeout'); process.exit(3); }, timeoutMs);
const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
clearTimeout(timer);
if (r.result?.exceptionDetails) console.error('EXCEPTION', JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails));
const value = r.result?.result?.value;
console.log(typeof value === 'string' ? value : JSON.stringify(value ?? r).slice(0, 4000));
ws.close();
