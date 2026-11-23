import { NextResponse } from 'next/server';
import { getCompanyLedger } from '@/core/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(getCompanyLedger(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Company ledger request failed', error);
    return NextResponse.json({ error: '无法读取公司账务。' }, { status: 500 });
  }
}
