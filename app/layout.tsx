import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { Sidebar } from "./sidebar";

export const metadata: Metadata = {
  title: "Pixel Office",
  description: "Pixel Office Game",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body>
        <Providers>
          <div className="min-h-screen md:flex">
            <Sidebar />
            <main className="flex-1 overflow-auto pt-14 md:pt-0">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
