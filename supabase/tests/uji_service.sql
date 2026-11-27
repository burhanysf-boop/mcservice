-- Uji alur servis dan izin akses. Jalankan setelah 001–004 terpasang.
-- Seluruh data uji dibatalkan di akhir (rollback), jadi aman dijalankan di database yang sudah berisi data.
-- Contoh: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/uji_service.sql
-- Jika ada uji yang gagal, skrip berhenti dengan pesan "UJI GAGAL: ...".

begin;

-- Pengguna uji (hanya di dalam transaksi ini)
insert into auth.users(id,email) values
 ('10000000-0000-0000-0000-000000000001','uji-admin-mrs@uji'),
 ('10000000-0000-0000-0000-000000000002','uji-teknisi-mrs@uji'),
 ('10000000-0000-0000-0000-000000000003','uji-kasir-mrs@uji'),
 ('10000000-0000-0000-0000-000000000004','uji-admin-mks@uji'),
 ('10000000-0000-0000-0000-000000000005','uji-orang-luar@uji');
insert into public.profiles(user_id,display_name) values
 ('10000000-0000-0000-0000-000000000001','Admin MRS'),
 ('10000000-0000-0000-0000-000000000002','Teknisi MRS'),
 ('10000000-0000-0000-0000-000000000003','Kasir MRS'),
 ('10000000-0000-0000-0000-000000000004','Admin MKS');
insert into public.staff(user_id,role,branch) values
 ('10000000-0000-0000-0000-000000000001','admin','MRS'),
 ('10000000-0000-0000-0000-000000000002','technician','MRS'),
 ('10000000-0000-0000-0000-000000000003','cashier','MRS'),
 ('10000000-0000-0000-0000-000000000004','admin','MKS');

-- Pembantu: memastikan perintah gagal dengan pesan tertentu
create function pg_temp.harus_gagal(stmt text, pesan text) returns void language plpgsql as $$
declare
 gagal boolean := false;
 teks text;
begin
 begin
   execute stmt;
 exception when others then
   gagal := true;
   teks := sqlerrm;
 end;
 if not gagal then raise exception 'UJI GAGAL: diharapkan error "%", tetapi perintah berhasil', pesan; end if;
 if teks not like '%'||pesan||'%' then raise exception 'UJI GAGAL: diharapkan error "%", dapat "%"', pesan, teks; end if;
 raise notice 'LULUS: %', pesan;
end $$;

create function pg_temp.harus(kondisi boolean, keterangan text) returns void language plpgsql as $$
begin
 if not coalesce(kondisi,false) then raise exception 'UJI GAGAL: %', keterangan; end if;
 raise notice 'LULUS: %', keterangan;
end $$;

-- Helper: jalankan sebagai pengguna tertentu
create function pg_temp.sebagai(uid uuid) returns void language plpgsql as $$
begin
 perform set_config('request.jwt.claim.sub', uid::text, true);
 execute 'set local role authenticated';
end $$;

-- ===== Terima dan edit =====
select pg_temp.sebagai('10000000-0000-0000-0000-000000000001');
select public.service_command('create',null,'MRS','{"customer":"Budi","device":"Laptop","complaint":"Mati","receiver":"Ani","estimate":"100000"}',gen_random_uuid()) as t1 \gset
select pg_temp.harus(exists(select 1 from public.tickets where id=:'t1' and status='Belum dicek'), 'tiket baru dibuat dengan status Belum dicek');
select pg_temp.harus((select receiver from public.tickets where id=:'t1')='Admin MRS', 'petugas penerima diambil dari nama profil, bukan input klien');
select public.service_command('edit',:'t1','MRS','{"customer":"Budi Santoso","phone":"","device":"Laptop Asus","serial":"SN1","accessories":"Charger","complaint":"Mati total","receiver":"Ani"}',gen_random_uuid());
select pg_temp.harus((select customer='Budi Santoso' and device='Laptop Asus' from public.tickets where id=:'t1'), 'edit mengubah data pelanggan');
select pg_temp.harus_gagal($q$select public.service_command('edit','$q$||:'t1'||$q$','MRS','{"customer":"   "}',gen_random_uuid())$q$, 'violates check constraint');
select pg_temp.sebagai('10000000-0000-0000-0000-000000000004');
select pg_temp.harus_gagal($q$select public.service_command('edit','$q$||:'t1'||$q$','MKS','{"customer":"X"}',gen_random_uuid())$q$, 'Tiket tidak tersedia');
reset role;

