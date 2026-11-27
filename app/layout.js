import './style.css';

export const metadata = {
  title: 'Servis | Makassar Computindo',
  referrer: 'no-referrer',
};

export default function Layout({ children }) {
  return <html lang="id"><body>{children}</body></html>;
}
