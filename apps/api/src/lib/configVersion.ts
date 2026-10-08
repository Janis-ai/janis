import { createHash } from 'crypto';
import type { AgentConfig } from '@janis/shared';

/** Fingerprint of the behavior-bearing config — instructions, knowledge,
 *  and abilities. A run or verdict stored against a different fingerprint
 *  is stale: fixing one answer can break another, so edits ask for a
 *  re-run rather than silently aging out. */
export function configVersion(cfg: AgentConfig): string {
  return createHash('sha1')
    .update(
      JSON.stringify({
        s: cfg.system_prompt ?? '',
        k: cfg.knowledge ?? [],
        t: cfg.tools ?? [],
        b: cfg.builtin_tools ?? [],
      }),
    )
    .digest('hex')
    .slice(0, 12);
}
