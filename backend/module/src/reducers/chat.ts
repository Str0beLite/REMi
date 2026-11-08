// Chat reducers: CONTRACT.md §4 set_nickname, create_channel, join, leave, post_message.
import { SenderError, t, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import db, { AUTHOR_KINDS, CHANNEL_KINDS, MEMBER_KINDS, MESSAGE_KINDS } from '../contract';

type Ctx = ReducerCtx<InferSchema<typeof db>>;

const PUBLIC_NAME = /^[a-z0-9-]{1,32}$/;
const DM_NAME = /^dm-[A-Za-z0-9]+-[A-Za-z0-9]+$/;
const MAX_BODY = 16_000;

const hex = (ctx: Ctx) => ctx.sender.toHexString();
const callerUser = (ctx: Ctx) => ctx.db.user.identity.find(ctx.sender);
const callerNode = (ctx: Ctx) => ctx.db.node.identity.find(ctx.sender);
const isAdmin = (ctx: Ctx) => callerUser(ctx)?.is_admin === true;

function oneOf(value: string, allowed: readonly string[], what: string) {
  if (!allowed.includes(value)) throw new SenderError(`unknown ${what}: ${value}`);
}

function channelOrThrow(ctx: Ctx, id: bigint) {
  const ch = ctx.db.channel.id.find(id);
  if (!ch) throw new SenderError(`no channel ${id}`);
  return ch;
}

function agentById(ctx: Ctx, memberId: string) {
  if (!/^\d+$/.test(memberId)) throw new SenderError(`bad agent id: ${memberId}`);
  return ctx.db.agent.id.find(BigInt(memberId));
}

// The member itself, the node that runs that agent, or an admin (§4 join/leave).
function checkMemberRights(ctx: Ctx, memberKind: string, memberId: string) {
  oneOf(memberKind, MEMBER_KINDS, 'member kind');
  if (memberKind === 'user') {
    if (![...ctx.db.user.iter()].some(u => u.identity.toHexString() === memberId))
      throw new SenderError(`no user ${memberId}`);
    if (memberId === hex(ctx) || isAdmin(ctx)) return;
  } else {
    const a = agentById(ctx, memberId);
    if (!a) throw new SenderError(`no agent ${memberId}`);
    if (callerNode(ctx)?.id === a.node_id || isAdmin(ctx)) return;
  }
  throw new SenderError('not allowed to change this membership');
}

function findMember(ctx: Ctx, channelId: bigint, memberKind: string, memberId: string) {
  return [...ctx.db.member.channel_id.filter(channelId)].find(
    m => m.member_kind === memberKind && m.member_id === memberId,
  );
}

export const set_nickname = db.reducer({ nickname: t.string() }, (ctx, { nickname }) => {
  const name = nickname.trim();
  if (name.length < 1 || name.length > 24) throw new SenderError('nickname must be 1-24 characters');
  const existing = callerUser(ctx);
  if (existing) ctx.db.user.identity.update({ ...existing, nickname: name });
  else ctx.db.user.insert({ identity: ctx.sender, nickname: name, is_admin: false });
});

export const create_channel = db.reducer(
  { name: t.string(), kind: t.string(), parent_id: t.u64() },
  (ctx, { name, kind, parent_id }) => {
    if (!callerUser(ctx) && !callerNode(ctx)) throw new SenderError('set a nickname or register a node first');
    oneOf(kind, CHANNEL_KINDS, 'channel kind');
    if (kind === 'thread') {
      channelOrThrow(ctx, parent_id);
      if (name.length < 1 || name.length > 80) throw new SenderError('thread name must be 1-80 characters');
    } else {
      if (parent_id !== 0n) throw new SenderError(`${kind} channels have no parent`);
      if (kind === 'public' && !PUBLIC_NAME.test(name))
        throw new SenderError('public names are lowercase a-z, 0-9 and -, 1-32 characters');
      if (kind === 'dm' && !DM_NAME.test(name)) throw new SenderError('dm names are dm-<a>-<b>');
      if ([...ctx.db.channel.iter()].some(c => c.kind === kind && c.name === name))
        throw new SenderError(`${kind} channel ${name} already exists`);
    }
    ctx.db.channel.insert({ id: 0n, name, kind, parent_id, created_by: ctx.sender, ts: ctx.timestamp });
  },
);

export const join = db.reducer(
  { channel_id: t.u64(), member_kind: t.string(), member_id: t.string() },
  (ctx, { channel_id, member_kind, member_id }) => {
    channelOrThrow(ctx, channel_id);
    checkMemberRights(ctx, member_kind, member_id);
    // Idempotent: the runtime re-syncs memberships after every Agentfile change.
    if (findMember(ctx, channel_id, member_kind, member_id)) return;
    ctx.db.member.insert({ id: 0n, channel_id, member_kind, member_id });
  },
);

export const leave = db.reducer(
  { channel_id: t.u64(), member_kind: t.string(), member_id: t.string() },
  (ctx, { channel_id, member_kind, member_id }) => {
    channelOrThrow(ctx, channel_id);
    checkMemberRights(ctx, member_kind, member_id);
    const m = findMember(ctx, channel_id, member_kind, member_id);
    if (!m) throw new SenderError('not a member');
    ctx.db.member.id.delete(m.id);
  },
);

export const post_message = db.reducer(
  {
    channel_id: t.u64(),
    author_kind: t.string(),
    author_id: t.string(),
    kind: t.string(),
    body: t.string(),
    meta: t.string(),
  },
  (ctx, { channel_id, author_kind, author_id, kind, body, meta }) => {
    channelOrThrow(ctx, channel_id);
    oneOf(author_kind, AUTHOR_KINDS, 'author kind');
    oneOf(kind, MESSAGE_KINDS, 'message kind');
    if (body.length > MAX_BODY) throw new SenderError(`body is over ${MAX_BODY} characters`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(meta);
    } catch {
      throw new SenderError('meta is not valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new SenderError('meta must be a JSON object');

    if (author_kind === 'user') {
      if (!callerUser(ctx) || author_id !== hex(ctx)) throw new SenderError('users post only as themselves');
      if (kind !== 'chat') throw new SenderError('users post only chat messages');
    } else {
      const n = callerNode(ctx);
      if (!n) throw new SenderError('only nodes post as agents or system');
      if (author_kind === 'agent' && agentById(ctx, author_id)?.node_id !== n.id)
        throw new SenderError(`agent ${author_id} does not run on this node`);
    }
    ctx.db.message.insert({ id: 0n, channel_id, author_kind, author_id, kind, body, meta, ts: ctx.timestamp });
  },
);
