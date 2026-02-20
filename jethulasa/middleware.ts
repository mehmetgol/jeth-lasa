import { clerkMiddleware } from "@clerk/nextjs/server";

export default clerkMiddleware();

export const config = {
    matcher: [
        // Next.js internals ve statik dosyalar hariç her şey
        "/((?!_next|.*\\..*).*)",
        // API route'lar
        "/(api|trpc)(.*)",
    ],
};
