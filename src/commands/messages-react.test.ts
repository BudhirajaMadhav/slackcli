// `messages react` end to end in process, with the Slack client stubbed: the
// --json shape and that --json keeps stdout to one object.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as authLib from '../lib/auth.ts';
import { createMessagesCommand } from './messages.ts';

const TS = '1712345678.000100';

function client(addReaction: (channel: string, ts: string, emoji: string) => Promise<unknown>) {
  const calls: Array<[string, string, string]> = [];
  return {
    calls,
    stub: {
      workspaceHost: 'acme.slack.com',
      addReaction: (channel: string, ts: string, emoji: string) => {
        calls.push([channel, ts, emoji]);
        return addReaction(channel, ts, emoji);
      },
    },
  };
}

function refusal(code: string): Error {
  return Object.assign(new Error(`Slack API error: ${code}`), { slackData: { ok: false, error: code } });
}

describe('messages react', () => {
  const realIsTTY = process.stdin.isTTY;
  let stdout: string;
  let stderr: string;
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    savedExitCode = process.exitCode;
    process.exitCode = 0;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    }) as typeof process.stdout.write);
    spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write);
    spyOn(console, 'log').mockImplementation((...args: unknown[]) => { stdout += `${args.join(' ')}\n`; });
    spyOn(console, 'error').mockImplementation((...args: unknown[]) => { stderr += `${args.join(' ')}\n`; });
  });

  afterEach(() => {
    mock.restore();
    Object.defineProperty(process.stdin, 'isTTY', { value: realIsTTY, configurable: true });
    process.exitCode = savedExitCode ?? 0;
  });

  async function run(stub: unknown, argv: string[]) {
    spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(stub as any);
    await createMessagesCommand().parseAsync(['react', ...argv], { from: 'user' });
  }

  it('adds the reaction and prints { channel_id, ts, emoji }', async () => {
    const { stub, calls } = client(async () => ({ ok: true }));

    await run(stub, ['--channel-id', 'C0123456789', '--timestamp', TS, '--emoji', 'eyes', '--json']);

    expect(process.exitCode).toBe(0);
    expect(calls).toEqual([['C0123456789', TS, 'eyes']]);
    expect(JSON.parse(stdout)).toEqual({ channel_id: 'C0123456789', ts: TS, emoji: 'eyes' });
  });

  it('keeps the text output unchanged without --json', async () => {
    const { stub } = client(async () => ({ ok: true }));

    await run(stub, ['--channel-id', 'C0123456789', '--timestamp', TS, '--emoji', 'eyes']);

    expect(process.exitCode).toBe(0);
    expect(stdout + stderr).toContain(`Added :eyes: to message ${TS}`);
  });

  it('keeps the workspace-mismatch warning off stdout under --json', async () => {
    const { stub, calls } = client(async () => ({ ok: true }));

    await run(stub, ['--permalink', 'https://other.slack.com/archives/C0123456789/p1712345678000100', '--emoji', 'eyes', '--json']);

    expect(calls).toEqual([['C0123456789', TS, 'eyes']]);
    expect(stderr).toContain('belongs to the "other" workspace');
    expect(JSON.parse(stdout)).toEqual({ channel_id: 'C0123456789', ts: TS, emoji: 'eyes' });
  });

  it('fails with the Slack code on stderr and nothing on stdout', async () => {
    const { stub } = client(async () => { throw refusal('already_reacted'); });

    await run(stub, ['--channel-id', 'C0123456789', '--timestamp', TS, '--emoji', 'eyes', '--json']);

    expect(process.exitCode).toBe(1);
    expect(stdout).toBe('');
    const lines = stderr.trimEnd().split('\n');
    expect(JSON.parse(lines[lines.length - 1]).error).toMatchObject({ slack_error: 'already_reacted' });
  });
});
