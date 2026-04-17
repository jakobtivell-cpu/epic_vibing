// scripts/run-wrapped.cjs
// Async wrapper — spawns command, writes output to file, returns immediately.
// Usage:
//   node scripts/run-wrapped.cjs "node scripts/test-all-companies.cjs --company Volvo"
//   node scripts/run-wrapped.cjs --poll     (check if done, print output)
//   node scripts/run-wrapped.cjs --wait     (block until done, print output)
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOG = path.join(__dirname, '..', 'output', 'prompt-loop', 'run.log');
const PID_FILE = path.join(__dirname, '..', 'output', 'prompt-loop', 'run.pid');
const DONE_FILE = path.join(__dirname, '..', 'output', 'prompt-loop', 'run.done');

// Ensure directory exists
const dir = path.dirname(LOG);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const args = process.argv.slice(2);

// --poll: check if previous command finished, print output
if (args[0] === '--poll') {
  if (fs.existsSync(DONE_FILE)) {
    const code = fs.readFileSync(DONE_FILE, 'utf8').trim();
    if (fs.existsSync(LOG)) {
      const log = fs.readFileSync(LOG, 'utf8');
      console.log(log.slice(-4000));
    }
    console.log('EXIT_CODE:', code);
    try { fs.unlinkSync(DONE_FILE); } catch {}
    try { fs.unlinkSync(PID_FILE); } catch {}
  } else if (fs.existsSync(PID_FILE)) {
    const pid = fs.readFileSync(PID_FILE, 'utf8').trim();
    let alive = false;
    try { process.kill(Number(pid), 0); alive = true; } catch {}
    if (alive) {
      if (fs.existsSync(LOG)) {
        const log = fs.readFileSync(LOG, 'utf8');
        console.log('STILL RUNNING (last 1000 chars):');
        console.log(log.slice(-1000));
      } else {
        console.log('STILL RUNNING (no output yet)');
      }
    } else {
      console.log('Process ended.');
      if (fs.existsSync(LOG)) console.log(fs.readFileSync(LOG, 'utf8').slice(-4000));
      try { fs.unlinkSync(PID_FILE); } catch {}
    }
  } else {
    console.log('NO RUNNING COMMAND. Ready for next.');
  }
  process.exit(0);
}

// --wait: poll until done file appears, then print
if (args[0] === '--wait') {
  const maxWait = 900000; // 15 min
  const start = Date.now();
  const sleep = (ms) => { try { execSync(`node -e "setTimeout(()=>{},${ms})"`, { stdio: 'ignore' }); } catch {} };
  while (!fs.existsSync(DONE_FILE) && (Date.now() - start) < maxWait) {
    sleep(5000);
  }
  if (fs.existsSync(DONE_FILE)) {
    const code = fs.readFileSync(DONE_FILE, 'utf8').trim();
    if (fs.existsSync(LOG)) console.log(fs.readFileSync(LOG, 'utf8').slice(-4000));
    console.log('EXIT_CODE:', code);
    try { fs.unlinkSync(DONE_FILE); } catch {}
    try { fs.unlinkSync(PID_FILE); } catch {}
  } else {
    console.log('TIMEOUT waiting for command.');
    if (fs.existsSync(LOG)) console.log(fs.readFileSync(LOG, 'utf8').slice(-2000));
  }
  process.exit(0);
}

// Default: launch command in background, return immediately
const cmd = args.join(' ');
if (!cmd) { console.error('Usage: node scripts/run-wrapped.cjs "<command>"'); process.exit(1); }

// Clean previous state
try { fs.unlinkSync(DONE_FILE); } catch {}
try { fs.unlinkSync(PID_FILE); } catch {}

const logStream = fs.openSync(LOG, 'w');

const isWindows = process.platform === 'win32';
const shell = isWindows ? 'cmd' : '/bin/sh';
const shellArgs = isWindows ? ['/c', cmd] : ['-c', cmd];

const child = spawn(shell, shellArgs, {
  stdio: ['ignore', logStream, logStream],
  detached: !isWindows,
});

fs.writeFileSync(PID_FILE, String(child.pid));

child.on('exit', (code) => {
  fs.writeFileSync(DONE_FILE, String(code || 0));
});

if (!isWindows) child.unref();

console.log('LAUNCHED: ' + cmd);
console.log('PID: ' + child.pid);
console.log('Poll: node scripts/run-wrapped.cjs --poll');
console.log('Wait: node scripts/run-wrapped.cjs --wait');

setTimeout(() => process.exit(0), 500);
