import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Clip — YouTube切り抜きツール',
  description: 'AIがYouTube動画を分析して、バズる切り抜きを自動生成',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
