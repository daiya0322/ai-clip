import { NextResponse } from 'next/server';

const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:8000';

export const maxDuration = 60;

export async function GET() {
  try {
    const res = await fetch(`${BACKEND}/api/health`, {
      signal: AbortSignal.timeout(55000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { status: 'warming_up', detail: 'バックエンド起動中' },
      { status: 503 },
    );
  }
}
