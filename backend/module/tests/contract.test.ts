import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { parse } from 'yaml';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import * as mod from '../src/index';
import db, { TRIGGERS, BUILTIN_TOOLS } from '../src/contract';

const root = join(import.meta.dirname, '../../..');
const schema = JSON.parse(readFileSync(join(root, 'contract/agentfile.schema.json'), 'utf8'));
const validate = new Ajv2020({ allErrors: true }).compile(schema);
const agentfiles = (dir: string): [string, unknown][] =>
  readdirSync(join(root, dir))
    .filter(f => f.endsWith('.yaml'))
    .map(f => [f, parse(readFileSync(join(root, dir, f), 'utf8'))]);

describe('agentfile schema', () => {
  it.each(agentfiles('fixtures/agentfiles'))('accepts %s', (_f, doc) => {
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
  });
  it.each(agentfiles('fixtures/agentfiles/invalid'))('rejects %s', (_f, doc) => {
    expect(validate(doc)).toBe(false);
  });
  it('matches the contract.ts constants', () => {
    expect(schema.properties.triggers.items.enum).toEqual([...TRIGGERS]);
    expect(schema.properties.tools.items.anyOf[0].enum).toEqual([...BUILTIN_TOOLS, 'registry:*']);
  });
});

describe('module', () => {
  it('init creates default channels and settings', () => {
    const h = createModuleTestHarness(db, mod);
    h.withReducerTx(TestAuth.internal(), ctx => mod.init(ctx, {}));
    expect([...h.db.channel.iter()].map(c => c.name).sort()).toEqual(['general', 'ops']);
    expect(h.db.setting.key.find('sleep_cron')?.value).toBe('0 3 * * *');
  });
});
