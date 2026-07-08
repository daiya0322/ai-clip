import { NextResponse } from 'next/server';

const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:8000';

export async function GET() {
  // Render free tier cold start can take 30-50s
  try {
    const res = await fetch(`${BACKEND}/api/health`, {
      signal: AbortSignal.timeout(55000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { status: 'error', detail: 'バックエンドに接続できません' },
      { status: 503 },
    );
  }
}
