import { NextResponse } from 'next/server';
import { inspectApprovedMcpTools } from '@/executors/codex';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  // Next can normalize the internal URL to localhost even when the browser used 127.0.0.1.
  if (origin && (!host || ![`http://${host}`, `https://${host}`].includes(origin))) {
    return NextResponse.json({ error: '请从当前工作台查看工具。' }, { status: 403 });
  }
  try {
    const inventory = await inspectApprovedMcpTools({ signal: request.signal });
    return NextResponse.json(inventory, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: '无法连接本机 Codex。请检查 CLI 和状态目录，或手动填写工具名称。' }, { status: 503 });
  }
}
