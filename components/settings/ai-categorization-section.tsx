// Structurally modeled on components/settings/reminders-section.tsx: an
// `available` early-return card, then a live card with local optimistic
// state seeded from server props.
//
// Disclosure/save ordering (resolved, overrides the ui-designer's original
// accept-then-save sequence): UserAiSettings.provider/encryptedApiKey are
// non-nullable, so a row can't exist from "accept disclosure" alone before a
// key is saved. The modal's "Looks good, continue" button therefore triggers
// the real key save first; only once that succeeds does it stamp disclosure
// acceptance on the now-existing row. If the save fails (e.g. key rejected),
// the accept call never fires and the user sees the disclosure again next
// attempt — harmless, since nothing was sent to a provider either way.
'use client';

import { useState } from 'react';
import { deleteJSON, patchJSON, postJSON, putJSON } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/field';
import { pillOption } from '@/components/settings/pills';
import { PillGroup, PillHighlight } from '@/components/settings/pill-group';
import { AiDisclosureModal } from '@/components/settings/ai-disclosure-modal';
import type { AiModelsResult, FrontendAiSettings } from '@/lib/services/aiSettings';
import type { AiModelSummary } from '@/lib/ai/types';
import { AI_PROVIDERS } from '@/lib/validators/ai-settings';

type Provider = (typeof AI_PROVIDERS)[number]; // 'ANTHROPIC' | 'OPENAI'

const PROVIDER_LABELS: Record<Provider, string> = {
  ANTHROPIC: 'Anthropic',
  OPENAI: 'OpenAI',
};

