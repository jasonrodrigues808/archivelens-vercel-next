import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ArchiveLens Vercel",
  description: "Duplicate-aware article recovery, AI verification, and export on Next.js/Vercel."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
