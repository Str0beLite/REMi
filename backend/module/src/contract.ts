// CONTRACT FILE: tables and allowed values from CONTRACT.md §2-§3, §6.
// Changes only through a lane:contract issue (Ryan merges). Reducers live in src/index.ts (lane:web).
import { schema, table, t } from 'spacetimedb/server';

export const NODE_STATUSES = ['up', 'asleep', 'down'] as const;
export const CHANNEL_KINDS = ['public', 'thread', 'dm'] as const;
export const MEMBER_KINDS = ['user', 'agent'] as const;
export const AUTHOR_KINDS = ['user', 'agent', 'system'] as const;
export const MESSAGE_KINDS = [
  'chat',
  'tool_call',
  'tool_result',
  'help_request',
  'tool_card',
  'agent_card',
  'adapter_event',
  'sleep_event',
  'system',
] as const;
export const AGENT_STATUSES = ['idle', 'thinking', 'asleep', 'stopped'] as const;
export const RUN_STATES = ['running', 'done', 'stopped', 'budget'] as const;
export const TOOL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export const PROPOSAL_STATUSES = ['pending', 'approved', 'rejected'] as const; // agent_proposal.status
export const TODO_STATUSES = ['open', 'done'] as const;
export const ADAPTER_STATUSES = ['candidate', 'adopted', 'rejected'] as const;
export const TRIGGERS = ['mention', 'dm', 'every_message', 'sleep_event'] as const;
export const BUILTIN_TOOLS = ['sh', 'fetch', 'say', 'note', 'propose_tool', 'propose_agent', 'think'] as const;
export const SLEEP_TOOLS = ['read', 'todo', 'memory', 'dataset', 'train_spec', 'sleep', 'adapter'] as const; // Sleep REMi only (§7)
export const RESERVED_TOOLS = [...BUILTIN_TOOLS, ...SLEEP_TOOLS] as const; // no registry tool may take these names
export const DEFAULT_CHANNELS = ['general', 'ops'] as const;
export const HEADGEAR = ['none', 'nightcap', 'headset', 'hardhat', 'bow'] as const; // Agentfile look.headgear (§5)
export const DEFAULT_SETTINGS: Record<string, string> = {
  sleep_cron: '0 3 * * *',
  max_train_minutes: '30',
  last_sleep_ts: '0',
};

const pub = { public: true } as const;

export const user = table(
  { name: 'user', ...pub },
  { identity: t.identity().primaryKey(), nickname: t.string(), is_admin: t.bool() },
);

export const node = table(
  { name: 'node', ...pub },
  {
    id: t.u64().primaryKey().autoInc(),
    identity: t.identity().unique(),
    name: t.string().unique(),
    gpu: t.string(),
    base_model: t.string(),
    status: t.string(),
    last_seen: t.timestamp(),
    stats: t.string().default('{}'),
  },
);

export const channel = table(
  { name: 'channel', ...pub },
  {
    id: t.u64().primaryKey().autoInc(),
    name: t.string(),
    kind: t.string(),
    parent_id: t.u64(),
    created_by: t.identity(),
    ts: t.timestamp(),
  },
);

export const member = table(
  { name: 'member', ...pub },
  {
    id: t.u64().primaryKey().autoInc(),
    channel_id: t.u64().index(),
    member_kind: t.string(),
    member_id: t.string(),
  },
);

export const message = table(
  { name: 'message', ...pub },
  {
    id: t.u64().primaryKey().autoInc(),
    channel_id: t.u64().index(),
    author_kind: t.string(),
    author_id: t.string(),
    kind: t.string(),
    body: t.string(),
    meta: t.string(),
    ts: t.timestamp(),
  },
);

export const agent = table(
  { name: 'agent', ...pub },
  {
    id: t.u64().primaryKey().autoInc(),
    name: t.string().unique(),
    agentfile: t.string(),
    status: t.string(),
    node_id: t.u64(),
    owner: t.identity(),
    protected: t.bool(),
  },
);

export const run = table(
  { name: 'run', ...pub },
  {
    id: t.u64().primaryKey().autoInc(),
    agent_id: t.u64().index(),
    channel_id: t.u64(),
    trigger_msg_id: t.u64(),
    turns: t.u32(),
    started: t.timestamp(),
    state: t.string(),
  },
);

export const tool = table(
  { name: 'tool', ...pub },
  {
    id: t.u64().primaryKey().autoInc(),
    key: t.string().unique(),
    name: t.string(),
    version: t.u32(),
    code: t.string(),
    docs: t.string(),
    status: t.string(),
    author_agent: t.u64(),
    dry_run: t.string(),
    reviewer: t.option(t.identity()),
    review_note: t.string(),
    ts: t.timestamp(),
  },
);

export const agent_proposal = table(
  { name: 'agent_proposal', ...pub },
  {
    id: t.u64().primaryKey().autoInc(),
    agentfile: t.string(),
    node_id: t.u64(),
    author_agent: t.u64(),
    reason: t.string(),
    status: t.string(),
    reviewer: t.option(t.identity()),
    review_note: t.string(),
    agent_id: t.u64(),
    ts: t.timestamp(),
  },
);

export const memory = table(
  { name: 'memory', ...pub },
  { id: t.u64().primaryKey().autoInc(), agent_id: t.u64().index(), text: t.string(), ts: t.timestamp() },
);

export const todo = table(
  { name: 'todo', ...pub },
  {
    id: t.u64().primaryKey().autoInc(),
    agent_id: t.u64().index(),
    text: t.string(),
    status: t.string(),
    ts: t.timestamp(),
  },
);

export const dataset = table(
  { name: 'dataset', ...pub },
  {
    name: t.string().primaryKey(),
    node_id: t.u64(),
    n_examples: t.u32(),
    sha256: t.string(),
    description: t.string(),
    created_by: t.string(),
    ts: t.timestamp(),
  },
);

export const adapter = table(
  { name: 'adapter', ...pub },
  {
    id: t.u64().primaryKey().autoInc(),
    key: t.string().unique(),
    name: t.string(),
    version: t.u32(),
    node_id: t.u64(),
    base: t.string(),
    description: t.string(),
    sha256: t.string(),
    size: t.u64(),
    status: t.string(),
    train_stats: t.string(),
    parent_version: t.u32(),
    dataset_names: t.string(),
    ts: t.timestamp(),
  },
);

export const config_history = table(
  { name: 'config_history', ...pub },
  {
    id: t.u64().primaryKey().autoInc(),
    agent_id: t.u64().index(),
    agentfile: t.string(),
    changed_by: t.string(),
    ts: t.timestamp(),
  },
);

export const setting = table({ name: 'setting', ...pub }, { key: t.string().primaryKey(), value: t.string() });

// The one private table (§3): subscribers must not read one-time admin claim codes.
export const admin_code = table({ name: 'admin_code', public: false }, { code: t.string().primaryKey() });

const db = schema({
  user,
  node,
  channel,
  member,
  message,
  agent,
  run,
  tool,
  agent_proposal,
  memory,
  todo,
  dataset,
  adapter,
  config_history,
  setting,
  admin_code,
});

export default db;
