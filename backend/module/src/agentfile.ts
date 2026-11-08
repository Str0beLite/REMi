// Agentfile parsing + validation against contract/agentfile.schema.json (CONTRACT.md §5).
import Ajv2020 from 'ajv/dist/2020';
import { parse } from 'yaml';
import { SenderError } from 'spacetimedb/server';
import schema from '../../../contract/agentfile.schema.json';

export type Agentfile = {
  name: string;
  purpose: string;
  channels: string[];
  triggers: string[];
  tools: string[];
  budget: { turns: number; minutes: number };
  adapters: { name: string; version: number; weight: number }[];
};

const validate = new Ajv2020({ allErrors: true }).compile<Agentfile>(schema);

export function parseAgentfile(text: string): Agentfile {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    throw new SenderError(`Agentfile is not valid YAML: ${(e as Error).message.split('\n')[0]}`);
  }
  if (!validate(doc)) {
    const why = (validate.errors ?? []).map(e => `${e.instancePath || '/'} ${e.message}`).join('; ');
    throw new SenderError(`invalid Agentfile: ${why}`);
  }
  return doc;
}
