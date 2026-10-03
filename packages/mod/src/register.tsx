import { atom, read, update } from 'claude-code';
import type { EngineInterface, On, RenderChildren } from 'claude-code';
import type { IdleNeedsYou, IdleView } from '../../../plugins/cc-idle/types';
import type { EventEnvelope } from '@ccidle/shared';
import type { GameAction, GameInput, Narration } from './game.js';
import { GameSync } from './sync.js';
import {
  BOARD_MAX_TOKENS,
  BOARD_MODEL,
  BOARD_SYSTEM,
  BOARD_TIMEOUT_MS,
  MAX_INPUT_CHARS,
  appendLine,
  canReact,
  chatPrompt,
  cleanReply,
  clipInput,
  isReactable,
  reactionPrompt,
  type BoardLine
} from './board.js';
import {
  promptSubmitted,
  sessionEnded,
  subagentStopped,
  tokensUsed,
  toolFinished,
  turnStopped,
  type SessionRef
} from './telemetry.js';
import {
  HELP_LINES,
  NARRATION_TONE,
  REGION_STATUS,
  breakthroughRows,
  focusedRegion,
  infraActions,
  labView,
  nextStep,
  rackDiagram,
  regionLines,
  resourceLine,
  statusText,
  type Action,
  type Tone
} from './view.js';

/**
 * cc-idle as a Claude Code mod: the hook shims, the daemon and the tmux pane
 * of the original, folded into one hooks module. Claude Code's own events
 * feed the economy; a pane beside the transcript is the game.
 */

const PANE = 'cc-idle';
const FLUSH_DELAY_MS = 1_000;
const REFRESH_EVERY_MS = 5_000;
const FEED_LINES = 6;
/** Set once the player dismisses the welcome. Kept apart from the save, whose schema is the engine's. */
const ONBOARDED_KEY = 'onboarded';

const rev = atom({ plugin: 'cc-idle', key: 'rev' } as const, 0);
const view = atom({ plugin: 'cc-idle', key: 'view' } as const, 'main' as IdleView);
const regionIndex = atom({ plugin: 'cc-idle', key: 'region' } as const, 0);
const needsYou = atom({ plugin: 'cc-idle', key: 'needsYou' } as const, '' as IdleNeedsYou);
const boardRev = atom({ plugin: 'cc-idle', key: 'board' } as const, 0);

type Api = EngineInterface;

// Module state: rebuilt from $.store by session.start after every (re)load.
let sync: GameSync | null = null;
let ref: SessionRef | null = null;
let flushTimer: { cancel: () => void } | null = null;
let paneFocused = false;
let onboarded = false;
// The board chat is this session's alone: never in $.store, which every session shares.
let boardLines: BoardLine[] = [];
let boardDraft = '';
let boardStop: AbortController | null = null;
let lastReactMs: number | null = null;

const BOARD_UNAVAILABLE: BoardLine = {
  who: 'system',
  text: 'The board is unavailable right now.'
};

const NEEDS_YOU_TEXT: Record<Exclude<IdleNeedsYou, ''>, string> = {
  done: 'Claude finished — your turn',
  permission: 'Claude needs your permission',
  question: 'Claude is asking you a question'
};

const TONE_COLOR: Record<Tone, string | undefined> = {
  good: 'green',
  bad: 'red',
  warn: 'yellow',
  info: undefined,
  accent: 'magenta',
  dim: undefined
};

async function resolveRef($: Api): Promise<SessionRef> {
  const [sessionId, cwd] = await Promise.all([$.session.id(), $.session.cwd()]);
  return { sessionId, cwd };
}

/** Feed one input to the economy; the pane redraws now and the store catches up shortly. */
async function record($: Api, input: GameInput): Promise<void> {
  if (!sync) return;
  const effects = sync.push(input);
  await update($, rev, () => sync?.version ?? 0);
  $.ui.status(statusText(sync.state));
  if (paneFocused) {
    for (const effect of effects) {
      if (effect.kind === 'ceremony' || effect.kind === 'bad') $.ui.toast(effect.text);
    }
  }
  const big = effects.find(isReactable);
  if (big) void react($, big);
  scheduleFlush($);
}

