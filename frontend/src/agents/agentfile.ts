// Agentfile text <-> form fields, validated in the browser against the same JSON Schema the module uses
// (contract/agentfile.schema.json), so errors show inline before anything is submitted.
import Ajv2020 from 'ajv/dist/2020';
import { parse, stringify } from 'yaml';
import schemaText from '../../../contract/agentfile.schema.json?raw';

export type Agentfile = {
  name: string;
  purpose: string;
  channels: string[];
  triggers: string[];
  tools: string[];
  budget: { turns: number; minutes: number };
  adapters: { name: string; version: number; weight: number }[];
};

export const TRIGGERS = ['mention', 'dm', 'every_message', 'sleep_event'] as const;
export const BUILTIN_TOOLS = ['sh', 'fetch', 'say', 'note', 'propose_tool', 'registry:*'] as const;

const validate = new Ajv2020({ allErrors: true }).compile<Agentfile>(JSON.parse(schemaText));

export type Checked = { ok: true; value: Agentfile } | { ok: false; errors: string[] };

export function checkAgentfile(text: string): Checked {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    return { ok: false, errors: [`YAML: ${(e as Error).message.split('\n')[0]}`] };
  }
  if (validate(doc)) return { ok: true, value: doc };
  const errors = (validate.errors ?? [])
    // anyOf on tools reports each branch; keep the readable ones.
    .filter(e => e.keyword !== 'anyOf')
    .map(e => `${e.instancePath ? e.instancePath.slice(1).replace(/\//g, '.') : 'Agentfile'} ${e.message}`);
  return { ok: false, errors: [...new Set(errors)] };
}

export function toYaml(af: Agentfile) {
  return stringify(af, { lineWidth: 0 });
}

export const BLANK: Agentfile = {
  name: 'new-remi',
  purpose: 'Describe what this REMi does and how it should answer.',
  channels: ['general'],
  triggers: ['mention'],
  tools: ['say', 'note'],
  budget: { turns: 10, minutes: 10 },
  adapters: [],
};

const fixtures = import.meta.glob('../../../fixtures/agentfiles/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

// Templates: a blank file plus every valid fixture (General assistant, Tool builder, Sleep REMi…).
export const TEMPLATES: { id: string; label: string; text: string }[] = [
  { id: 'blank', label: 'Blank', text: toYaml(BLANK) },
  ...Object.entries(fixtures)
    .map(([path, text]) => {
      const id = path.split('/').pop()!.replace(/\.yaml$/, '');
      return { id, label: id.replace(/-/g, ' ').replace(/^\w/, c => c.toUpperCase()), text };
    })
    .sort((a, b) => a.label.localeCompare(b.label)),
];
