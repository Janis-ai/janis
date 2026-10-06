import {
  BUILDER_SYSTEM,
  catalogBrief,
  parseDraftJson,
  validateDraft,
} from '../../src/lib/agentBuilder.js';
import { complete } from '../../src/lib/hostedAgent.js';
import { meteredSettingsFor } from '../../src/lib/llm.js';
import { env } from '../../src/env.js';

const LOOSE = BUILDER_SYSTEM.replace(
  'pick at most 4 catalog entries, only ones the description genuinely needs',
  'pick at most 4 catalog entries — any that clearly help the described domain or the tasks the operator describes',
);

const briefs = process.argv.slice(2);
const llm = { ...meteredSettingsFor(env.llmModel), temperature: 0, maxTokens: 4096 };
console.log('model:', env.llmModel);

for (const brief of briefs) {
  console.log('\n=== brief:', brief);
  for (const [tag, sys] of [['strict', BUILDER_SYSTEM], ['loose', LOOSE]] as const) {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const completion = await complete(llm, sys + catalogBrief(), [
        { role: 'user', content: brief },
      ]);
      const parsed = parseDraftJson(completion.text ?? '');
      if (!parsed) {
        console.log(`    ${tag} raw[${i}]:`, JSON.stringify((completion.text ?? '').slice(0, 400)));
        ids.push('UNPARSEABLE');
        continue;
      }
      const d = validateDraft(parsed);
      ids.push(d.suggested_templates.map((t) => t.id).join('+') || '—');
    }
    console.log(`  ${tag.padEnd(6)} ${ids.join(' | ')}`);
  }
}
process.exit(0);
