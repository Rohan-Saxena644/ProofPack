import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'ProofPack — Evidence, not guesswork', description: 'Demonstrate your feature. Keep the proof. A local-first browser evidence workspace.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
