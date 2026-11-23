import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { getProjectLedger, LedgerConflictError, RuntimeError, updateProjectLedger } from '@/core/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

function failure(error: unknown) {
  if (error instanceof LedgerConflictError) return NextResponse.json({ error: error.message }, { status: 409 });
  if (error instanceof RuntimeError) {
    return NextResponse.json({ error: error.message }, { status: error.message === 'Project not found' ? 404 : 400 });
  }
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return NextResponse.json({ error: '请检查账务输入、日期和关联事项。' }, { status: 400 });
  }
  console.error('Project ledger request failed', error);
  return NextResponse.json({ error: '无法读取或保存项目账务。' }, { status: 500 });
}

export async function GET(_request: Request, { params }: Context) {
  try {
    const { id } = await params;
    return NextResponse.json(getProjectLedger(id), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    return NextResponse.json(updateProjectLedger(id, await request.json()), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failure(error);
  }
}
