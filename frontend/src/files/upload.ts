// Console uploads (#98): the browser does what /send's node does, then the recipient's node delivers to /shared.
export const MAX_UPLOAD = 52_428_800; // send_file's 50 MB cap
const RAW_CHUNK = 196_608; // base64 makes it 262 144 chars, put_blob_chunk's limit

// send_file accepts [A-Za-z0-9._-]{1,128}; anything else becomes _.
export function safeName(name: string) {
  const clean = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-128);
  return /^[._-]*$/.test(clean) ? `file${clean}` : clean;
}

export function chunksOf(bytes: Uint8Array): string[] {
  const out: string[] = [];
  for (let i = 0; i < bytes.length || i === 0; i += RAW_CHUNK) {
    const part = bytes.subarray(i, i + RAW_CHUNK);
    let bin = '';
    for (let j = 0; j < part.length; j += 0x8000) bin += String.fromCharCode(...part.subarray(j, j + 0x8000));
    out.push(btoa(bin));
  }
  return out;
}

// WebCrypto only exists on https or localhost; send_file takes '' and the node then checks the size only.
async function sha256(bytes: Uint8Array) {
  if (!crypto?.subtle) return '';
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

type Calls = {
  putBlobChunk: (a: { blob: string; seq: number; data: string }) => Promise<void>;
  sendFile: (a: {
    blob: string; name: string; size: bigint; sha256: string; chunks: number;
    fromAgent: bigint; toAgent: bigint; channelId: bigint; note: string;
  }) => Promise<void>;
};

export async function uploadFile(file: File, toAgent: bigint, channelId: bigint, calls: Calls, onProgress?: (done: number, of: number) => void) {
  if (file.size > MAX_UPLOAD) throw new Error(`${file.name} is over 50 MB`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = safeName(file.name);
  const blob = `file:${crypto.getRandomValues(new Uint32Array(2)).join('')}:${name}`;
  const chunks = chunksOf(bytes);
  for (const [seq, data] of chunks.entries()) {
    await calls.putBlobChunk({ blob, seq, data });
    onProgress?.(seq + 1, chunks.length);
  }
  await calls.sendFile({
    blob, name, size: BigInt(bytes.length), sha256: await sha256(bytes), chunks: chunks.length,
    fromAgent: 0n, toAgent, channelId, note: '',
  });
  return name;
}
