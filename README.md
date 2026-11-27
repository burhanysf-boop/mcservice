# Makassar Computindo · Sistem Servis

Aplikasi Next.js dengan Supabase Auth dan PostgreSQL untuk Maros dan Makassar.

## Supabase

1. Pada proyek Supabase baru untuk aplikasi ini, jalankan `supabase/001_servis.sql`, lalu `supabase/002_cabang.sql`, lalu `supabase/003_perbaikan.sql`, lalu `supabase/004_edit_batal_token.sql` via SQL Editor. Proyek yang sudah memakai 002 cukup menjalankan 003 dan 004 secara berurutan. Jika proyek sudah memiliki tabel atau migrasi, cocokkan skemanya terlebih dahulu. Migrasi kedua mempertahankan data skema awal dan menganggap staf awal sebagai pemilik serta tiket awal berasal dari Maros.
2. Di Authentication, tambahkan pengguna dengan email dan kata sandi, lalu salin UUID pengguna pemilik. Nonaktifkan pendaftaran mandiri untuk aplikasi internal.
3. Buat akses pemilik pertama via SQL Editor:

   ```sql
   insert into public.staff (user_id,role,branch)
   values ('UUID-PEMILIK','owner','MRS');
   ```

4. Isi alamat dan WhatsApp cabang Makassar pada tabel `branches`. Data Maros diambil dari contoh tanda terima dan dapat disesuaikan.
5. Tambahkan akun petugas lainnya di Authentication. Pemilik membuka **Akses petugas** untuk menetapkan peran dan cabang. Satu pengguna dapat memperoleh lebih dari satu peran.
6. Isi `.env.local` dari `.env.example` dengan Project URL dan Publishable Key. Kunci secret dan service role tidak diperlukan.

## Lokal dan Vercel

```sh
npm ci
npm run dev
```

Buka http://localhost:3000. Untuk Vercel, tempatkan isi folder pada root repositori atau pilih folder proyek sebagai Root Directory. Impor repositori GitHub pada Vercel, tambahkan dua variabel dari `.env.example`, lalu deploy. Uji QR memakai alamat deployment yang dapat dibuka dari perangkat pelanggan. Database menyimpan data lintas perangkat dan memeriksa izin pada setiap operasi.

## Alur uji

- Admin Maros membuat tiket dan memilih cabang pengambilan. Kasir Maros dapat mencatat DP. Admin mencetak tanda terima A4.
- Admin Maros mengirim barang ke Makassar. Admin Makassar mengonfirmasi penerimaan kemudian memilih teknisi Makassar.
- Teknisi memperbarui status dan tindakan pada tiket yang ditugaskan. Admin dapat mengirim kembali barang. Setelah barang tiba di lokasi pengambilan, petugas menandainya siap diambil.
- Kasir di cabang pengambilan mencatat pembayaran, menyerahkan barang setelah lunas, dan mencetak nota A4. Rekap kas menghitung transaksi per cabang penerima pembayaran.
- Admin cabang lokasi barang dapat mengubah data pelanggan selama barang belum dikirim antar-cabang atau diserahkan. Setiap perubahan tercatat di riwayat tiket.
- Admin cabang lokasi barang dapat membatalkan servis yang belum diserahkan. Pengembalian dana harus sama dengan uang yang sudah dibayar dan dicatat sebagai pengembalian dana. Tiket yang dibatalkan masuk antrean **Selesai**.
- Admin dapat mengganti tautan pelacakan. Tautan dan QR lama tidak lagi bisa dibuka, sehingga tanda terima perlu dicetak ulang.
- QR pelanggan dapat dibuka tanpa login dan hanya menampilkan nomor, perangkat, status, waktu pembaruan, lokasi pengambilan dan masa garansi. QR petugas membuka tiket sesuai hak akses setelah login.

## Cetak rangkap

Gunakan A4 portrait, skala 100%, tanpa header/footer browser. Untuk NCR 2 ply dan printer dot matrix yang sesuai, pilih **1 salinan**, lalu uji margin dan keterbacaan QR di kedua lapis. Pada printer inkjet/laser gunakan dua lembar terpisah dan pilih **2 salinan**. Jika ukuran continuous form berbeda dari A4, sesuaikan pengaturan driver dan format sebelum memakai kertas stok toko.
