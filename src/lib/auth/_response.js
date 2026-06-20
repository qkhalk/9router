// Small JSON helpers for auth route handlers.
import { NextResponse } from "next/server";

export function jsonOk(body, init) {
  return NextResponse.json({ success: true, ...body }, init);
}

export function jsonError(error, status = 400, extra = {}) {
  return NextResponse.json({ error, ...extra }, { status });
}

export async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// Pads an object so accidental object spreads don't leak sensitive fields.
export function pick(obj, fields) {
  if (!obj) return obj;
  const out = {};
  for (const f of fields) if (f in obj) out[f] = obj[f];
  return out;
}
