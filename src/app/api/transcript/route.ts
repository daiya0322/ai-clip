import { NextRequest, NextResponse } from 'next/server';

const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:8000';

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const res = await fetch(`${BACKEND}/api/transcript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(280000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (e: unknown) {
    const isTimeout = e instanceof Error && e.name === 'TimeoutError';
    return NextResponse.json(
      {
        detail: isTimeout
          ? '動画の読み込みに時間がかかりすぎました。再試行してください。'
          : 'バックエンドに接続できません。しばらくしてから再試行してください。',
      },
      { status: 503 },
    );
  }
}
