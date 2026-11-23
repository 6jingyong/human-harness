import { NextResponse } from 'next/server';
import { inspectCodexModels } from '@/executors/codex';
import { ollamaModels } from '@/executors/ollama';
import { getModelSettings, saveModelSettings } from '@/core/store';
import { modelSettingsSchema, providerSchema, type Provider, type ModelOption } from '@/protocol/model-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function catalog(provider: Provider, signal: AbortSignal): Promise<ModelOption[]> {
  if (provider === 'codex') return inspectCodexModels({ signal });
  if (provider === 'ollama') return ollamaModels();
  if (provider === 'demo') return [];
  const current = getModelSettings();
  const ids = [current.provider === 'mastra' ? current.model : '', process.env.HH_MODEL || 'openai/gpt-6.1-sol',
    ...(process.env.HH_MODELS || '').split(',')].map(name => name.trim()).filter(Boolean);
  return [...new Set(ids)].map(id => ({ id, name: id }));
}

function unavailable(provider: Provider) {
  const message = provider === 'codex' ? '无法读取 Codex 模型。请确认本机已安装 Codex CLI、完成登录且状态目录可写。'
    : provider === 'ollama' ? '无法连接本机 Ollama。请启动 Ollama 并下载至少一个模型。' : '模型目录读取失败。';
  return NextResponse.json({ error: message }, { status: 503 });
}

export async function GET(request: Request) {
  const provider = providerSchema.safeParse(new URL(request.url).searchParams.get('provider'));
  if (!provider.success) return NextResponse.json({ error: '未知的模型来源。' }, { status: 400 });
  try { return NextResponse.json({ models: await catalog(provider.data, request.signal) }); }
  catch { return unavailable(provider.data); }
}

export async function PUT(request: Request) {
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  if (origin && origin !== 'http://' + host && origin !== 'https://' + host) {
    return NextResponse.json({ error: '请从当前工作台保存设置。' }, { status: 403 });
  }
  const parsed = modelSettingsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: '请输入有效的模型 ID。Mastra 使用 provider/model 格式。' }, { status: 400 });
  const settings = parsed.data;
  if (settings.provider === 'codex' || settings.provider === 'ollama') {
    try {
      const available = await catalog(settings.provider, request.signal);
      if (!available.length || (settings.model && !available.some(item => item.id === settings.model))) {
        return NextResponse.json({ error: '该模型当前不可用，请刷新模型列表。' }, { status: 409 });
      }
    } catch { return unavailable(settings.provider); }
  }
  return NextResponse.json({ settings: saveModelSettings(settings) });
}
