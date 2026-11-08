import { useState } from 'react';
import { useReducer } from 'spacetimedb/react';
import { reducers } from '../module_bindings';
import { uploadFile } from './upload';

// One upload at a time, with a status line for an aria-live region.
export function useUpload() {
  const putBlobChunk = useReducer(reducers.putBlobChunk);
  const sendFile = useReducer(reducers.sendFile);
  const [status, setStatus] = useState<{ text: string; error?: boolean; busy?: boolean }>({ text: '' });

  async function upload(file: File, toAgent: bigint, agentName: string, channelId: bigint) {
    setStatus({ text: `Uploading ${file.name}…`, busy: true });
    try {
      const name = await uploadFile(file, toAgent, channelId, { putBlobChunk, sendFile }, (done, of) =>
        of > 1 && setStatus({ text: `Uploading ${file.name}… ${Math.round((done / of) * 100)}%`, busy: true }),
      );
      setStatus({ text: `Sent ${name} to ${agentName}. It lands in /shared/${name} once ${agentName}'s node picks it up.` });
      return true;
    } catch (err) {
      setStatus({ text: `Not sent: ${err instanceof Error ? err.message : String(err)}`, error: true });
      return false;
    }
  }

  return { upload, status, clear: () => setStatus({ text: '' }) };
}
