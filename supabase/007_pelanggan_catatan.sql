begin;

-- Catatan per tiket, tercetak di nota.
alter table public.tickets add column notes text not null default '' check (length(notes) <= 300);

-- Pelanggan tetap. Kunci unik adalah nomor WhatsApp dalam bentuk angka saja.
create table public.customers (
 id uuid primary key default gen_random_uuid(),
 phone_key text not null unique check (length(phone_key) >= 8),
 phone text not null,
 name text not null check (length(trim(name)) between 1 and 100),
 updated_at timestamptz not null default now()
);
alter table public.tickets add column customer_id uuid references public.customers(id) on delete set null;
alter table public.customers enable row level security;
revoke all on public.customers from anon, authenticated;
grant select on public.customers to authenticated;
create policy staff_read_customers on public.customers for select to authenticated
 using (exists(select 1 from public.staff s where s.user_id = (select auth.uid())));

-- Data yang sudah ada: ambil pelanggan dari tiket terbaru untuk setiap nomor.
insert into public.customers(phone_key,phone,name)
select distinct on (k) k, phone, customer from (
 select regexp_replace(phone,'\D','','g') as k, phone, customer, created_at from public.tickets
) x where length(k) >= 8
order by k, created_at desc
on conflict (phone_key) do nothing;
update public.tickets t set customer_id = c.id
from public.customers c where c.phone_key = regexp_replace(t.phone,'\D','','g');

-- Setiap tiket baru atau perubahan nama/nomor menyinkronkan data pelanggan.
create function public.sync_customer() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare
 key text := regexp_replace(coalesce(new.phone,''),'\D','','g');
begin
 if length(key) < 8 then return new; end if;
 insert into public.customers(phone_key,phone,name) values(key,new.phone,new.customer)
 on conflict (phone_key) do update set name=excluded.name, phone=excluded.phone, updated_at=now()
 returning id into new.customer_id;
 return new;
end $$;
create trigger ticket_customer before insert or update of customer, phone on public.tickets
 for each row execute function public.sync_customer();

-- Catatan nota: admin cabang lokasi barang, selama tiket belum diantar atau dibatalkan.
create function public.set_ticket_notes(ticket_id uuid, notes text) returns void
language plpgsql security definer set search_path=pg_catalog as $$
declare
 t public.tickets%rowtype;
 clean text := trim(coalesce(notes,''));
begin
 if length(clean) > 300 then raise exception 'Catatan maksimal 300 karakter'; end if;
 select * into t from public.tickets where id=ticket_id;
 if not found or not public.can_read_service(t) then raise exception 'Tiket tidak tersedia'; end if;
 if not public.can_service('admin', t.location) or t.destination is not null or t.status in ('Sudah diambil','Dibatalkan') then
   raise exception 'Akses ditolak';
 end if;
 update public.tickets set notes=clean where id=t.id;
end $$;

revoke all on function public.sync_customer(), public.set_ticket_notes(uuid,text) from public, anon, authenticated;
grant execute on function public.set_ticket_notes(uuid,text) to authenticated;

commit;
