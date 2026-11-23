'use client';

import { useEffect, useRef, useState } from 'react';
import type { ModelOption, ModelSettings, Provider } from '@/protocol/model-settings';

const providers: { id: Provider; name: string; detail: string }[] = [
  { id: 'codex', name: 'Codex', detail: '本机 CLI 账户' },
  { id: 'ollama', name: 'Ollama', detail: '本机模型服务' },
  { id: 'mastra', name: 'Mastra', detail: '服务商 API' },
  { id: 'demo', name: '演示', detail: '无需账户或模型' }
];

export function ModelPicker({ settings, onSaved, onClose }: {
  settings: ModelSettings; onSaved: (value: ModelSettings) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [provider, setProvider] = useState(settings.provider);
  const [model, setModel] = useState(settings.model ?? '');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setError(''); setModels([]);
    if (provider === 'demo') { setLoading(false); return; }
    setLoading(true);
    fetch('/api/v1/models?provider=' + provider, { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        if (controller.signal.aborted) return;
        const options: ModelOption[] = data.models;
        setModels(options);
        setModel(previous => previous || (provider === 'codex' ? '' : options[0]?.id || ''));
      })
      .catch(problem => { if (!controller.signal.aborted) setError(problem.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [provider, refresh]);
  const available = provider === 'demo' || (provider === 'mastra' ? Boolean(model.trim()) :
    models.length > 0 && ((!model && provider === 'codex') || models.some(item => item.id === model)));
  async function save() {
    setSaving(true); setError('');
    try {
      const response = await fetch('/api/v1/models', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model: provider === 'demo' ? null : model.trim() || null }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      onSaved(data.settings);
    } catch (problem) { setError(problem instanceof Error ? problem.message : '保存失败。'); }
    finally { setSaving(false); }
  }
  return <dialog ref={ref} className="model-dialog" aria-labelledby="model-dialog-title"
    onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}>
    <header><div><h2 id="model-dialog-title">选择工作模型</h2><p>应用于本机工作台接下来启动的 Agent 任务。</p></div>
      <button type="button" aria-label="关闭模型设置" disabled={saving} onClick={onClose}>×</button></header>
    <div className="provider-grid" aria-label="模型来源">{providers.map(item =>
      <button type="button" key={item.id} aria-pressed={provider === item.id} disabled={saving}
        onClick={() => { if (provider !== item.id) { setModels([]); setModel(settings.provider === item.id ? settings.model || '' : ''); setProvider(item.id); } }}>
        <strong>{item.name}</strong><small>{item.detail}</small>
      </button>)}</div>
    {provider !== 'demo' && <div className="model-fields">
      <div className="model-field-head"><label htmlFor="hh-model">{provider === 'mastra' ? '服务商 / 模型 ID' : '可用模型'}</label>
        <button type="button" disabled={loading || saving} onClick={() => setRefresh(n => n + 1)}>刷新列表</button></div>
      {provider === 'mastra' ? <><input id="hh-model" list="hh-models" value={model} disabled={saving}
        onChange={e => setModel(e.target.value)} placeholder="provider/model" />
        <datalist id="hh-models">{models.map(m => <option key={m.id} value={m.id} />)}</datalist>
        <small>使用服务商账户中的模型 ID，凭据从本机环境读取。</small></> :
        <select id="hh-model" value={model} disabled={loading || saving || !models.length} onChange={e => setModel(e.target.value)}>
          {provider === 'codex' && <option value="">Codex 默认模型</option>}
          {model && !models.some(m => m.id === model) && <option value={model}>{model}（待确认）</option>}
          {models.map(m => <option key={m.id} value={m.id}>{m.name}{m.isDefault ? ' · 默认' : ''}</option>)}
        </select>}
      {loading && <small role="status">正在读取模型目录…</small>}
      {!loading && !error && !models.length && provider !== 'mastra' && <small>尚无可选模型，请检查本机服务或安装模型后刷新。</small>}
    </div>}
    {error && <p className="model-error" role="alert">{error}</p>}
    <footer><button type="button" onClick={onClose} disabled={saving}>取消</button>
      <button type="button" className="primary" disabled={saving || loading || !available} onClick={save}>{saving ? '保存中…' : '应用设置'}</button></footer>
  </dialog>;
}
