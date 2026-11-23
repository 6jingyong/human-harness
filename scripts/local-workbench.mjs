// Keep the web server in the foreground so Ctrl+C closes the local workbench.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
const url = 'http://127.0.0.1:' + port;
const server = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['inherit', 'pipe', 'inherit']
});
let ready = false;
createInterface({ input: server.stdout }).on('line', line => {
  console.log(line);
  if (ready || !/\bready in\b/i.test(line)) return;
  ready = true;
  console.log('Human Harness · ' + url);
  if (process.argv.includes('--no-open')) return;
  const [command, args] = process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const browser = spawn(command, args, { stdio: 'ignore', detached: true });
  browser.on('error', () => console.log('请在浏览器打开 ' + url));
  browser.unref();
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1); });