async function bumpBoard($: Api): Promise<void> {
  await update($, boardRev, (n) => n + 1);
}

/** One Haiku call in character; a newer call or leaving the chat cuts the older one. */
async function askBoard($: Api, prompt: string): Promise<void> {
  boardStop?.abort();
  const stop = new AbortController();
  boardStop = stop;
  await bumpBoard($);
  let line: BoardLine | null = BOARD_UNAVAILABLE;
  try {
    const result = await $.model.complete(
      {
        model: BOARD_MODEL,
        system: BOARD_SYSTEM,
        prompt,
        maxTokens: BOARD_MAX_TOKENS,
        effort: 'low',
        timeoutMs: BOARD_TIMEOUT_MS
      },
      { signal: stop.signal }
    );
    if (result.isAnswered) {
      const text = cleanReply(result.text);
      if (text) line = { who: 'board', text };
    } else if (result.reason === 'aborted' && stop.signal.aborted) {
      line = null; // we cut it; a timeout still says the board is unavailable
    }
  } catch {
    // Only a request the engine refuses to send rejects (a blocked model).
  }
  if (boardStop === stop) boardStop = null;
  if (line && !stop.signal.aborted) boardLines = appendLine(boardLines, line);
  await bumpBoard($);
}

function stopBoard(): void {
  boardStop?.abort();
  boardStop = null;
}

/** The board reacts to a big moment: only with the pane in view, nothing in flight, once a minute. */
async function react($: Api, effect: Narration): Promise<void> {
  if (!sync || boardStop) return;
  const panes = await $.ui.panes();
  if (!panes.some((pane) => pane.id === PANE && pane.isShown && pane.isPlaced)) return;
  const nowMs = await $.clock.now();
  if (boardStop || !canReact(nowMs, lastReactMs)) return;
  lastReactMs = nowMs;
  await askBoard($, reactionPrompt(sync.state, effect));
}

function telemetry($: Api, make: (ref: SessionRef, nowMs: number) => EventEnvelope): Promise<void> {
  if (!ref) return Promise.resolve();
  return record($, { kind: 'telemetry', envelope: make(ref, Date.now()) });
}

function act($: Api, action: GameAction): Promise<void> {
  return record($, { kind: 'action', action }).then(() => flushNow($));
}

function scheduleFlush($: Api): void {
  if (flushTimer) return;
  flushTimer = $.clock.after(FLUSH_DELAY_MS, () => {
    flushTimer = null;
    void flushNow($);
  });
}

async function flushNow($: Api): Promise<void> {
  flushTimer?.cancel();
  flushTimer = null;
  if (!sync) return;
  await sync.flush();
  await update($, rev, () => sync?.version ?? 0);
}

async function setNeedsYou($: Api, reason: IdleNeedsYou): Promise<void> {
  await update($, needsYou, () => reason);
}

