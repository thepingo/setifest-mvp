import { NextResponse } from "next/server";
import { cache } from "@/lib/cache";

export async function POST(request: Request) {
    if (process.env.NODE_ENV === "production") {
        return NextResponse.json({ error: "Forbidden in production" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const prefix = searchParams.get("prefix");

    if (!prefix) {
        return NextResponse.json({ error: "Missing prefix" }, { status: 400 });
    }

    const count = await cache.clearPrefix(prefix);

    return NextResponse.json({ ok: true, clearedCount: count });
}
