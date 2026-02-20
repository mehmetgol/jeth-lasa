// src/app/api/history/route.ts
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET() {
    const { userId } = await auth(); // ✅ bazı sürümlerde Promise
    if (!userId) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

    const items = await prisma.summary.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            createdAt: true,
            source: true,
            title: true,
            summary: true,
            keywords: true,
            pdfName: true,
            imageCount: true,
        },
        take: 50,
    });

    return NextResponse.json({ ok: true, data: items });
}