export function register(on: On): void {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'idle',
      description: 'Play cc-idle: open the game pane and take the keyboard (Esc hands it back)',
      argumentHint: '[close]',
      immediate: true
    });
    ref = await resolveRef($);
    const store = {
      get: (key: string) => $.store.get(key),
      set: (key: string, value: unknown) => $.store.set(key, value)
    };
    sync = new GameSync(store, ref.sessionId, () => Date.now());
    await sync.refresh();
    await update($, rev, () => sync?.version ?? 0);
    $.ui.status(statusText(sync.state));
    // Other sessions write the shared economy too: pick their work up.
    $.clock.every(REFRESH_EVERY_MS, () => {
      void sync?.refresh().then(async (changed) => {
        if (!changed || !sync) return;
        await update($, rev, () => sync?.version ?? 0);
        $.ui.status(statusText(sync.state));
      });
    });
    // A new player meets the welcome screen first.
    onboarded = (await $.store.get(ONBOARDED_KEY)) === true;
    if (!onboarded) await update($, view, () => 'help' as IdleView);
    // Unasked, the pane only seats in a wide terminal; /idle opens it anywhere.
    void $.ui.open({ id: PANE, title: 'cc-idle' }).then((opened) => {
      if (!opened.isPlaced && !onboarded) $.ui.toast('cc-idle is installed: type /idle to play');
    });
    return next(e);
  });

  on('command.run', { command: 'idle' }, async ($, e) => {
    if (e.args.trim() === 'close') {
      await $.ui.close({ id: PANE });
      return {};
    }
    await $.ui.open({ id: PANE, title: 'cc-idle', focus: true });
    return {};
  });

  // ---- telemetry: the only thing that moves the economy ----

  on('turn.start', async ($, e, next) => {
    ref = await resolveRef($); // a /clear starts a new session id
    await setNeedsYou($, '');
    await telemetry($, promptSubmitted);
    return next(e);
  });

  // Every model request, main loop and subagents alike: output tokens → Compute, live.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e);
    if (result.usage) {
      const usage = result.usage;
      await telemetry($, (r, nowMs) => tokensUsed(r, nowMs, usage));
    }
    return result;
  });

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool);
    const isMain = e.agentId === undefined;
    if (isMain && tool === 'AskUserQuestion') await setNeedsYou($, 'question');
    const result = await next(e);
    // A denied call never ran: like a blocked PreToolUse, it is not work.
    if (result.deny === undefined) {
      await telemetry($, (r, nowMs) => toolFinished(r, nowMs, tool, result.isError === true));
    }
    // The prompt or question this call raised has been answered.
    const waiting = await read($, needsYou);
    if (waiting === 'permission' || (isMain && waiting === 'question')) await setNeedsYou($, '');
    return result;
  });

  on('tool.check', async ($, e, next) => {
    const decision = await next(e);
    // A prompt waits on the person whichever loop asked (subagents included).
    if (decision.decision === 'ask') await setNeedsYou($, 'permission');
    return decision;
  });

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const durationMs = e.durationMs;
      await telemetry($, (r, nowMs) => subagentStopped(r, nowMs, durationMs));
    } else {
      if (e.reason === 'answer') {
        await telemetry($, turnStopped);
      } else if (ref && sync) {
        await record($, { kind: 'session-state', sessionId: ref.sessionId, state: 'HUMAN_ACTIVE' });
      }
      await setNeedsYou($, 'done');
      if (paneFocused) $.ui.toast(NEEDS_YOU_TEXT.done + ' (Esc)');
      await flushNow($);
    }
    return next(e);
  });

  on('session.end', async ($, e, next) => {
    await telemetry($, sessionEnded);
    await flushNow($);
    return next(e);
  });

  // ---- the game pane ----

  on('ui.render', { component: 'Pane', requestId: 'cc-idle' }, async ($, e) => {
    const elements = $.ui.resolve(e);
    const { Box, Text, Button } = elements;
    // The mobile app draws no text field yet.
    const Input = 'Input' in elements ? elements.Input : null;
    await read($, rev); // subscribe: every economy change redraws
    await read($, boardRev); // and every board line
    const screen = await read($, view);
    const waiting = await read($, needsYou);
    const selected = await read($, regionIndex);
    paneFocused = e.props.isFocused === true;
    const width = Math.max(24, e.props.bodyColumns ?? 48);

    if (!sync) return <Text dimColor>cc-idle is loading…</Text>;
    const game = sync.state;

    const actionButton = (action: Action, onPress: () => Promise<void>) => (
      <Button
        key={`act-${action.hotkey}`}
        label={action.label}
        hotkey={action.hotkey}
        plain
        dimColor={!action.isReady}
        onPress={onPress}
      />
    );
    const setView = (next: IdleView) => () => update($, view, () => next);

    const banner = waiting !== '' && (
      <Text key="needs-you" color="yellow" bold wrap="truncate">
        ▶ {NEEDS_YOU_TEXT[waiting]}
        {paneFocused ? ' — Esc to answer' : ''}
      </Text>
    );
    const header = (
      <Text key="resources" wrap="wrap">
        <Text bold>GEN-{game.generation}</Text> <Text color="cyan">{resourceLine(game)}</Text>
      </Text>
    );

    let body: RenderChildren[];
    if (screen === 'help') {
      body = [
        <Text key="help-title" bold color="magenta">
          {onboarded ? 'HOW TO PLAY' : 'WELCOME TO CC-IDLE'}
        </Text>,
        ...HELP_LINES.map((line, i) => (
          <Text
            key={`help-${i}`}
            color={TONE_COLOR[line.tone]}
            dimColor={line.tone === 'dim'}
            wrap="wrap"
          >
            {line.text}
          </Text>
        )),
        <Button
          key="help-done"
          label={onboarded ? 'back' : 'got it, start playing'}
          hotkey="i"
          plain
          onPress={async () => {
            if (!onboarded) {
              onboarded = true;
              await $.store.set(ONBOARDED_KEY, true);
            }
            await update($, view, () => 'main' as IdleView);
          }}
        />,
        !paneFocused && (
          <Text key="help-focus" dimColor wrap="wrap">
            Type /idle to give the pane the keyboard.
          </Text>
        )
      ];
    } else if (screen === 'tree') {
      body = [
        <Text key="tree-title" bold color="magenta">
          BREAKTHROUGHS
        </Text>,
        ...breakthroughRows(game).map((row) => (
          <Box key={`node-${row.nodeId}`} flexDirection="column">
            {actionButton(row, () => act($, { type: 'buy-breakthrough', nodeId: row.nodeId }))}
            <Text dimColor wrap="truncate">
              {'   '}
              {row.detail}
            </Text>
          </Box>
        )),
        <Button key="tree-back" label="back" hotkey="v" plain onPress={setView('main')} />
      ];
    } else if (screen === 'chat') {
      const game = sync.state;
      const leaveBoard = async () => {
        stopBoard();
        await update($, view, () => 'main' as IdleView);
      };
      body = [
        <Text key="board-title" bold color="magenta">
          THE BOARD
        </Text>,
        ...(boardLines.length === 0
          ? [
              <Text key="board-empty" dimColor wrap="wrap">
                A board member is listening. Keep it short.
              </Text>
            ]
          : boardLines.map((line, i) => (
              <Text
                key={`board-${i}`}
                color={line.who === 'board' ? 'magenta' : undefined}
                dimColor={line.who === 'system'}
                wrap="wrap"
              >
                {line.who === 'you' ? '› ' : line.who === 'board' ? '☞ ' : ''}
                {line.text}
              </Text>
            ))),
        boardStop && (
          <Text key="board-thinking" dimColor>
            the board is thinking…
          </Text>
        ),
        Input ? (
          <Input
            key="board-input"
            placeholder={`say something (max ${MAX_INPUT_CHARS} chars)`}
            submitLabel="send"
            value={boardDraft}
            autoFocus
            onInput={(value: string) => {
              boardDraft = value;
            }}
            onSubmit={(value: string) => {
              const line = clipInput(value);
              boardDraft = '';
              // The field holds every key, so an empty Enter is the way back.
              if (!line) return void leaveBoard();
              boardLines = appendLine(boardLines, { who: 'you', text: line });
              void askBoard($, chatPrompt(game, line));
            }}
          />
        ) : (
          <Text key="board-input" dimColor wrap="wrap">
            Chat needs the terminal or desktop app.
          </Text>
        ),
        <Text key="board-keys" dimColor wrap="wrap">
          Enter on an empty line goes back to the game.
        </Text>,
        <Button key="board-back" label="back" hotkey="c" plain onPress={leaveBoard} />
      ];
    } else if (screen === 'confirm-ship') {
      body = [
        <Text key="ship-warn" color="magenta" bold wrap="wrap">
          Ship Gen-{game.generation}? Infrastructure and lab staff reset; Reputation and Breakthroughs stay.
        </Text>,
        <Box key="ship-choices" flexDirection="row" columnGap={3}>
          <Button
            key="ship-yes"
            label="yes, ship it"
            hotkey="y"
            plain
            onPress={async () => {
              await update($, view, () => 'main' as IdleView);
              await act($, { type: 'ship-generation' });
            }}
          />
          <Button key="ship-no" label="cancel" hotkey="n" plain onPress={setView('main')} />
        </Box>
      ];
    } else {
      const focus = focusedRegion(game, selected);
      const lab = labView(game, Math.min(24, Math.max(8, width - 24)));
      const regionBlock = focus ? (
        <Box key="region" flexDirection="column">
          <Text wrap="truncate">
            <Text bold color="cyan">
              {focus.region.name}
            </Text>{' '}
            <Text dimColor>
              {focus.position}/{focus.count}
            </Text>{' '}
            <Text color={TONE_COLOR[REGION_STATUS[focus.region.status].tone]}>
              {REGION_STATUS[focus.region.status].text}
            </Text>
          </Text>
          {regionLines(focus.region).map((line, i) => (
            <Text key={`region-line-${i}`} dimColor={i > 0} wrap="truncate">
              {line}
            </Text>
          ))}
          <Text wrap="truncate">{rackDiagram(focus.region, width)}</Text>
          {focus.region.incidents.map((incident) => (
            <Text key={incident.id} color="red" wrap="truncate">
              ↯ {incident.title}
            </Text>
          ))}
          <Box flexDirection="row" columnGap={2} flexWrap="wrap">
            {infraActions(game, focus.region).map((action) =>
              actionButton(action, () =>
                act($, { type: 'buy', regionId: focus.region.id, tierId: action.tierId })
              )
            )}
            {focus.region.incidents.length > 0 &&
              actionButton({ hotkey: 'a', label: 'acknowledge', isReady: true }, () =>
                act($, { type: 'ack-incident', regionId: focus.region.id })
              )}
            {focus.count > 1 && (
              <Button
                key="next-region"
                label="next region"
                hotkey="n"
                plain
                onPress={() => update($, regionIndex, (i) => i + 1)}
              />
            )}
          </Box>
        </Box>
      ) : (
        <Text key="region" dimColor wrap="wrap">
          No region yet.
        </Text>
      );
      body = [
        regionBlock,
        <Box key="lab" flexDirection="column" marginTop={1}>
          <Text wrap="truncate">
            <Text bold>FRONTIER LAB</Text> <Text dimColor>{lab.researchers}</Text>
          </Text>
          <Text wrap="truncate">
            <Text color={lab.isShippable ? 'green' : 'cyan'}>{lab.progressBar}</Text> {lab.progress}
          </Text>
          <Box flexDirection="row" columnGap={2} flexWrap="wrap">
            {lab.actions.map((action) =>
              actionButton(action, async () => {
                if (action.hotkey === 'h') return act($, { type: 'hire' });
                if (action.hotkey === 'e') return act($, { type: 'experiment' });
                if (lab.isShippable) await update($, view, () => 'confirm-ship' as IdleView);
                else await act($, { type: 'ship-generation' }); // the engine narrates what's missing
              })
            )}
            <Button key="open-tree" label="breakthroughs" hotkey="v" plain onPress={setView('tree')} />
            <Button key="open-board" label="board" hotkey="c" plain onPress={setView('chat')} />
            <Button key="open-help" label="how to play" hotkey="i" plain onPress={setView('help')} />
          </Box>
        </Box>
      ];
      const said = boardLines.findLast((line) => line.who === 'board');
      if (said) {
        body.unshift(
          <Text key="board-said" color="magenta" dimColor wrap="truncate">
            ☞ board: {said.text}
          </Text>
        );
      }
      const hint = nextStep(game, focus?.region ?? null);
      if (hint) {
        body.unshift(
          <Text key="hint" color="yellow" wrap="wrap">
            → {hint}
          </Text>
        );
      }
    }

    const feed = game.log.slice(-FEED_LINES).map((entry, i) => (
      <Text
        key={`feed-${i}`}
        color={TONE_COLOR[NARRATION_TONE[entry.kind]]}
        dimColor={NARRATION_TONE[entry.kind] === 'dim'}
        wrap="wrap"
      >
        {entry.text}
      </Text>
    ));

    return (
      <Box flexDirection="column">
        {banner}
        {header}
        <Box flexDirection="column" marginTop={1}>
          {body}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {feed.length > 0 ? feed : <Text dimColor>The economy moves only while Claude works.</Text>}
        </Box>
      </Box>
    );
  });
}
