import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { workspaces } from '../db/schema.js';
import { env } from '../env.js';
import { effectivePlanKey } from './plans.js';

/**
 * WorkOS REST client for the SSO/SCIM admin surface — organization +
 * connection lifecycle, Admin Portal link generation. Auth is the server
 * API key; every call is workspace-agnostic (the workspace→org mapping
 * lives in workspaces.config.workos).
 *
 * Billing note: WorkOS charges per ACTIVE SSO/Directory Sync connection
 * (~$125/mo each). The plan gate on /api/workspace/sso/* controls who may
 * mint portal links, and maybeDisableSso (called on downgrade/sub-delete)
 * kills connections when a workspace leaves the gated tier — a lingering
 * connection bills forever otherwise.
 */

const API = 'https://api.workos.com';

/** Plans allowed to hold an SSO connection — each one bills ~$125/mo
 * against our WorkOS account, so lower tiers never mint portal links. */
export const SSO_PLANS = new Set(['scale', 'internal']);

export interface WorkosState {
  organization_id?: string;
  domain?: string;
  connection_id?: string;
}

async function wo<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.workosApiKey}`,
      'content-type': 'application/json',
      ...init?.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    throw new Error(`workos ${path}: ${(body.message as string) ?? `HTTP ${res.status}`}`);
  }
  return body as T;
}

/** A customer-facing organization — one per workspace that sets up SSO. */
export async function createOrganization(
  name: string,
  domain: string,
): Promise<{ id: string }> {
  return wo('/organizations', {
    method: 'POST',
    body: JSON.stringify({
      name,
      domain_data: [{ domain, state: 'pending' }],
    }),
  });
}

/** Hosted Admin Portal link — the customer's IT walks the SAML/SCIM setup
 * wizard themselves; the connection appears on the org when they finish. */
export async function portalLink(
  organizationId: string,
  intent: 'sso' | 'dsync',
): Promise<{ link: string }> {
  return wo('/portal/generate_link', {
    method: 'POST',
    body: JSON.stringify({ organization: organizationId, intent }),
  });
}

export interface WorkosConnection {
  id: string;
  name?: string;
  status?: string; // 'active' | 'inactive' | 'validating' …
  connection_type?: string;
}

export async function listConnections(organizationId: string): Promise<WorkosConnection[]> {
  const out = await wo<{ data?: WorkosConnection[] } | WorkosConnection[]>(
    `/connections?organization_id=${encodeURIComponent(organizationId)}`,
  );
  return Array.isArray(out) ? out : (out.data ?? []);
}

export interface WorkosDirectory {
  id: string;
  name?: string;
  state?: string;
  type?: string;
}

export async function listDirectories(organizationId: string): Promise<WorkosDirectory[]> {
  const out = await wo<{ data?: WorkosDirectory[] } | WorkosDirectory[]>(
    `/directory_sync/directories?organization_id=${encodeURIComponent(organizationId)}`,
  );
  return Array.isArray(out) ? out : (out.data ?? []);
}

/** Delete = deregister — stops the per-connection meter. */
export async function deleteConnection(connectionId: string): Promise<void> {
  await wo(`/connections/${encodeURIComponent(connectionId)}`, { method: 'DELETE' });
}

export function readWorkosState(config: unknown): WorkosState {
  const w = (config as { workos?: WorkosState } | null)?.workos;
  return w && typeof w === 'object' ? w : {};
}

/** Tear down a workspace's SSO connections — called when the workspace
 * leaves the gated plan (downgrade/cancel) so the meter stops. Clears the
 * stored state so a future upgrade starts clean. */
export async function maybeDisableSso(db: Db, workspaceId: string): Promise<void> {
  const [ws] = await db
    .select({ config: workspaces.config })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const state = readWorkosState(ws?.config);
  if (!state.organization_id && !state.connection_id) return;
  try {
    if (state.organization_id) {
      const conns = await listConnections(state.organization_id);
      for (const conn of conns) await deleteConnection(conn.id);
    } else if (state.connection_id) {
      await deleteConnection(state.connection_id);
    }
  } catch (e) {
    // WorkOS unreachable — keep the state so the next downgrade/sync retry
    // can finish the job instead of leaking a billing connection.
    console.error(`workos disable failed for workspace ${workspaceId}:`, e);
    return;
  }
  const config = { ...(ws?.config as Record<string, unknown>) };
  delete config.workos;
  delete config.workos_directory_id;
  await db.update(workspaces).set({ config }).where(eq(workspaces.id, workspaceId));
}

/** Called wherever a workspace's plan may have dropped below the SSO gate
 * (downgrade, subscription.deleted, plan swap). No-op when the plan still
 * qualifies or no SSO state exists. */
export async function disableSsoIfUngated(db: Db, workspaceId: string): Promise<void> {
  if (SSO_PLANS.has(await effectivePlanKey(db, workspaceId))) return;
  await maybeDisableSso(db, workspaceId);
}
