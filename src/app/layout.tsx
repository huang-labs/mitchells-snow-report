import type { Metadata, Viewport } from "next";
import { AppShell } from "@/components/AppShell";
import { SITE_TITLE as title, SITE_DESCRIPTION as description, siteOpenGraph, metadataBase } from "@/lib/metadata";
import "./globals.css";

// Every page inherits the static brand image; Daily Snow overrides it.
export const metadata: Metadata = {
  metadataBase,
  title: { default: title, template: `%s · ${title}` },
  description,
  robots: { index: false, follow: false },
  openGraph: {
    ...siteOpenGraph,
    images: [{ url: "/share-brand-v2.png", width: 1200, height: 630, alt: "Mitchell’s Snow Report — Western United States" }],
  },
  twitter: { card: "summary_large_image", title, images: ["/share-brand-v2.png"] },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8fafc" },
    { media: "(prefers-color-scheme: dark)", color: "#101c2a" },
  ],
};

// Apply the saved appearance before first paint so the theme never flashes.
const themeScript = `try{var t=localStorage.getItem("mitchells-snow-report.appearance");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
