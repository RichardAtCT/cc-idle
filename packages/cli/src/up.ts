import { loadConfig } from '@ccidle/shared';
import { ensureDaemonRunning, waitForSocket } from './daemon-control.js';
import { sendRegister } from './register.js';
import { createTmuxRunner, type TmuxRunner } from './tmux.js';
import { moduleDir, tuiBinPath } from './repo-paths.js';

export interface UpOptions {
  noClaude?: boolean;
  env?: NodeJS.ProcessEnv;
  tmuxRunner?: TmuxRunner;
}

/**
 * `ccidle up` (PRD §3.5): ensure the daemon is running, then lay out (or
 * launch) the CC pane + game pane depending on the tmux situation.
 */
export async function runUp(opts: UpOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  const config = loadConfig(undefined, env);
  const tmux = opts.tmuxRunner ?? createTmuxRunner();

  const daemon = ensureDaemonRunning(env);
  console.log(`ccidle: ${daemon.detail}`);
  if (!daemon.ok) {
    console.log('ccidle: continuing without a daemon — auto-focus, registration, and the TUI feed will be unavailable.');
  } else if (daemon.started) {
    const ready = await waitForSocket(env);
    if (!ready) {
      console.log('ccidle: daemon socket did not appear in time — registration below may fail.');
    }
  }

  const tuiBin = tuiBinPath(moduleDir(import.meta.url));
  const claudeCmd = 'claude';
  const tuiCmd = `node ${JSON.stringify(tuiBin)}`;

  if (tmux.insideTmux(env) && config.tmux.autoLayout) {
    const available = await tmux.isAvailable();
    if (!available) {
      console.log('ccidle: $TMUX is set but the tmux binary is unavailable — skipping layout.');
      return;
    }
    const session = (await tmux.currentSessionName()) ?? undefined;
    if (!session) {
      console.log('ccidle: could not resolve the current tmux session name — skipping layout.');
      return;
    }
    const ccPane = await tmux.newWindow({ target: session, name: 'ccidle' });
    const gamePane = await tmux.splitWindow({ target: ccPane, horizontal: true });

    if (!opts.noClaude) {
      await tmux.sendKeys({ target: ccPane, keys: claudeCmd });
    }
    await tmux.sendKeys({ target: gamePane, keys: tuiCmd });

    const gameReg = await sendRegister({ role: 'game', pane: gamePane, env });
    console.log(`ccidle: register game pane ${gamePane} — ${gameReg.detail}`);
    const ccReg = await sendRegister({ role: 'cc', pane: ccPane, cwd: env.PWD, env });
    console.log(`ccidle: register cc pane ${ccPane} — ${ccReg.detail}`);
    console.log('ccidle: layout ready in the "ccidle" window.');
    return;
  }

  const available = await tmux.isAvailable();
  if (available) {
    const hasSession = await tmux.hasSession('ccidle');
    let ccPane: string;
    if (!hasSession) {
      ccPane = await tmux.newSessionDetached({ name: 'ccidle', windowName: 'ccidle' });
      const gamePane = await tmux.splitWindow({ target: ccPane, horizontal: true });
      if (!opts.noClaude) {
        await tmux.sendKeys({ target: ccPane, keys: claudeCmd });
      }
      await tmux.sendKeys({ target: gamePane, keys: tuiCmd });

      const gameReg = await sendRegister({ role: 'game', pane: gamePane, env });
      console.log(`ccidle: register game pane ${gamePane} — ${gameReg.detail}`);
      const ccReg = await sendRegister({ role: 'cc', pane: ccPane, cwd: env.PWD, env });
      console.log(`ccidle: register cc pane ${ccPane} — ${ccReg.detail}`);
    } else {
      console.log('ccidle: tmux session "ccidle" already exists — attaching.');
    }
    console.log('ccidle: attaching to tmux session "ccidle" (ctrl-b d to detach).');
    await tmux.attach({ name: 'ccidle' });
    return;
  }

  console.log('ccidle: no tmux found — running in banner+bell-only mode (PRD G5, no auto-focus).');
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolve) => {
    const child = spawn(process.execPath, [tuiBin], { stdio: 'inherit', env });
    child.on('exit', () => resolve());
    child.on('error', (err) => {
      console.log(`ccidle: could not start the TUI (${err.message}); is @ccidle/tui built?`);
      resolve();
    });
  });
}