-- ===== Pembayaran dan pembatalan =====
select pg_temp.sebagai('10000000-0000-0000-0000-000000000003');
select public.service_command('deposit',:'t1','MRS','{"amount":"30000","method":"Tunai"}',gen_random_uuid());
reset role;
select pg_temp.sebagai('10000000-0000-0000-0000-000000000001');
select pg_temp.harus_gagal($q$select public.service_command('cancel','$q$||:'t1'||$q$','MRS','{"reason":"Batal","refund":"10000","method":"Tunai"}',gen_random_uuid())$q$, 'Pengembalian dana harus sama');
select pg_temp.harus_gagal($q$select public.service_command('cancel','$q$||:'t1'||$q$','MRS','{"reason":"Batal","refund":"30000"}',gen_random_uuid())$q$, 'Metode pengembalian dana wajib diisi');
select gen_random_uuid() as op \gset
select public.service_command('cancel',:'t1','MRS','{"reason":"Pelanggan batal","refund":"30000","method":"Tunai"}',:'op') as cop \gset
select pg_temp.harus((select status='Dibatalkan' and refund=30000 from public.tickets where id=:'t1'), 'pembatalan menutup tiket dan mencatat pengembalian');
select pg_temp.harus(exists(select 1 from public.service_events where ticket=:'t1' and event='refund' and amount=30000), 'pengembalian dana tercatat sebagai kejadian');
select pg_temp.harus(public.service_command('cancel',:'t1','MRS','{"reason":"Pelanggan batal","refund":"30000","method":"Tunai"}',:'op') = :'t1'::uuid, 'ulangi pembatalan dengan operation id yang sama tidak error');
select pg_temp.harus((select count(*) from public.service_events where ticket=:'t1' and event='refund')=1, 'ulangi pembatalan tidak menggandakan pengembalian');
select pg_temp.harus_gagal($q$select public.service_command('edit','$q$||:'t1'||$q$','MRS','{"customer":"Z"}',gen_random_uuid())$q$, 'Servis sudah dibatalkan');
select pg_temp.harus_gagal($q$select public.service_command('token','$q$||:'t1'||$q$','MRS','{}',gen_random_uuid())$q$, 'Servis sudah dibatalkan');
reset role;

-- ===== Teknisi tidak boleh membatalkan atau mengubah data =====
select pg_temp.sebagai('10000000-0000-0000-0000-000000000001');
select public.service_command('create',null,'MRS','{"customer":"Cici","device":"HP","complaint":"Layar","receiver":"Ani"}',gen_random_uuid()) as t2 \gset
select public.service_command('assign',:'t2','MRS','{"technician":"10000000-0000-0000-0000-000000000002","name":"uji-teknisi-mrs@uji"}',gen_random_uuid());
select pg_temp.harus((select technician='Teknisi MRS' from public.tickets where id=:'t2'), 'nama teknisi diambil dari nama tampilan, bukan email');
reset role;
-- Teknisi tanpa nama tampilan tidak boleh ditugaskan
insert into auth.users(id,email) values ('10000000-0000-0000-0000-000000000006','uji-tanpa-nama@uji');
insert into public.staff(user_id,role,branch) values ('10000000-0000-0000-0000-000000000006','technician','MRS');
select pg_temp.sebagai('10000000-0000-0000-0000-000000000001');
select pg_temp.harus_gagal($q$select public.service_command('assign','$q$||:'t2'||$q$','MRS','{"technician":"10000000-0000-0000-0000-000000000006"}',gen_random_uuid())$q$, 'Nama teknisi belum diatur');
-- Pengguna tanpa nama tampilan tidak bisa membuat tiket
reset role;
insert into auth.users(id,email) values ('10000000-0000-0000-0000-000000000007','uji-tanpa-nama-admin@uji');
insert into public.staff(user_id,role,branch) values ('10000000-0000-0000-0000-000000000007','admin','MRS');
select pg_temp.sebagai('10000000-0000-0000-0000-000000000007');
select pg_temp.harus_gagal($q$select public.service_command('create',null,'MRS','{"customer":"Eka","device":"PC","complaint":"Lambat","receiver":"Bebas"}',gen_random_uuid())$q$, 'Nama petugas belum diatur');
reset role;
-- Nama hanya bisa diatur pemilik atau pengguna itu sendiri
select pg_temp.sebagai('10000000-0000-0000-0000-000000000002');
select pg_temp.harus_gagal($q$select public.set_display_name('10000000-0000-0000-0000-000000000003','Curang')$q$, 'Akses ditolak');
select public.set_display_name('10000000-0000-0000-0000-000000000002','Teknisi MRS Baru');
reset role;
select pg_temp.harus((select display_name from public.profiles where user_id='10000000-0000-0000-0000-000000000002')='Teknisi MRS Baru', 'pengguna dapat mengubah namanya sendiri');
reset role;
select pg_temp.sebagai('10000000-0000-0000-0000-000000000002');
select pg_temp.harus_gagal($q$select public.service_command('cancel','$q$||:'t2'||$q$','MRS','{"reason":"Coba","refund":"0"}',gen_random_uuid())$q$, 'Akses ditolak');
select pg_temp.harus_gagal($q$select public.service_command('edit','$q$||:'t2'||$q$','MRS','{"customer":"Coba"}',gen_random_uuid())$q$, 'Akses ditolak');
reset role;

