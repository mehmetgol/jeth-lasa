import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";

type SummaryRow = {
    id: string;
    createdAt: Date;
    source: string;
    title: string;
    summary: string;
    keywords: string;
    inputText: string | null;
};

export async function GET() {
    const authResult = await auth();
    const userId = authResult.userId;

    if (!userId) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const rows = (await prisma.summary.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: {
            id: true,
            createdAt: true,
            source: true,
            title: true,
            summary: true,
            keywords: true,
            inputText: true,
        },
    })) as SummaryRow[];

    return NextResponse.json({
        ok: true,
        data: rows.map((r: SummaryRow) => ({
            ...r,
            keywords: JSON.parse(r.keywords),
        })),
    });
}
