import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Drape — Virtual Fitting Room",
  description:
    "Try garments from online shops in a live, on-device fitting mirror and save your looks.",
  icons: { icon: "/favicon.svg" },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
