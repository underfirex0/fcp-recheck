import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "FCP — Recheck CA & Export",
  description: "Vérification du chiffre d'affaires et de la part export des membres FCP"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
