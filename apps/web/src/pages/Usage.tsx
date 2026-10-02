import { UsageCard } from '../components/UsageCard';
import { usePageTitle } from '../lib/title';

/** Usage — workspace rollup by default, one agent's burn when mounted
 *  under /agents/:id/usage. */
export default function Usage({ agentId }: { agentId?: string }) {
  usePageTitle('Usage');
  return (
    <>
      <h1 className="page-title">Usage</h1>
      <UsageCard agentId={agentId} />
    </>
  );
}