-- ===== Tautan pelacakan =====
select pg_temp.sebagai('10000000-0000-0000-0000-000000000001');
select token as tok_lama from public.tickets where id=:'t2' \gset
select public.service_command('token',:'t2','MRS','{}',gen_random_uuid());
reset role;
select pg_temp.harus((select count(*) from public.track_service(:'tok_lama'::uuid))=0, 'tautan pelacakan lama tidak bisa dibuka');
select pg_temp.harus((select token from public.tickets where id=:'t2')<>:'tok_lama'::uuid, 'token diganti');

-- ===== Akses orang luar dan riwayat status =====
select pg_temp.sebagai('10000000-0000-0000-0000-000000000005');
select pg_temp.harus((select count(*) from public.tickets)=0, 'orang luar tidak bisa membaca tiket');
select pg_temp.harus((select count(*) from public.ticket_history)=0, 'orang luar tidak bisa membaca riwayat status');
reset role;
select pg_temp.sebagai('10000000-0000-0000-0000-000000000003');
select pg_temp.harus((select count(*) from public.ticket_history where ticket_id=:'t2')>0, 'kasir MRS bisa membaca riwayat status tiket MRS');
reset role;

-- ===== Penghapusan akun =====
delete from auth.users where id='10000000-0000-0000-0000-000000000002';
select pg_temp.harus((select assigned is null from public.tickets where id=:'t2'), 'menghapus teknisi mengosongkan penugasan');
select pg_temp.harus(exists(select 1 from public.service_events where ticket=:'t2' and actor_email='uji-admin-mrs@uji'), 'jejak audit tetap menyimpan email pelaku');

-- ===== Hapus tiket (hanya pemilik) =====
reset role;
select pg_temp.sebagai('10000000-0000-0000-0000-000000000001');
select public.service_command('create',null,'MRS','{"customer":"Dodi","device":"TV","complaint":"Mati","receiver":"Abaikan"}',gen_random_uuid()) as t4 \gset
reset role;
select number as num_t4 from public.tickets where id=:'t4' \gset
insert into public.staff(user_id,role,branch) values ('10000000-0000-0000-0000-000000000004','owner','MKS');
select pg_temp.sebagai('10000000-0000-0000-0000-000000000001');
select pg_temp.harus_gagal($q$select public.delete_ticket('$q$||:'t4'||$q$','Coba')$q$, 'Akses ditolak');
reset role;
select pg_temp.sebagai('10000000-0000-0000-0000-000000000004');
select pg_temp.harus_gagal($q$select public.delete_ticket('$q$||:'t4'||$q$','   ')$q$, 'Alasan penghapusan wajib diisi');
select public.delete_ticket(:'t4','Salah input');
reset role;
select pg_temp.harus(not exists(select 1 from public.tickets where id=:'t4'), 'tiket dihapus dari database');
select pg_temp.harus(not exists(select 1 from public.service_events where ticket=:'t4'), 'riwayat layanan ikut dihapus');
select pg_temp.harus(not exists(select 1 from public.ticket_history where ticket_id=:'t4'), 'riwayat status ikut dihapus');
select pg_temp.harus(exists(select 1 from public.ticket_deletions where ticket_number=:'num_t4' and jsonb_array_length(snapshot->'events')>=1), 'salinan tiket tersimpan di ticket_deletions');

-- ===== Pelanggan tetap dan catatan =====
select pg_temp.sebagai('10000000-0000-0000-0000-000000000001');
select public.service_command('create',null,'MRS','{"customer":"Rina","phone":"0811-1111-1111","device":"HP","complaint":"Layar","receiver":"x"}',gen_random_uuid()) as t5 \gset
select public.service_command('create',null,'MRS','{"customer":"Rina S","phone":"081111111111","device":"Tablet","complaint":"Baterai","receiver":"x"}',gen_random_uuid()) as t6 \gset
reset role;
select pg_temp.harus((select count(*) from public.customers where phone_key='081111111111')=1, 'nomor yang sama hanya tersimpan sekali sebagai pelanggan tetap');
select pg_temp.harus((select name='Rina S' from public.customers where phone_key='081111111111'), 'nama pelanggan tetap ikut diperbarui dari tiket terbaru');
select pg_temp.harus((select customer_id from public.tickets where id=:'t5')=(select customer_id from public.tickets where id=:'t6'), 'kedua tiket menunjuk pelanggan yang sama');
select pg_temp.sebagai('10000000-0000-0000-0000-000000000001');
select public.set_ticket_notes(:'t5','Cek ulang setelah 3 hari');
select pg_temp.harus((select notes='Cek ulang setelah 3 hari' from public.tickets where id=:'t5'), 'admin dapat menyimpan catatan nota');
select pg_temp.harus_gagal($q$select public.set_ticket_notes('$q$||:'t5'||$q$','$q$||repeat('a',301)||$q$')$q$, 'Catatan maksimal 300 karakter');
reset role;
select pg_temp.sebagai('10000000-0000-0000-0000-000000000005');
select pg_temp.harus_gagal($q$select public.set_ticket_notes('$q$||:'t5'||$q$','Coba')$q$, 'Tiket tidak tersedia');
reset role;

rollback;
\echo SEMUA UJI LULUS (data uji dibatalkan)
