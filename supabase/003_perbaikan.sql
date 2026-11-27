begin;

-- Akun petugas dapat dihapus dari Supabase Auth tanpa memblokir tiket dan riwayat.
-- Penugasan dan pengiriman dikosongkan; riwayat tetap dipertahankan lewat actor_email.
alter table public.tickets
 drop constraint tickets_assigned_fkey,
 add constraint tickets_assigned_fkey foreign key (assigned) references auth.users(id) on delete set null,
 drop constraint tickets_sent_by_fkey,
 add constraint tickets_sent_by_fkey foreign key (sent_by) references auth.users(id) on delete set null;

alter table public.service_events add column actor_email text not null default '';
update public.service_events e set actor_email = coalesce((select u.email::text from auth.users u where u.id = e.actor), '');
alter table public.service_events alter column actor drop not null;
alter table public.service_events
 drop constraint service_events_actor_fkey,
 add constraint service_events_actor_fkey foreign key (actor) references auth.users(id) on delete set null;

create function public.fill_event_actor() returns trigger language plpgsql security definer set search_path = pg_catalog as $$
begin
 new.actor_email := coalesce((select u.email::text from auth.users u where u.id = new.actor), '');
 return new;
end $$;
create trigger service_events_actor before insert on public.service_events for each row execute function public.fill_event_actor();
revoke all on function public.fill_event_actor() from public, anon, authenticated;

-- Riwayat status tidak lagi terkunci: ikuti aturan baca yang sama dengan service_events.
create policy read_history on public.ticket_history for select to authenticated
 using (exists(select 1 from public.tickets t where t.id = ticket_id));

commit;
