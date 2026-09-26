import { useEffect, useState } from 'react';
import type { LlmEffort } from '@janis/shared';
import { api } from '../api/client';
import { ModelPicker } from './ModelPicker';
import {
  METERED,
  catalogForId,
  catalogOptions,
  catalogRateFor,
  detectProvider,
  filterLiveModels,
  prettifyModelName,
  providerFor,
  providerForVendor,
  type ModelOption,
} from '../lib/llmProviders';
import { OR_VENDOR_SLUG, type LlmVendor } from '@janis/shared';
import { connectOpenRouter, consumeOpenRouterResult } from '../lib/openrouterAuth';

/** The llm config block — agent config.llm or workspace llm_config. */
export interface LlmBlock {
  provider?: string;
  model?: string;
  base_url?: string;
  api_key?: string | null;
  key_set?: boolean;
  effort?: LlmEffort;
}

/** Hosted/BYOK LLM picker: Janis metered vs BYOK provider presets, with a
 *  live /models dropdown and one-click OpenRouter connect (PKCE). Used for
 *  the workspace default (Settings) and the per-agent override — `modelsUrl`
 *  is the endpoint that serves the live model list for that scope, and
 *  `inheritedModel`/`inheritedLabel` describe what runs when no model is
 *  picked (workspace default for agents, env default for the workspace). */
