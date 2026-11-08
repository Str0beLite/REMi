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

// channels: ["*"] = every public channel, now and later (CONTRACT.md §5).
export const ALL_CHANNELS = '*';
export const channelsLabel = (channels: readonly string[]) =>
  channels.includes(ALL_CHANNELS) ? 'all channels' : channels.length ? channels.map(c => `#${c}`).join(', ') : 'none';

// "Wakes up when", least to most alert; each level includes the ones before it.
export const WAKE_LEVELS = [
  { label: 'Someone DMs it', triggers: ['dm'] },
  { label: 'DMs and @mentions', triggers: ['dm', 'mention'] },
  { label: 'Any activity in its channels', triggers: ['dm', 'mention', 'every_message'] },
] as const;
const LEVEL_TRIGGERS: readonly string[] = WAKE_LEVELS[2].triggers;
export const SLEEP_TRIGGER = 'sleep_event';

// The highest level the triggers imply, or -1 when they wake on none of dm, mention, every_message.
export const wakeLevel = (triggers: readonly string[]) => Math.max(-1, ...WAKE_LEVELS.map((l, i) => (triggers.includes(l.triggers.at(-1)!) ? i : -1)));
// Triggers the editor doesn't drive (e.g. incident): kept as they are and shown read-only.
export const otherTriggers = (triggers: readonly string[]) => triggers.filter(t => !LEVEL_TRIGGERS.includes(t) && t !== SLEEP_TRIGGER);
export const withWakeLevel = (triggers: readonly string[], level: number) => [
  ...WAKE_LEVELS[level].triggers,
  ...triggers.filter(t => !LEVEL_TRIGGERS.includes(t)),
];
export const withSleep = (triggers: readonly string[], on: boolean) => [...triggers.filter(t => t !== SLEEP_TRIGGER), ...(on ? [SLEEP_TRIGGER] : [])];
export const BUILTIN_TOOLS = ['sh', 'fetch', 'say', 'note', 'send', 'migrate', 'agents', 'propose_tool', 'registry:*'] as const;

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
  triggers: ['dm', 'mention'],
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
