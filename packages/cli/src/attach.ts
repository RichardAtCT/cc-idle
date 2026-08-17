import { sendRegister } from './register.js';
import { createTmuxRunner, type TmuxRunner } from './tmux.js';

export interface AttachOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  tmuxRunner?: TmuxRunner;
}

/**
 * `ccidle attach [--cwd <dir>]` (PRD §3.5): add another CC instance to an
 * already-running setup — new window in the "ccidle" session (or the
 * current session if we're already inside tmux), launch `claude` there,
 * register it with the daemon as role=cc. There is exactly one game pane
 * regardless of how many `attach` calls happen.
 */
export async function runAttach(opts: AttachOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  const tmux = opts.tmuxRunner ?? createTmuxRunner();

  const available = await tmux.isAvailable();
  if (!available) {
    console.log('ccidle: tmux not found — cannot attach a new CC pane without tmux (PRD G5).');
    return;
  }

  let target: string;
  if (tmux.insideTmux(env)) {
    target = (await tmux.currentSessionName()) ?? 'ccidle';
  } else {
    const hasSession = await tmux.hasSession('ccidle');
    if (!hasSession) {
      console.log('ccidle: no running "ccidle" session found — run `ccidle up` first.');
      return;
    }
    target = 'ccidle';
  }

  const pane = await tmux.newWindow({ target, name: 'cc' });
  const claudeCmd = opts.cwd ? `cd ${JSON.stringify(opts.cwd)} && claude` : 'claude';
  await tmux.sendKeys({ target: pane, keys: claudeCmd });

  const reg = await sendRegister({ role: 'cc', pane, cwd: opts.cwd, env });
  console.log(`ccidle: opened new CC pane ${pane} in "${target}" — ${reg.detail}`);
}
