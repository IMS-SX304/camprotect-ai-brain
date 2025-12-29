import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "CamProtect AI Brain",
  description: "Backend IA CamProtect (Webflow Cloud)"
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}