export const AiCategorizationSection = ({
  settings: initialSettings,
  models: initialModels,
}: {
  settings: FrontendAiSettings;
  models: AiModelsResult;
}): React.ReactElement => {
  const [settings, setSettings] = useState(initialSettings);

  // The model picker owns its own state, seeded from the server prop and
  // replaced from the PUT response after a key save — `useState` seeding means
  // a router refresh would not reseed it.
  //
  // Precedence: when the server says `ok`, its `selectedModelId` is
  // authoritative and `settings.modelId` is never read by the picker.
  // `getAiSettings` and `listAiModels` run concurrently in the same
  // `Promise.all` over the same row, and `listAiModels` *writes* modelId as a
  // side effect, so `settings.modelId` can legitimately be the staler of the
  // two. Only the `unavailable` arm falls back to it.
  const [modelState, setModelState] = useState<AiModelsResult>(initialModels);
  // Deliberately separate from `pending`: changing the model must not put the
  // key form or the toggles into their pending state.
  const [modelPending, setModelPending] = useState(false);
  const [modelNotice, setModelNotice] = useState<string | null>(null);

  // Draft state for the (write-only) key form. `apiKey` is never populated
  // from `settings.maskedKey` — the masked value is display-only and the
  // input starts blank even when a key is already configured, exactly like
  // a password-change form.
  const [provider, setProvider] = useState<Provider>(settings.provider ?? 'ANTHROPIC');
  const [apiKey, setApiKey] = useState('');
  const [sendNote, setSendNote] = useState(settings.sendNote);
  const [sendAmount, setSendAmount] = useState(settings.sendAmount);

  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null); // "saved, not yet verified"

  // Disclosure modal. `dialogKey` forces a fresh preview fetch on every open
  // per this codebase's remount-on-open convention (see match-transfers-dialog).
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const [dialogKey, setDialogKey] = useState(0);

  // Entry point for the Save button: if the disclosure has never been
  // accepted, show it first; the modal's own Accept handler runs the real
  // save. If already accepted, save runs immediately.
  const handleSaveClick = (): void => {
    if (!settings.disclosureAccepted) {
      setDialogKey((k) => k + 1);
      setDisclosureOpen(true);
      return;
    }
    void doSave();
  };

  // PUT /api/settings/ai. Returns whether the save succeeded, so the
  // disclosure-modal flow knows whether it's safe to stamp acceptance.
  //
  // `clearKeyOnSuccess` defaults to true for the direct-save path (disclosure
  // already accepted). The disclosure-accept path passes false: if the
  // save-first-then-accept sequence's second call (POST /disclosure) fails,
  // the typed key must still be in the field, or the user is stuck — the
  // 20-char-minimum validator rejects an empty resubmit, and there was no
  // other way back into this state (`/categorize` never checked
  // `disclosureAccepted` before showing "Suggest with AI", so every click
  // there would 409 with no visible path back to this modal).
  const doSave = async (clearKeyOnSuccess = true): Promise<boolean> => {
    setPending(true);
    setNotice(null);
    setWarning(null);
    try {
      const response = await putJSON<
        FrontendAiSettings & { warning: string | null; models: AiModelSummary[] }
      >('/api/settings/ai', { provider, apiKey: apiKey.trim(), sendNote, sendAmount });

      if (!response.ok) {
        // The 400 case is a rejected key. Nothing was persisted, so the form
        // keeps the typed key for a quick correction.
        setNotice(response.error ?? 'Could not save your API key. Try again.');
        return false;
      }
      const body = response.data;

      // `models` is pulled out by name alongside `warning`: left in the rest
      // element it would be spread into the `settings` object, which is typed
      // as FrontendAiSettings and has no such field.
      const { warning: saveWarning, models: savedModels, ...saved } = body;
      setSettings(saved);
      setModelNotice(null);
      setModelState(
        savedModels.length > 0
          ? {
              outcome: 'ok',
              models: savedModels,
              selectedModelId: saved.modelId ?? savedModels[0].id,
            }
          : {
              // Nothing to pick from yet. The next Settings render re-fetches
              // and backfills. `saveWarning` already told the user their key
              // wasn't verified because the probe couldn't reach the
              // provider — reusing the "no usable models" copy here would
              // read as "your key is bad" right next to that, so a soft-failed
              // probe gets its own message distinct from a genuinely empty list.
              outcome: 'unavailable',
              message: saveWarning
                ? `We couldn't load ${PROVIDER_LABELS[provider]}'s model list just now. It'll load next time you're on this page.`
                : `${PROVIDER_LABELS[provider]} didn't return any usable models for this key.`,
              selectedModelId: saved.modelId,
            },
      );
      setSendNote(saved.sendNote);
      setSendAmount(saved.sendAmount);
      // Write-only form: the field never re-displays what was stored. Only
      // cleared once nothing later in the flow still needs it (see above).
      if (clearKeyOnSuccess) {
        setApiKey('');
      }
      setWarning(saveWarning);
      if (!saveWarning) {
        setNotice(null);
      }
      return true;
    } catch {
      setNotice('Could not save your API key. Try again.');
      return false;
    } finally {
      setPending(false);
    }
  };

  // Modal's Accept handler: save the key first (see file header note), then
  // stamp disclosure acceptance only if that succeeded. The key stays in the
  // field until acceptance actually lands, so a failed accept call can be
  // retried without re-pasting anything.
  const handleDisclosureAccept = async (): Promise<void> => {
    const saved = await doSave(false);
    if (!saved) return; // modal stays open; doSave already surfaced the error
    setPending(true);
    try {
      const response = await postJSON<FrontendAiSettings>('/api/settings/ai/disclosure');
      if (!response.ok) {
        setNotice('Key saved, but could not record your review. Click "Looks good" to retry.');
        return;
      }
      setSettings(response.data);
      setApiKey('');
      setDisclosureOpen(false);
    } catch {
      setNotice('Key saved, but could not record your review. Click "Looks good" to retry.');
    } finally {
      setPending(false);
    }
  };

  const handleRemove = async (): Promise<void> => {
    setPending(true);
    setNotice(null);
    setWarning(null);
    try {
      const response = await deleteJSON('/api/settings/ai');
      if (!response.ok) {
        setNotice('Could not remove your API key. Try again.');
        return;
      }
      // The row is gone, so the disclosure stamp went with it — the next save
      // shows the disclosure again, which is correct rather than a regression.
      setSettings({
        configured: false,
        provider: null,
        maskedKey: null,
        verified: false,
        sendNote: false,
        sendAmount: false,
        disclosureAccepted: false,
        available: settings.available,
        modelId: null,
      });
      setSendNote(false);
      setSendAmount(false);
      setApiKey('');
      // The row is gone, so there is no model selection left to show.
      setModelState({ outcome: 'not-configured' });
      setModelNotice(null);
    } catch {
      setNotice('Could not remove your API key. Try again.');
    } finally {
      setPending(false);
    }
  };

  // Toggles fire independently via PATCH — never bundled with a key save, so
  // flipping one can never re-submit or overwrite the stored key.
  const handleToggle = async (next: { sendNote: boolean; sendAmount: boolean }): Promise<void> => {
    setPending(true);
    try {
      const response = await patchJSON<FrontendAiSettings>('/api/settings/ai/toggles', next);
      if (!response.ok) {
        // Roll the optimistic flip back rather than leaving the switch lying.
        setSendNote(settings.sendNote);
        setSendAmount(settings.sendAmount);
        setNotice('Could not save that setting. Try again.');
        return;
      }
      setSettings(response.data);
    } catch {
      setSendNote(settings.sendNote);
      setSendAmount(settings.sendAmount);
      setNotice('Could not save that setting. Try again.');
    } finally {
      setPending(false);
    }
  };

  // Same optimistic-with-rollback shape as handleToggle, on its own pending
  // flag so an in-flight model change never spins the "Save key" button or
  // disables the toggles.
  const handleModelChange = async (nextModelId: string): Promise<void> => {
    if (modelState.outcome !== 'ok') return;
    const previous = modelState;
    setModelState({ ...previous, selectedModelId: nextModelId });
    setModelPending(true);
    setModelNotice(null);
    try {
      const response = await patchJSON<FrontendAiSettings>('/api/settings/ai/model', {
        modelId: nextModelId,
      });
      if (!response.ok) {
        setModelState(previous);
        setModelNotice('Could not save that model. Try again.');
        return;
      }
      setSettings(response.data);
    } catch {
      setModelState(previous);
      setModelNotice('Could not save that model. Try again.');
    } finally {
      setModelPending(false);
    }
  };

  // The `unavailable` arm is the only one that falls back to `settings.modelId`
  // (see the precedence note above). Hoisted out of the JSX so the `<select>`'s
  // `value` is a plain identifier.
  const storedModelId =
    modelState.outcome === 'unavailable' ? (modelState.selectedModelId ?? settings.modelId) : null;

  if (!settings.available) {
    return (
      <div className="border-line bg-paper-raised rounded-2xl border p-5">
        <h2 className="font-display text-[15px] font-semibold">AI categorization</h2>
        <p className="text-ink-muted mt-3 text-[13.5px]">
          AI suggestions aren&rsquo;t available on this deployment.
        </p>
      </div>
    );
  }

  return (
    <div className="border-line bg-paper-raised rounded-2xl border p-5">
      <h2 className="font-display text-[15px] font-semibold">AI categorization</h2>
      <p className="text-ink-muted mt-1 text-[12.5px]">
        Bring your own Anthropic or OpenAI key to get on-demand category suggestions in the
        Categorize queue for transactions no rule matches.
      </p>

      {/* Provider selector — pill group, same idiom as Preferences' palette row */}
      <div className="ledger-row flex items-center gap-5 py-3.5">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Provider</div>
          <div className="text-ink-muted mt-0.5 text-[12.5px]">
            Saving a new provider replaces any existing key
          </div>
        </div>
        <PillGroup>
          {AI_PROVIDERS.map((p) => (
            <button
              key={p}
              type="button"
              disabled={pending}
              onClick={() => setProvider(p)}
              className={pillOption(provider === p, pending)}
            >
              <PillHighlight active={provider === p} />
              <span className="relative">{PROVIDER_LABELS[p]}</span>
            </button>
          ))}
        </PillGroup>
      </div>

      {/* API key — write-only. Existing key is represented only by the
          masked-value placeholder text, never as a value. */}
      <div className="py-3.5">
        <Label htmlFor="ai-api-key">API key</Label>
        <Input
          id="ai-api-key"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={settings.configured ? (settings.maskedKey ?? undefined) : 'sk-...'}
        />
        {settings.configured && (
          <p className="text-ink-muted mt-1.5 text-[12.5px]">
            {settings.verified
              ? `${PROVIDER_LABELS[settings.provider!]} key saved and verified.`
              : `${PROVIDER_LABELS[settings.provider!]} key saved — not yet verified (the provider was unreachable at save time).`}
          </p>
        )}
        <div className="mt-3 flex gap-2.5">
          <Button
            type="button"
            onClick={handleSaveClick}
            disabled={apiKey.trim().length < 20}
            loading={pending}
          >
            Save key
          </Button>
          {settings.configured && (
            <Button type="button" variant="danger" onClick={handleRemove} disabled={pending}>
              Remove key
            </Button>
          )}
        </div>
      </div>

      {notice && (
        <p className="bg-rose-soft text-rose mt-1 rounded-lg px-3 py-2 text-[13px]" role="alert">
          {notice}
        </p>
      )}
      {warning && (
        // Informational, not an error (the Q1 outage-tolerant "saved, unverified"
        // state) — ink-muted on a neutral border, deliberately not the rose
        // error treatment. This codebase's palette has no amber/warning token.
        <p
          className="border-line text-ink-muted mt-1 rounded-lg border px-3 py-2 text-[13px]"
          role="status"
        >
          {warning}
        </p>
      )}

      {/* Model — a native <select>, not the Provider row's pill group: the list
          is long and unbounded (40+ ids for OpenAI) and pills do not scale to
          that. Rendered only once a key is configured; there is nothing to pick
          from before one exists. */}
      {settings.configured && modelState.outcome !== 'not-configured' && (
        <div className="ledger-row py-3.5">
          <Label htmlFor="ai-model">Model</Label>
          {modelState.outcome === 'ok' ? (
            <>
              <select
                id="ai-model"
                className="border-line bg-paper-sunk mt-1 w-full rounded-lg border px-3 py-2 text-sm"
                value={modelState.selectedModelId}
                // aria-busy, never disabled: disabling the control mid-PATCH
                // would move focus and hide the value the user just picked.
                aria-busy={modelPending}
                aria-describedby="ai-model-hint"
                onChange={(e) => void handleModelChange(e.target.value)}
              >
                {/* A stored id the list did not return is prepended rather than
                    dropped: a <select> whose value matches no option renders
                    blank, which is exactly what keeping the id is meant to
                    prevent. */}
                {!modelState.models.some((m) => m.id === modelState.selectedModelId) && (
                  <option value={modelState.selectedModelId}>
                    {`${modelState.selectedModelId} (current)`}
                  </option>
                )}
                {modelState.models.map((model, index) => (
                  <option key={model.id} value={model.id}>
                    {index === 0 ? `${model.label} (newest)` : model.label}
                  </option>
                ))}
              </select>
              <p className="text-ink-muted mt-1.5 text-[12.5px]" id="ai-model-hint">
                Used for every suggestion. The list comes from{' '}
                {PROVIDER_LABELS[settings.provider ?? provider]} and is refreshed each time you open
                Settings.
              </p>
            </>
          ) : (
            <>
              {/* Informational, not an error: a list we could not load is not
                  the user's mistake. Same muted treatment as `warning`. */}
              <p
                className="border-line text-ink-muted mt-1 rounded-lg border px-3 py-2 text-[13px]"
                role="status"
              >
                {modelState.message}
              </p>
              {/* With a model already in force, show it — disabled, single
                  option — so the user can see what is being used and cannot
                  half-change it against a list we could not load. With nothing
                  stored there is nothing to show, so no control renders. */}
              {storedModelId !== null && (
                <select
                  id="ai-model"
                  className="border-line bg-paper-sunk mt-1.5 w-full rounded-lg border px-3 py-2 text-sm opacity-60"
                  value={storedModelId}
                  disabled
                  aria-describedby="ai-model-hint"
                  onChange={() => {}}
                >
                  <option value={storedModelId}>{storedModelId}</option>
                </select>
              )}
              <p className="text-ink-muted mt-1.5 text-[12.5px]" id="ai-model-hint">
                Reopen Settings to try loading the list again.
              </p>
            </>
          )}
          {modelNotice && (
            <p
              className="bg-rose-soft text-rose mt-1.5 rounded-lg px-3 py-2 text-[13px]"
              role="alert"
            >
              {modelNotice}
            </p>
          )}
        </div>
      )}

      {/* Toggles — visually subordinate to (and disabled without) a configured
          key. Switch idiom cloned verbatim from reminders-section.tsx. */}
      <div
        className={cn('mt-2 border-t pt-3.5', 'border-line', !settings.configured && 'opacity-60')}
      >
        <div className="flex items-center gap-5 py-2">
          <div className="min-w-0 flex-1">
            <div className={cn('text-sm font-medium', !settings.configured && 'text-ink-muted')}>
              Include the transaction note
            </div>
            <div className="text-ink-muted mt-0.5 text-[12.5px]">
              Sent to {PROVIDER_LABELS[provider]} only for the transaction you suggest on
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={sendNote}
            aria-label="Include the transaction note"
            disabled={!settings.configured || pending}
            onClick={() => {
              const next = !sendNote;
              setSendNote(next);
              void handleToggle({ sendNote: next, sendAmount });
            }}
            className={cn(
              'relative h-7 w-12 shrink-0 rounded-full border transition-colors',
              sendNote ? 'bg-iris border-iris' : 'border-line bg-paper-sunk',
              (!settings.configured || pending) && 'opacity-60',
            )}
          >
            <span
              className={cn(
                'bg-paper-raised absolute top-0.5 size-5.5 rounded-full shadow-sm transition-[left]',
                sendNote ? 'left-[22px]' : 'left-0.5',
              )}
            />
          </button>
        </div>
        <div className="flex items-center gap-5 py-2">
          <div className="min-w-0 flex-1">
            <div className={cn('text-sm font-medium', !settings.configured && 'text-ink-muted')}>
              Include the amount
            </div>
            <div className="text-ink-muted mt-0.5 text-[12.5px]">Off by default</div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={sendAmount}
            aria-label="Include the amount"
            disabled={!settings.configured || pending}
            onClick={() => {
              const next = !sendAmount;
              setSendAmount(next);
              void handleToggle({ sendNote, sendAmount: next });
            }}
            className={cn(
              'relative h-7 w-12 shrink-0 rounded-full border transition-colors',
              sendAmount ? 'bg-iris border-iris' : 'border-line bg-paper-sunk',
              (!settings.configured || pending) && 'opacity-60',
            )}
          >
            <span
              className={cn(
                'bg-paper-raised absolute top-0.5 size-5.5 rounded-full shadow-sm transition-[left]',
                sendAmount ? 'left-[22px]' : 'left-0.5',
              )}
            />
          </button>
        </div>
        {!settings.configured && (
          <p className="text-ink-muted mt-1 text-[12.5px]" id="ai-toggles-disabled-hint">
            Save an API key to turn these on.
          </p>
        )}
      </div>

      <AiDisclosureModal
        key={dialogKey}
        open={disclosureOpen}
        onClose={() => setDisclosureOpen(false)}
        onAccept={handleDisclosureAccept}
        pending={pending}
        // The modal owns its own GET (it is remounted per open via dialogKey),
        // so there is nothing to pre-fetch here.
        preview={null}
        provider={provider}
      />
    </div>
  );
};
