// `messages unreact` end to end in process, with the Slack client stubbed: the
// --json shape and the idempotent no_reaction path that lets a cleanup job
// retry safely.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as authLib from '../lib/auth.ts';
import { createMessagesCommand } from './messages.ts';

const TS = '1712345678.000100';

function client(removeReaction: (channel: string, ts: string, emoji: string) => Promise<unknown>) {
  const calls: Array<[string, string, string]> = [];
  return {
    calls,
    stub: {
      workspaceHost: 'acme.slack.com',
      removeReaction: (channel: string, ts: string, emoji: string) => {
        calls.push([channel, ts, emoji]);
        return removeReaction(channel, ts, emoji);
      },
    },
  };
}

function refusal(code: string): Error {
  return Object.assign(new Error(`Slack API error: ${code}`), { slackData: { ok: false, error: code } });
}

describe('messages unreact', () => {
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
    await createMessagesCommand().parseAsync(['unreact', ...argv], { from: 'user' });
  }

  it('removes the reaction and prints { channel_id, ts, emoji, removed: true, already_removed: false }', async () => {
    const { stub, calls } = client(async () => ({ ok: true }));

    await run(stub, ['--channel-id', 'C0123456789', '--timestamp', TS, '--emoji', 'eyes', '--json']);

    expect(process.exitCode).toBe(0);
    expect(calls).toEqual([['C0123456789', TS, 'eyes']]);
    expect(JSON.parse(stdout)).toEqual({
      channel_id: 'C0123456789', ts: TS, emoji: 'eyes', removed: true, already_removed: false,
    });
  });

  it('takes the channel and timestamp from --permalink', async () => {
    const { stub, calls } = client(async () => ({ ok: true }));

    await run(stub, ['--permalink', 'https://acme.slack.com/archives/C0123456789/p1712345678000100', '--emoji', 'eyes', '--json']);

    expect(calls).toEqual([['C0123456789', TS, 'eyes']]);
    expect(JSON.parse(stdout).ts).toBe(TS);
  });

  it('says it removed the reaction in text mode', async () => {
    const { stub } = client(async () => ({ ok: true }));

    await run(stub, ['--channel-id', 'C0123456789', '--timestamp', TS, '--emoji', 'eyes']);

    expect(process.exitCode).toBe(0);
    expect(stdout + stderr).toContain(`Removed :eyes: from message ${TS}`);
  });

  it('reports a reaction that is already gone as success, exit 0', async () => {
    const { stub } = client(async () => { throw refusal('no_reaction'); });

    await run(stub, ['--channel-id', 'C0123456789', '--timestamp', TS, '--emoji', 'eyes', '--json']);

    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      channel_id: 'C0123456789', ts: TS, emoji: 'eyes', removed: false, already_removed: true,
    });
    expect(stderr).not.toContain('"error"');
  });

  it('says there was no reaction from you in text mode, never that it removed one', async () => {
    const { stub } = client(async () => { throw refusal('no_reaction'); });

    await run(stub, ['--channel-id', 'C0123456789', '--timestamp', TS, '--emoji', 'eyes']);

    expect(process.exitCode).toBe(0);
    expect(stdout + stderr).toContain('No :eyes: reaction from you');
    expect(stdout + stderr).toContain('nothing removed');
    expect(stdout + stderr).not.toContain('Removed');
    expect(stdout + stderr).not.toContain('removed successfully');
  });

  it('keeps the workspace-mismatch warning and the spinner off stdout under --json', async () => {
    const { stub, calls } = client(async () => ({ ok: true }));

    await run(stub, ['--permalink', 'https://other.slack.com/archives/C0123456789/p1712345678000100', '--emoji', 'eyes', '--json']);

    expect(calls).toEqual([['C0123456789', TS, 'eyes']]);
    expect(stderr).toContain('belongs to the "other" workspace');
    expect(stdout).not.toContain('workspace');
    // All of stdout is the one JSON object.
    expect(JSON.parse(stdout)).toMatchObject({ channel_id: 'C0123456789', removed: true });
  });

  it.each([
    ['message_not_found', 'not_found'],
    ['channel_not_found', 'not_found'],
    ['invalid_name', 'invalid_input'],
    ['not_in_channel', 'permission_denied'],
  ])('fails %s with exit 1 and the Slack code', async (slackError, code) => {
    const { stub } = client(async () => { throw refusal(slackError); });

    await run(stub, ['--channel-id', 'C0123456789', '--timestamp', TS, '--emoji', 'eyes', '--json']);

    expect(process.exitCode).toBe(1);
    expect(stdout).toBe('');
    const lines = stderr.trimEnd().split('\n');
    expect(JSON.parse(lines[lines.length - 1]).error).toMatchObject({ code, slack_error: slackError });
  });
});
