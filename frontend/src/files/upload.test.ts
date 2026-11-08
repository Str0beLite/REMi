import { describe, expect, it } from 'vitest';
import { chunksOf, safeName, uploadFile } from './upload';

describe('safeName', () => {
  it("keeps send_file's characters and replaces the rest", () => {
    expect(safeName('report final (2).pdf')).toBe('report_final__2_.pdf');
    expect(safeName('notes.md')).toBe('notes.md');
    expect(safeName('...')).toBe('file...');
    expect(safeName(`${'a'.repeat(200)}.txt`)).toHaveLength(128);
  });
});

describe('chunksOf', () => {
  it('splits into base64 chunks of at most 262 144 chars that join back', () => {
    const bytes = Uint8Array.from({ length: 196_608 * 2 + 5 }, (_, i) => i % 251);
    const chunks = chunksOf(bytes);
    expect(chunks).toHaveLength(3);
    expect(Math.max(...chunks.map(c => c.length))).toBe(262_144);
    const back = chunks.flatMap(c => [...atob(c)].map(ch => ch.charCodeAt(0)));
    expect(back).toEqual([...bytes]);
    expect(chunksOf(new Uint8Array())).toEqual(['']);
  });
});

describe('uploadFile', () => {
  it('puts every chunk, then calls send_file as a person (from_agent 0)', async () => {
    const calls: unknown[] = [];
    const name = await uploadFile(new File(['hello'], 'my notes.txt'), 3n, 1n, {
      putBlobChunk: async a => void calls.push(['chunk', a]),
      sendFile: async a => void calls.push(['send', a]),
    });
    expect(name).toBe('my_notes.txt');
    const [[, chunk], [, send]] = calls as [string, Record<string, unknown>][];
    expect(chunk).toMatchObject({ seq: 0, data: btoa('hello') });
    expect(send).toMatchObject({ name: 'my_notes.txt', size: 5n, chunks: 1, fromAgent: 0n, toAgent: 3n, channelId: 1n, blob: chunk.blob });
    expect(String(send.blob)).toMatch(/^file:\d+:my_notes\.txt$/);
    expect(send.sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('refuses files over 50 MB before reading them', async () => {
    const big = { name: 'big.bin', size: 52_428_801 } as File;
    await expect(uploadFile(big, 3n, 1n, { putBlobChunk: async () => {}, sendFile: async () => {} })).rejects.toThrow(/50 MB/);
  });
});
