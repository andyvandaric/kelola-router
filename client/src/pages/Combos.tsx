import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'preact/hooks';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { confirmDialog } from '../components/Confirm';
import { ErrorState } from '../components/ErrorState';
import { Modal } from '../components/Modal';
import { TableSkeleton } from '../components/Skeleton';
import { useToast } from '../components/ToastProvider';
import { TopBar } from '../layout/TopBar';
import { apiFetch } from '../lib/api';

interface Combo {
  id: string;
  name: string;
  models: string[];
  created_at: string;
  updated_at: string;
}

interface Model {
  name: string;
  enabled: boolean;
}

const NAME_RE = /^[a-zA-Z0-9._-]+$/;

export function Combos() {
  const qc = useQueryClient();
  const toast = useToast();
  const {
    data: combos = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['combos'],
    queryFn: () => apiFetch<{ combos: Combo[] }>('/api/admin/combos').then((r) => r.combos),
  });

  const { data: models = [] } = useQuery({
    queryKey: ['models'],
    queryFn: () => apiFetch<Model[]>('/api/admin/models'),
  });

  const [editing, setEditing] = useState<Combo | 'new' | null>(null);

  const saveMut = useMutation({
    mutationFn: async (args: { id?: string; name: string; models: string[] }) => {
      if (args.id) {
        return apiFetch<Combo>(`/api/admin/combos/${encodeURIComponent(args.id)}`, {
          method: 'PUT',
          json: { name: args.name, models: args.models },
        });
      }
      return apiFetch<Combo>('/api/admin/combos', {
        method: 'POST',
        json: { name: args.name, models: args.models },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['combos'] });
      setEditing(null);
      toast.success('Saved');
    },
    onError: (e: Error) => toast.error(e.message || 'Save failed'),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/admin/combos/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['combos'] });
      toast.success('Deleted');
    },
    onError: (e: Error) => toast.error(e.message || 'Delete failed'),
  });

  return (
    <>
      <TopBar
        title={<>Com<em>bo</em>s</>}
        eyebrow="Catalog / combos"
        actions={<Button onClick={() => setEditing('new')}>+ New Combo</Button>}
      />
      <p class="card-sub">
        Combos define ordered sequences of models. Requests are routed through the list in priority
        order for fallback or load distribution.
      </p>
      <Card>
        {isError ? (
          <ErrorState error={error as Error} onRetry={() => refetch()} />
        ) : isLoading ? (
          <TableSkeleton rows={4} cols={4} />
        ) : combos.length === 0 ? (
          <p class="card-sub">
            No combos yet.{' '}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setEditing('new');
              }}
            >
              Create one →
            </a>
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table class="tbl">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Models</th>
                  <th>Updated</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {combos.map((c) => (
                  <tr key={c.id}>
                    <td class="mono">{c.name}</td>
                    <td>
                      <span class="card-sub">{c.models.length} model{c.models.length !== 1 ? 's' : ''}</span>
                    </td>
                    <td class="card-sub mono" style={{ fontSize: 12 }}>
                      {c.updated_at}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, whiteSpace: 'nowrap' }}>
                        <Button size="sm" onClick={() => setEditing(c)}>
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={async () => {
                            if (
                              await confirmDialog({
                                title: 'Delete combo',
                                message: `Delete combo "${c.name}"? This cannot be undone.`,
                                confirmLabel: 'Delete',
                                danger: true,
                              })
                            ) {
                              deleteMut.mutate(c.id);
                            }
                          }}
                        >
                          Del
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <ComboModal
          combo={editing === 'new' ? null : editing}
          models={models}
          onClose={() => setEditing(null)}
          onSave={(payload) => saveMut.mutate(payload)}
          saving={saveMut.isPending}
        />
      )}
    </>
  );
}

