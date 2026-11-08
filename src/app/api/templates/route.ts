import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { addTemplate, DomainError } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.text();
    if (body.length > 100000) throw new DomainError('Template JSON is too large');
    let json: unknown;
    try { json = JSON.parse(body); }
    catch { throw new DomainError('Template must be valid JSON'); }
    const template = addTemplate(json);
    return NextResponse.json({ template }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json({ error: 'Invalid template schema: ' + error.issues.map(i => i.path.join('.') + ' ' + i.message).slice(0, 3).join('; ') }, { status: 400 });
    }
    if (error instanceof DomainError || error instanceof Error && /Cycle|Invalid dependency|Duplicate|Agent task|Invalid task/.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Template import error:', error);
    return NextResponse.json({ error: 'Failed to import template' }, { status: 500 });
  }
}
