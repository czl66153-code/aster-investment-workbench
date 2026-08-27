import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import "./preopen.css";
import "./rank.css";
import "./apple.css";

export async function generateMetadata(): Promise<Metadata> {
  const incoming = await headers();
  const host = incoming.get("x-forwarded-host") || incoming.get("host") || "localhost:3100";
  const protocol = incoming.get("x-forwarded-proto") || (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  const image = `${protocol}://${host}/og.png`;
  const title = "Aster 独立投研工作台";
  const description = "板块与个股多周期涨幅排行、量化信号和本地证据分析的一体化A股研究工作台。";
  return {
    title, description,
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: { title, description, images: [{ url: image, width: 1680, height: 945, alt: "板块与个股多周期涨幅排行" }] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
