import type { Metadata } from "next";
import { ClerkProvider, SignedIn, SignedOut, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
    variable: "--font-geist-sans",
    subsets: ["latin"],
});

const geistMono = Geist_Mono({
    variable: "--font-geist-mono",
    subsets: ["latin"],
});

export const metadata: Metadata = {
    title: "Jethülasa",
    description: "AI summarizer",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <ClerkProvider>
            <html lang="tr">
            <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
            <header className="topbar">
                <div className="topbarRight">
                    <SignedOut>
                        <SignInButton>
                            <button className="topBtn">Giriş</button>
                        </SignInButton>

                        <SignUpButton>
                            <button className="topBtn topBtnPrimary">Kayıt Ol</button>
                        </SignUpButton>
                    </SignedOut>

                    <SignedIn>
                        <UserButton />
                    </SignedIn>
                </div>
            </header>

            {children}
            </body>
            </html>
        </ClerkProvider>
    );
}
