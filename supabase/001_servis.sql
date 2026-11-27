begin;
create sequence public.service_number;
create table public.staff (
 user_id uuid primary key references auth.users(id) on delete cascade
);
create table public.tickets (
 id uuid primary key default gen_random_uuid(),
 number text not null unique default ('MC-' || to_char(now() at time zone 'Asia/Makassar','YYYYMMDD') || '-' || nextval('public.service_number')),
 token uuid not null unique default gen_random_uuid(),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 picked_up_at timestamptz,
 customer text not null check (length(trim(customer)) between 1 and 100),
 phone text not null default '',
 device text not null check (length(trim(device)) between 1 and 120),
 serial text not null default '',
 accessories text not null default '',
 complaint text not null check (length(trim(complaint)) between 1 and 400),
 receiver text not null check (length(trim(receiver)) between 1 and 80),
 technician text not null default '',
 action_taken text not null default '',
 status text not null default 'Belum dicek' check (status in ('Belum dicek','Sedang dicek','Menunggu konfirmasi','Menunggu suku cadang','Sedang dikerjakan','Siap diambil','Sudah diambil')),
 estimate integer check (estimate >= 0),
 cost integer check (cost >= 0),
 deposit integer not null default 0 check (deposit >= 0),
 settlement integer not null default 0 check (settlement >= 0),
 method text not null default '',
 warranty integer not null default 0 check (warranty between 0 and 3650),
 handed_by text not null default '',
 picked_by text not null default '',
 check (cost is null or deposit::bigint + settlement <= cost),
 check (settlement = 0 or (cost is not null and length(trim(method)) > 0)),
 check (status <> 'Sudah diambil' or (cost is not null and deposit::bigint + settlement = cost and length(trim(handed_by)) > 0 and length(trim(picked_by)) > 0))
);
create table public.ticket_history (
 id bigint generated always as identity primary key,
 ticket_id uuid not null references public.tickets(id),
 status text not null,
 changed_at timestamptz not null default now(),
 changed_by uuid references auth.users(id) on delete set null
);
create index on public.ticket_history(ticket_id, changed_at desc, id desc);
alter table public.staff enable row level security;
alter table public.tickets enable row level security;
alter table public.ticket_history enable row level security;
revoke all on public.staff, public.tickets, public.ticket_history from anon, authenticated;
grant select on public.staff, public.tickets, public.ticket_history to authenticated;
grant usage on sequence public.service_number to authenticated;
grant insert (customer,phone,device,serial,accessories,complaint,receiver,technician,action_taken,status,estimate,cost,deposit,settlement,method,warranty,handed_by,picked_by) on public.tickets to authenticated;
grant update (customer,phone,device,serial,accessories,complaint,receiver,technician,action_taken,status,estimate,cost,deposit,settlement,method,warranty,handed_by,picked_by) on public.tickets to authenticated;
create policy own_staff on public.staff for select to authenticated using (user_id = (select auth.uid()));
create policy read_tickets on public.tickets for select to authenticated using (exists (select 1 from public.staff where user_id = (select auth.uid())));
create policy create_tickets on public.tickets for insert to authenticated with check (exists (select 1 from public.staff where user_id = (select auth.uid())));
create policy edit_tickets on public.tickets for update to authenticated using (exists (select 1 from public.staff where user_id = (select auth.uid()))) with check (exists (select 1 from public.staff where user_id = (select auth.uid())));
create policy read_history on public.ticket_history for select to authenticated using (exists (select 1 from public.staff where user_id = (select auth.uid())));
create function public.set_ticket_dates() returns trigger language plpgsql set search_path = pg_catalog as $$
begin
 new.updated_at := clock_timestamp();
 if new.status = 'Sudah diambil' then
   if tg_op = 'UPDATE' then new.picked_up_at := coalesce(old.picked_up_at, new.updated_at);
   else new.picked_up_at := new.updated_at; end if;
 else new.picked_up_at := null;
 end if;
 return new;
end $$;
create trigger ticket_dates before insert or update on public.tickets for each row execute function public.set_ticket_dates();
create function public.log_ticket_status() returns trigger language plpgsql security definer set search_path = pg_catalog as $$
begin
 if tg_op = 'INSERT' or old.status is distinct from new.status then
   insert into public.ticket_history(ticket_id,status,changed_by,changed_at)
   values(new.id,new.status,auth.uid(),new.updated_at);
 end if;
 return new;
end $$;
create trigger ticket_status after insert or update on public.tickets for each row execute function public.log_ticket_status();
revoke all on function public.set_ticket_dates(), public.log_ticket_status() from public, anon, authenticated;
create function public.track_service(code uuid)
returns table(number text, device text, status text, created_at timestamptz, updated_at timestamptz, warranty_until date)
language sql stable security definer set search_path = pg_catalog as $$
 select t.number,t.device,t.status,t.created_at,t.updated_at,
 case when t.warranty>0 then (t.picked_up_at at time zone 'Asia/Makassar')::date + t.warranty end
 from public.tickets t where t.token=code
$$;
revoke all on function public.track_service(uuid) from public, anon, authenticated;
grant execute on function public.track_service(uuid) to anon, authenticated;
commit;