function ComboModal({
  combo,
  models,
  onClose,
  onSave,
  saving,
}: {
  combo: Combo | null;
  models: Model[];
  onClose: () => void;
  onSave: (args: { id?: string; name: string; models: string[] }) => void;
  saving: boolean;
}) {
  const [name, setName] = useState(combo?.name ?? '');
  const [comboModels, setComboModels] = useState<string[]>(combo?.models ?? []);
  const [addingModel, setAddingModel] = useState(false);

  const enabledModels = models.filter((m) => m.enabled);
  const availableModels = enabledModels.filter((m) => !comboModels.includes(m.name));

  const nameValid = NAME_RE.test(name);
  const hasModels = comboModels.length > 0;

  const moveUp = (idx: number) => {
    if (idx === 0) return;
    const next = [...comboModels];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    setComboModels(next);
  };

  const moveDown = (idx: number) => {
    if (idx >= comboModels.length - 1) return;
    const next = [...comboModels];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    setComboModels(next);
  };

  const removeModel = (idx: number) => {
    setComboModels(comboModels.filter((_, i) => i !== idx));
  };

  const addModel = (modelName: string) => {
    setComboModels([...comboModels, modelName]);
    setAddingModel(false);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={combo ? `Edit combo: ${combo.name}` : 'New combo'}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              onSave({
                id: combo?.id,
                name: name.trim(),
                models: comboModels,
              })
            }
            disabled={saving || !nameValid || !hasModels}
          >
            {saving ? 'Saving…' : combo ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 16 }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span class="card-sub mono" style={{ fontSize: 12, textTransform: 'uppercase' }}>
            Combo name
          </span>
          <input
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            placeholder="my-combo-1"
            class="input"
          />
          {name && !nameValid && (
            <span style={{ color: 'var(--alert)', fontSize: 12 }}>
              Letters, digits, . _ - only
            </span>
          )}
        </label>

        <div style={{ display: 'grid', gap: 8 }}>
          <span class="card-sub mono" style={{ fontSize: 12, textTransform: 'uppercase' }}>
            Models (priority order)
          </span>

          {comboModels.length === 0 ? (
            <p class="card-sub" style={{ margin: 0 }}>
              No models added yet.
            </p>
          ) : (
            <div style={{ display: 'grid', gap: 4 }}>
              {comboModels.map((m, idx) => (
                <div
                  key={`${m}-${idx}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 8px',
                    borderRadius: 6,
                    background: 'var(--bg-2, rgba(255,255,255,0.04))',
                  }}
                >
                  <span
                    class="mono"
                    style={{
                      fontSize: 11,
                      color: 'var(--text-3)',
                      width: 20,
                      textAlign: 'center',
                      flexShrink: 0,
                    }}
                  >
                    {idx + 1}
                  </span>
                  <span class="mono" style={{ flex: 1, fontSize: 13 }}>
                    {m}
                  </span>
                  <div style={{ display: 'flex', gap: 2 }}>
                    <button
                      class="btn btn-ghost btn-sm"
                      onClick={() => moveUp(idx)}
                      disabled={idx === 0}
                      title="Move up"
                      aria-label={`Move ${m} up`}
                    >
                      ↑
                    </button>
                    <button
                      class="btn btn-ghost btn-sm"
                      onClick={() => moveDown(idx)}
                      disabled={idx === comboModels.length - 1}
                      title="Move down"
                      aria-label={`Move ${m} down`}
                    >
                      ↓
                    </button>
                    <button
                      class="btn btn-danger btn-sm"
                      onClick={() => removeModel(idx)}
                      title="Remove"
                      aria-label={`Remove ${m}`}
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {addingModel ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select
                class="input"
                style={{ flex: 1 }}
                onChange={(e) => {
                  const val = (e.target as HTMLSelectElement).value;
                  if (val) addModel(val);
                }}
              >
                <option value="">Select a model…</option>
                {availableModels.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                  </option>
                ))}
              </select>
              <Button variant="ghost" size="sm" onClick={() => setAddingModel(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAddingModel(true)}
              disabled={availableModels.length === 0}
            >
              + Add Model
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
