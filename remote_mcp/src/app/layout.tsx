import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Jay Job MCP",
  description: "Authenticated remote MCP persistence for job records",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
