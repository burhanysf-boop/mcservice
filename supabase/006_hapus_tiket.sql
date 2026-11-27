begin;

-- Salinan tiket yang dihapus permanen. Hanya pemilik yang bisa membacanya lewat SQL.
create table public.ticket_deletions (
 id bigint generated always as identity primary key,
 ticket_number text not null,
 deleted_at timestamptz not null default now(),
 deleted_by uuid references auth.users(id) on delete set null,
 deleted_by_email text not null default '',
 reason text not null check (length(trim(reason)) between 1 and 200),
 snapshot jsonb not null
);
alter table public.ticket_deletions enable row level security;
revoke all on public.ticket_deletions from anon, authenticated;
grant select on public.ticket_deletions to authenticated;
create policy owner_reads_deletions on public.ticket_deletions for select to authenticated
 using (exists(select 1 from public.staff s where s.user_id = (select auth.uid()) and s.role = 'owner'));

-- Hanya pemilik. Riwayat dan event dihapus dulu karena terhubung ke tiket.
create function public.delete_ticket(ticket_id uuid, reason text) returns void
language plpgsql security definer set search_path=pg_catalog as $$
declare
 t public.tickets%rowtype;
 clean text := trim(coalesce(reason,''));
begin
 if auth.uid() is null or not exists(select 1 from public.staff s where s.user_id=auth.uid() and s.role='owner') then
   raise exception 'Akses ditolak';
 end if;
 if length(clean) < 1 or length(clean) > 200 then raise exception 'Alasan penghapusan wajib diisi (maksimal 200 karakter)'; end if;
 select * into t from public.tickets where id=ticket_id for update;
 if not found then raise exception 'Tiket tidak tersedia'; end if;

 insert into public.ticket_deletions(ticket_number,deleted_by,deleted_by_email,reason,snapshot)
 values (t.number, auth.uid(), coalesce((select u.email::text from auth.users u where u.id=auth.uid()),''), clean,
   jsonb_build_object(
     'ticket', to_jsonb(t),
     'events', coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from public.service_events e where e.ticket=t.id),'[]'::jsonb),
     'history', coalesce((select jsonb_agg(to_jsonb(h) order by h.id) from public.ticket_history h where h.ticket_id=t.id),'[]'::jsonb)));

 delete from public.service_events where ticket=t.id;
 delete from public.ticket_history h where h.ticket_id=t.id;
 delete from public.tickets where id=t.id;
end $$;

revoke all on function public.delete_ticket(uuid,text) from public, anon, authenticated;
grant execute on function public.delete_ticket(uuid,text) to authenticated;

commit;
