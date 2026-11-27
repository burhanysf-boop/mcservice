import { Suspense } from 'react';
import Service from './service';

export default function Page() {
  return <Suspense fallback={<main>Memuat aplikasi…</main>}><Service /></Suspense>;
}
