import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { getLaunchablePackage, landInvestigationReference, listLaunchablePackages } from '@/app/launch-templates';
import { importPackage, RuntimeError } from '@/core/store';

export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    if (params.has('reference')) {
      if (params.get('reference') !== 'land-investigation') {
        return NextResponse.json({ error: 'Reference template not found' }, { status: 404 });
      }
      return NextResponse.json({ package: landInvestigationReference });
    }
    const id = params.get('id');
    return NextResponse.json(id ? { package: getLaunchablePackage(id, params.get('version') ?? undefined) } : { packages: listLaunchablePackages() });
  } catch { return NextResponse.json({ error: 'Project package not found' }, { status: 404 }); }
}
export async function POST(request: Request) {
  try {
    const body = await request.text();
    if (body.length > 200000) throw new RuntimeError('Package JSON exceeds 200 KB');
    let raw: unknown;
    try { raw = JSON.parse(body); } catch { throw new RuntimeError('Invalid JSON package'); }
    return NextResponse.json({ package: importPackage(raw) }, { status: 201 });
  } catch (error) {
    const message = error instanceof ZodError ? error.issues.slice(0, 5).map(e => e.path.join('.') + ': ' + e.message).join('; ')
      : error instanceof RuntimeError ? error.message : 'Package import failed';
    if (!(error instanceof ZodError || error instanceof RuntimeError)) console.error('Package import error:', error);
    return NextResponse.json({ error: message }, { status: error instanceof ZodError || error instanceof RuntimeError ? 400 : 500 });
  }
}