export function LlmEditor({
  llm,
  onChange,
  isAdmin,
  modelsUrl,
  inheritedModel,
  inheritedLabel,
  onOauthResult,
}: {
  llm: LlmBlock;
  onChange: (llm: LlmBlock) => void;
  isAdmin: boolean;
  modelsUrl: string;
  inheritedModel?: string;
  inheritedLabel?: string;
  /** Fired after an OpenRouter round-trip produces a key/error — the parent
   *  may want to surface it (agent page shows a draft note). */
  onOauthResult?: (msg: string) => void;
}) {
  const providerId = llm.provider ?? detectProvider(llm) ?? METERED;
  const mode = providerId === METERED ? 'hosted' : 'byok';
  const preset = providerFor(providerId);
  const [liveModels, setLiveModels] = useState<string[]>([]);
  const [modelsMsg, setModelsMsg] = useState('');
  const [modelsBusy, setModelsBusy] = useState(false);
  // Metered provider accounts — which vendors Janis can actually serve,
  // resolved server-side from env (JANIS_LLM_* + JANIS_LLM_PROVIDERS).
  const [meteredAccounts, setMeteredAccounts] = useState<
    { vendor: string; base_url: string; models: string[]; error?: string }[] | null
  >(null);
  // what runs when nothing picks a model — JANIS_LLM_MODEL on the server,
  // surfaced so the picker shows the effective default
  const [meteredDefault, setMeteredDefault] = useState('');
  const [rates, setRates] = useState<{
    rates: Record<string, { input: number; output: number }>;
    margin: number;
    plan?: string;
  } | null>(null);

  useEffect(() => {
    api<{
      rates: Record<string, { input: number; output: number }>;
      margin: number;
      plan?: string;
    }>('/api/billing/llm-rates')
      .then(setRates)
      .catch(() => {});
  }, []);

  // An OpenRouter OAuth round-trip lands back on this page — pick up the key.
  useEffect(() => {
    const r = consumeOpenRouterResult();
    if (!r.key && !r.error) return;
    if (r.key) {
      onChange({
        ...llm,
        provider: 'openrouter',
        api_key: r.key,
        base_url: providerFor('openrouter')?.baseUrl,
      });
      onOauthResult?.('OpenRouter connected — click Save to apply.');
      setModelsMsg('OpenRouter connected — click Save to apply.');
    } else {
      onOauthResult?.(`OpenRouter connect failed: ${r.error}`);
      setModelsMsg(`OpenRouter connect failed: ${r.error}`);
    }
    // run once — llm/onChange identity churns on every keystroke
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchModels = async () => {
    setModelsBusy(true);
    setModelsMsg('');
    try {
      const r = await api<{
        models?: string[];
        accounts?: { vendor: string; base_url: string; models: string[]; error?: string }[];
        error?: string;
        base_url?: string;
        default_model?: string;
      }>(modelsUrl, {
        method: 'POST',
        body: JSON.stringify(
          mode === 'hosted'
            ? { metered: true }
            : { base_url: llm.base_url, api_key: llm.api_key || undefined },
        ),
      });
      if (r.accounts) {
        setMeteredAccounts(r.accounts);
        if (r.default_model) setMeteredDefault(r.default_model);
        // provider errors are operator-side (bad key, no credits) — logged
        // server-side, never shown to customers; errored vendors' models
        // are simply absent from the picker
      } else {
        setLiveModels(r.models ?? []);
        if (r.error) setModelsMsg(`couldn't list models: ${r.error}`);
        else if (!r.models?.length) setModelsMsg('endpoint returned no models');
      }
    } catch (e) {
      setModelsMsg(`couldn't list models: ${e instanceof Error ? e.message : 'failed'}`);
    } finally {
      setModelsBusy(false);
    }
  };

  // Populate the model list when we can authenticate (metered key, saved key,
  // or a key typed into the draft).
  useEffect(() => {
    if (mode === 'hosted' || llm.api_key || llm.key_set) void fetchModels();
    else setLiveModels([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  const usd = (n: number) => n.toFixed(2).replace(/\.?0+$/, '');
  const margin = rates?.margin ?? 0;
  // saved model wins; hosted falls back to the inherited default (workspace
  // model for agent overrides, else the server's env default) so the picker
  // reflects what actually runs
  const fallbackModel = inheritedModel || meteredDefault;
  const effectiveModel = llm.model || (mode === 'hosted' ? fallbackModel : '');
  const billedRate = effectiveModel ? catalogRateFor(effectiveModel) : null;

  const setLlm = (patch: Record<string, unknown>) => onChange({ ...llm, ...patch });

  /** Set provider + base_url, translating the model id: OpenRouter wants
   *  `vendor/id` compounds, direct endpoints want the provider-native id.
   *  `extra` merges additional llm fields (e.g. effort) into the patch. */
  const applyProvider = (id: string, model?: string, extra?: Record<string, unknown>) => {
    const p = providerFor(id);
    const sameEndpoint = Boolean(p?.baseUrl) && p!.baseUrl === (llm.base_url ?? '');
    let m = model ?? llm.model;
    const c = m ? catalogForId(m) : undefined;
    if (m && c) {
      m = id === 'openrouter' ? (c.or ?? `${OR_VENDOR_SLUG[c.vendor]}/${c.id}`) : c.id;
    }
    onChange({
      ...llm,
      provider: id,
      model: m,
      // 'custom' keeps whatever endpoint was there for editing
      base_url: p?.baseUrl ?? (id === 'custom' ? (llm.base_url ?? '') : ''),
      // a different endpoint needs its own key — null clears the stored one
      ...(sameEndpoint ? {} : { api_key: null }),
      key_set: undefined,
      ...extra,
    });
  };

  const onMode = (m: 'hosted' | 'byok') => {
    if (m === 'hosted') {
      // keep the BYOK fields around — switching back shouldn't lose the key.
      // On the free plan hosted models are locked to the Janis default —
      // clear the draft model so the save lands on it.
      setLlm({
        provider: METERED,
        ...(rates?.plan === 'free' ? { model: undefined } : {}),
      });
      return;
    }
    // derive the provider from the current model's vendor
    const c = llm.model ? catalogForId(llm.model) : undefined;
    applyProvider(providerForVendor(c?.vendor)?.id ?? 'custom', c?.id ?? llm.model);
  };

  const pickModel = (id: string, extra?: Record<string, unknown>) => {
    if (mode === 'hosted') return setLlm({ model: id, ...extra });
    const c = catalogForId(id);
    if (providerId === 'openrouter') {
      setLlm({ model: c ? (c.or ?? `${OR_VENDOR_SLUG[c.vendor]}/${c.id}`) : id, ...extra });
      return;
    }
    if (!c) return applyProvider('custom', id, extra); // unknown id → custom endpoint
    applyProvider(providerForVendor(c.vendor)?.id ?? 'custom', c.id, extra);
  };

  // choosing an effort level in a model's detail panel selects it too
  const pickEffort = (id: string, effort?: string) =>
    pickModel(id, { effort: (effort || undefined) as LlmEffort | undefined });

  // Options: hosted → catalog + live ids for vendors Janis has accounts for;
  // BYOK → the whole catalog + live ids from the chosen endpoint.
  const modelOptions: ModelOption[] = [];
  const push = (o: ModelOption) => {
    if (!modelOptions.some((x) => x.id === o.id)) modelOptions.push(o);
  };
  // Unpriced rows have no meter and can't show a breakdown — and on the
  // metered side can't be billed correctly anyway. Custom endpoints are
  // exempt: self-hosted models have no catalog price by definition.
  const priced = (o: ModelOption) => catalogRateFor(o.id) != null;
  if (mode === 'hosted') {
    for (const acc of meteredAccounts ?? []) {
      if (acc.error) continue; // unreachable account — its models can't run
      // 'default' (unknown base_url) and 'openrouter' (routes all vendors)
      // accounts expose the whole catalog
      const vend =
        acc.vendor === 'default' || acc.vendor === 'openrouter'
          ? undefined
          : (acc.vendor as LlmVendor);
      for (const o of catalogOptions(vend ? [vend] : undefined).filter(priced)) push(o);
      const liveProvider =
        acc.vendor === 'openrouter' ? 'openrouter' : (providerForVendor(vend)?.id ?? 'custom');
      for (const o of filterLiveModels(liveProvider, acc.models).filter(priced)) {
        push(o);
      }
    }
  } else {
    const keep = providerId === 'custom' ? () => true : priced;
    for (const o of catalogOptions().filter(keep)) push(o);
    for (const o of filterLiveModels(providerId, liveModels).filter(keep)) push(o);
  }
  if (effectiveModel && !modelOptions.some((o) => o.id === effectiveModel)) {
    const c = catalogForId(effectiveModel);
    modelOptions.unshift({
      id: effectiveModel,
      name: c?.name ?? prettifyModelName(effectiveModel),
      vendor: c?.vendor ?? preset?.vendor,
    });
  }

  // 'via' choices for BYOK — the model's vendor first, then OpenRouter
  // (one OAuth key reaches everything), then a raw custom endpoint.
  const modelVendor = llm.model ? catalogForId(llm.model)?.vendor : undefined;
  const direct = providerForVendor(modelVendor);
  const viaOptions: { id: string; label: string }[] = [
    ...(direct && direct.id !== 'openrouter' ? [{ id: direct.id, label: direct.label }] : []),
    { id: 'openrouter', label: 'OpenRouter (all models)' },
    { id: 'custom', label: 'Custom (OpenAI-compatible)' },
  ];
  if (!viaOptions.some((o) => o.id === providerId) && mode === 'byok') {
    viaOptions.unshift({ id: providerId, label: preset?.label ?? providerId });
  }

  const unlockIds = [meteredDefault, inheritedModel].filter(Boolean) as string[];

  return (
    <>
      <select
        value={mode}
        disabled={!isAdmin}
        onChange={(e) => onMode(e.target.value as 'hosted' | 'byok')}
      >
        <option value="hosted">Hosted by Janis — billed to your plan's LLM meter</option>
        <option value="byok">Bring your own key — $0 Janis LLM fees</option>
      </select>

      <div className="row">
        <ModelPicker
          value={effectiveModel}
          options={modelOptions}
          disabled={!isAdmin}
          onChange={pickModel}
          effort={llm.effort}
          onEffort={pickEffort}
          rateScale={mode === 'hosted' ? 1 + margin : 1}
          locked={mode === 'hosted' && rates?.plan === 'free'}
          unlockIds={unlockIds}
        />
        {isAdmin && (
          <button
            className="btn"
            disabled={modelsBusy}
            onClick={() => void fetchModels()}
            title="Fetch the live model list from the provider endpoint"
          >
            {modelsBusy ? 'Loading…' : 'Refresh models'}
          </button>
        )}
      </div>

      {mode === 'hosted' && rates?.plan === 'free' && (
        <div className="muted" style={{ fontSize: 12 }}>
          Hosted model selection is fixed on the Free plan —{' '}
          <a href="/billing">upgrade to choose a different LLM</a>, or switch
          to bring-your-own-key below.
        </div>
      )}

      {mode === 'byok' && (
        <>
          <div className="row">
            <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
              via
            </span>
            <select
              className="grow"
              value={providerId}
              disabled={!isAdmin}
              onChange={(e) => applyProvider(e.target.value)}
            >
              {viaOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="row">
            <input
              className="grow"
              type="password"
              autoComplete="off"
              placeholder={
                llm.key_set
                  ? 'Key saved — paste a new one to replace'
                  : (preset?.keyHint ?? 'API key')
              }
              value={llm.api_key ?? ''}
              disabled={!isAdmin}
              onChange={(e) => setLlm({ api_key: e.target.value })}
            />
            {preset?.oauth === 'openrouter' && isAdmin && (
              <button
                className="btn"
                onClick={() => void connectOpenRouter()}
                title="Authorize Janis on OpenRouter — creates a key on your account"
              >
                Connect account
              </button>
            )}
            {preset?.keyUrl && preset.oauth !== 'openrouter' && (
              <a
                href={preset.keyUrl}
                target="_blank"
                rel="noreferrer"
                className="muted"
                style={{ whiteSpace: 'nowrap', alignSelf: 'center' }}
              >
                get a key ↗
              </a>
            )}
          </div>
          {providerId === 'custom' && (
            <input
              placeholder="Base URL (https://your-llm.example.com/v1)"
              value={llm.base_url ?? ''}
              disabled={!isAdmin}
              onChange={(e) => setLlm({ base_url: e.target.value })}
            />
          )}
        </>
      )}

      {modelsMsg && (
        <div className="muted" style={{ fontSize: 12 }}>
          {modelsMsg}
        </div>
      )}
      <div className="muted" style={{ fontSize: 12 }}>
        {mode === 'hosted'
          ? billedRate && effectiveModel
            ? `Billed $${usd(billedRate.input * (1 + (rates?.margin ?? 0)))} per 1M input / $${usd(billedRate.output * (1 + (rates?.margin ?? 0)))} per 1M output tokens on your LLM meter.${llm.model ? '' : inheritedLabel ? ` (${inheritedLabel})` : ' (account default)'}`
            : 'Runs on Janis’s provider accounts — each model bills its own price to your LLM meter. Pick a model to see it.'
          : billedRate && llm.model
            ? `$0 Janis LLM fees — ${llm.model} bills ~$${usd(billedRate.input)}/$${usd(billedRate.output)} per 1M on your provider account. Keys are write-only.`
            : 'Your key bills $0 Janis LLM fees. Keys are write-only — saved keys are never re-displayed.'}
      </div>
    </>
  );
}
