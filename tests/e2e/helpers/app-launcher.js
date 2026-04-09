import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_PATH = resolve(__dirname, '../../../src-tauri/target/debug/markdown-desk');

const processes = new Map();

export async function startApp(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(APP_PATH, [], {
      env: { ...process.env, TAURI_WEBDRIVER_PORT: String(port) },
      stdio: 'pipe',
    });

    processes.set(port, child);

    child.on('error', (err) => {
      reject(new Error(`Failed to start app: ${err.message}`));
    });

    child.on('exit', (code) => {
      if (code !== null && code !== 0) {
        clearInterval(poll);
        reject(new Error(`App exited with code ${code}`));
      }
    });

    // Poll until WebDriver server is ready
    const maxWait = 30000;
    const interval = 500;
    let waited = 0;

    const poll = setInterval(async () => {
      waited += interval;
      if (waited > maxWait) {
        clearInterval(poll);
        reject(new Error('App did not start within 30s'));
        return;
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/status`);
        if (res.ok) {
          clearInterval(poll);
          // Give the WebView a moment to load
          setTimeout(() => resolve(), 2000);
        }
      } catch {
        // Not ready yet
      }
    }, interval);
  });
}

export function stopApp(port) {
  const child = processes.get(port);
  if (child) {
    child.kill('SIGTERM');
    processes.delete(port);
  }
}
