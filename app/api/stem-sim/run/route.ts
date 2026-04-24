import { NextResponse } from 'next/server'

const STEM_CPP_URL = process.env.STEM_CPP_URL || 'http://127.0.0.1:5173'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const res = await fetch(`${STEM_CPP_URL}/api/skills/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    })

    const text = await res.text()
    let data: unknown = null

    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = { raw: text }
    }

    return NextResponse.json(
      {
        ok: res.ok,
        upstreamStatus: res.status,
        ...(typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : { data }),
      },
      { status: res.ok ? 200 : res.status },
    )
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
